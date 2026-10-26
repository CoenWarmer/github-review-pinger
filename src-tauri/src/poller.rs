//! Background polling. The poller owns the latest snapshot, pushes it to the
//! popover as a `snapshot` event, and keeps the tray count in sync.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use crate::auth::{self, AuthError, TokenSource};
use crate::github::{self, FetchError};
use crate::prs::{self, Group, PrView};
use crate::settings;

const POLL_INTERVAL: Duration = Duration::from_secs(120);
const STALE_AFTER: chrono::Duration = chrono::Duration::seconds(30);
const MAX_BACKOFF: Duration = Duration::from_secs(600);
pub const TRAY_ID: &str = "tray";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub status: Status,
    pub refreshing: bool,
    pub viewer: Option<String>,
    pub token_source: Option<TokenSource>,
    /// Wall-clock time, so staleness survives the machine sleeping.
    pub fetched_at: Option<DateTime<Utc>>,
    pub sso_partial: bool,
    pub pull_requests: Vec<PrView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Status {
    Loading,
    Ok,
    Error { problem: Problem },
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Problem {
    GhNotInstalled,
    GhNotLoggedIn,
    TokenRejected { source: TokenSource },
    RateLimited { reset_at: Option<DateTime<Utc>> },
    Network { message: String },
    Api { message: String },
}

pub struct Poller {
    snapshot: Mutex<Snapshot>,
    wake: Notify,
    http: reqwest::Client,
}

impl Poller {
    pub fn snapshot(&self) -> Snapshot {
        self.snapshot.lock().unwrap().clone()
    }

    pub fn refresh(&self) {
        self.wake.notify_one();
    }

    pub fn refresh_if_stale(&self) {
        let snapshot = self.snapshot.lock().unwrap();
        let stale = snapshot
            .fetched_at
            .is_none_or(|at| Utc::now() - at > STALE_AFTER);
        if stale && !snapshot.refreshing {
            self.wake.notify_one();
        }
    }

    fn update(&self, app: &AppHandle, change: impl FnOnce(&mut Snapshot)) {
        let snapshot = {
            let mut snapshot = self.snapshot.lock().unwrap();
            change(&mut snapshot);
            snapshot.clone()
        };
        update_tray(app, &snapshot);
        if let Err(e) = app.emit("snapshot", &snapshot) {
            log::warn!("Could not emit snapshot: {e}");
        }
    }
}

pub fn start(app: &AppHandle) -> Arc<Poller> {
    let poller = Arc::new(Poller {
        snapshot: Mutex::new(Snapshot {
            status: Status::Loading,
            refreshing: false,
            viewer: None,
            token_source: None,
            fetched_at: None,
            sso_partial: false,
            pull_requests: Vec::new(),
        }),
        wake: Notify::new(),
        http: github::http_client(),
    });
    tauri::async_runtime::spawn(run(app.clone(), poller.clone()));
    poller
}

async fn run(app: AppHandle, poller: Arc<Poller>) {
    let mut consecutive_failures = 0;
    loop {
        let delay = match poll_once(&app, &poller).await {
            Ok(()) => {
                consecutive_failures = 0;
                POLL_INTERVAL
            }
            Err(Problem::RateLimited { reset_at }) => reset_at
                .and_then(|at| (at - Utc::now()).to_std().ok())
                .unwrap_or(POLL_INTERVAL)
                .max(Duration::from_secs(60)),
            Err(Problem::Network { .. } | Problem::Api { .. }) => {
                consecutive_failures += 1;
                backoff(consecutive_failures)
            }
            // The user has to act (log in, paste a token); keep checking at the normal pace.
            Err(_) => POLL_INTERVAL,
        };

        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = poller.wake.notified() => {}
        }
    }
}

fn backoff(failures: u32) -> Duration {
    let seconds = 30u64.saturating_mul(1 << failures.min(5));
    Duration::from_secs(seconds).min(MAX_BACKOFF)
}

async fn poll_once(app: &AppHandle, poller: &Poller) -> Result<(), Problem> {
    poller.update(app, |s| s.refreshing = true);

    let result = fetch(app, poller).await;
    poller.update(app, |s| {
        s.refreshing = false;
        match &result {
            Ok(fetched) => {
                s.status = Status::Ok;
                s.viewer = Some(fetched.viewer.clone());
                s.token_source = Some(fetched.token_source);
                s.fetched_at = Some(Utc::now());
                s.sso_partial = fetched.sso_partial;
                s.pull_requests = fetched.pull_requests.clone();
            }
            // Keep showing the last good data alongside the problem.
            Err(problem) => {
                log::warn!("Refresh failed: {problem:?}");
                s.status = Status::Error {
                    problem: problem.clone(),
                };
            }
        }
    });
    result.map(|_| ())
}

struct Fetched {
    viewer: String,
    token_source: TokenSource,
    sso_partial: bool,
    pull_requests: Vec<PrView>,
}

async fn fetch(app: &AppHandle, poller: &Poller) -> Result<Fetched, Problem> {
    let token = tauri::async_runtime::spawn_blocking(auth::resolve_token)
        .await
        .map_err(|e| Problem::Api {
            message: e.to_string(),
        })?
        .map_err(|e| match e {
            AuthError::GhNotInstalled => Problem::GhNotInstalled,
            AuthError::GhNotLoggedIn => Problem::GhNotLoggedIn,
        })?;

    let fetched = github::fetch_open_pull_requests(&poller.http, &token.value)
        .await
        .map_err(|e| match e {
            FetchError::Unauthorized => Problem::TokenRejected {
                source: token.source,
            },
            FetchError::RateLimited { reset_at } => Problem::RateLimited { reset_at },
            FetchError::Network(message) => Problem::Network { message },
            FetchError::Api(message) => Problem::Api { message },
        })?;

    let settings = settings::load(app);
    let rules = prs::Rules {
        ignored_logins: &settings.ignored_logins,
        dormant_after: chrono::Duration::days(settings.dormant_after_days.into()),
    };
    Ok(Fetched {
        pull_requests: prs::derive(fetched.pull_requests, &fetched.viewer, &rules, Utc::now()),
        viewer: fetched.viewer,
        token_source: token.source,
        sso_partial: fetched.sso_partial,
    })
}

fn update_tray(app: &AppHandle, snapshot: &Snapshot) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let needs_action = snapshot
        .pull_requests
        .iter()
        .filter(|pr| pr.group == Group::NeedsAction)
        .count();
    let failed_without_data =
        matches!(snapshot.status, Status::Error { .. }) && snapshot.fetched_at.is_none();

    // Titles show next to the icon on macOS and Linux; Windows only has the tooltip.
    let (title, tooltip) = if failed_without_data {
        (
            Some("!".to_string()),
            "Review Pinger: needs setup".to_string(),
        )
    } else if needs_action == 0 {
        (None, "Review Pinger: nothing needs your action".to_string())
    } else {
        let noun = if needs_action == 1 {
            "PR needs"
        } else {
            "PRs need"
        };
        (
            Some(needs_action.to_string()),
            format!("Review Pinger: {needs_action} {noun} your action"),
        )
    };
    let _ = tray.set_title(title);
    let _ = tray.set_tooltip(Some(tooltip));
}
