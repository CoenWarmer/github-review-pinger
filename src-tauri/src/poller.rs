//! Background polling. The poller owns the latest snapshot, pushes it to the
//! popover as a `snapshot` event, keeps the tray count in sync, and sends
//! notifications for what changed between polls.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Local, NaiveDate, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Notify;

use crate::auth::{self, AuthError, TokenSource};
use crate::github::types::PullRequest;
use crate::github::{self, FetchError};
use crate::memory::Memory;
use crate::notify;
use crate::prs::{self, PrView};
use crate::reviews::{self, ReviewView};
use crate::settings::{self, Settings};

const POLL_INTERVAL: Duration = Duration::from_secs(120);
const STALE_AFTER: chrono::Duration = chrono::Duration::seconds(30);
const MAX_BACKOFF: Duration = Duration::from_secs(600);
/// A gap this long between polls means the machine slept or was offline, so
/// whatever happened meanwhile is summarized rather than replayed.
const COLD_START_GAP: chrono::Duration = chrono::Duration::minutes(15);
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
    pub review_requests: Vec<ReviewView>,
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
    /// The last successful fetch, kept so snoozes and settings can be
    /// re-applied without another round trip.
    latest: Mutex<Option<Fetched>>,
    memory: Mutex<Memory>,
    memory_path: Option<PathBuf>,
    first_poll: AtomicBool,
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

    pub fn set_snooze(&self, app: &AppHandle, id: &str, until: Option<DateTime<Utc>>) {
        {
            let mut memory = self.memory.lock().unwrap();
            memory.set_snooze(id, until, Utc::now());
            self.save(&memory);
        }
        let latest = self.latest.lock().unwrap();
        if let Some(fetched) = latest.as_ref() {
            let (views, review_views) = self.derive(app, fetched, Utc::now());
            self.update(app, |s| {
                s.pull_requests = views;
                s.review_requests = review_views;
            });
        }
    }

    /// Returns true exactly once per install, so autostart can default to on
    /// without overriding a later opt-out.
    pub fn claim_first_launch(&self) -> bool {
        let mut memory = self.memory.lock().unwrap();
        if memory.autostart_initialized {
            return false;
        }
        memory.autostart_initialized = true;
        self.save(&memory);
        true
    }

    fn derive(
        &self,
        app: &AppHandle,
        fetched: &Fetched,
        now: DateTime<Utc>,
    ) -> (Vec<PrView>, Vec<ReviewView>) {
        let settings = settings::load(app);
        let snoozed = self.memory.lock().unwrap().snoozes();
        let rules = prs::Rules {
            ignored_logins: &settings.ignored_logins,
            dormant_after: dormant_after(&settings),
            snoozed: &snoozed,
        };
        (
            prs::derive(&fetched.pull_requests, &fetched.viewer, &rules, now),
            reviews::derive(&fetched.review_pull_requests, &fetched.viewer, &rules, now),
        )
    }

    fn save(&self, memory: &Memory) {
        let Some(path) = &self.memory_path else {
            return;
        };
        if let Err(e) = memory.save(path) {
            log::warn!("Could not save {}: {e}", path.display());
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
    let memory_path = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("state.json"));
    let memory = memory_path.as_deref().map(Memory::load).unwrap_or_default();

    let poller = Arc::new(Poller {
        snapshot: Mutex::new(Snapshot {
            status: Status::Loading,
            refreshing: false,
            viewer: None,
            token_source: None,
            fetched_at: None,
            sso_partial: false,
            pull_requests: Vec::new(),
            review_requests: Vec::new(),
        }),
        latest: Mutex::new(None),
        memory: Mutex::new(memory),
        memory_path,
        first_poll: AtomicBool::new(true),
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

    let settings = settings::load(app);
    let reviewed_since = (Utc::now() - dormant_after(&settings)).date_naive();
    let fetched = match fetch(poller, reviewed_since).await {
        Ok(fetched) => fetched,
        Err(problem) => {
            // Keep showing the last good data alongside the problem.
            log::warn!("Refresh failed: {problem:?}");
            poller.update(app, |s| {
                s.refreshing = false;
                s.status = Status::Error {
                    problem: problem.clone(),
                };
            });
            return Err(problem);
        }
    };

    let now = Utc::now();
    let (views, review_views) = poller.derive(app, &fetched, now);
    let notifications = {
        let mut memory = poller.memory.lock().unwrap();
        let first_ever = memory.last_poll_at.is_none();
        let cold_start = poller.first_poll.swap(false, Ordering::Relaxed)
            || memory
                .last_poll_at
                .is_some_and(|at| now - at > COLD_START_GAP);
        let nudge_after = chrono::Duration::hours(settings.nudge_after_hours.into());
        let review_nudge_after = chrono::Duration::hours(settings.review_nudge_after_hours.into());

        let events = notify::diff(
            &views,
            &review_views,
            &mut memory,
            now,
            nudge_after,
            review_nudge_after,
            &Local,
        );
        poller.save(&memory);
        // Right after install everything is new; the list itself says what's pending.
        if first_ever {
            Vec::new()
        } else {
            notify::compose(&events, cold_start)
        }
    };
    for notification in notifications {
        let shown = app
            .notification()
            .builder()
            .title(&notification.title)
            .body(&notification.body)
            .show();
        if let Err(e) = shown {
            log::warn!("Could not show notification: {e}");
        }
    }

    poller.update(app, |s| {
        s.refreshing = false;
        s.status = Status::Ok;
        s.viewer = Some(fetched.viewer.clone());
        s.token_source = Some(fetched.token_source);
        s.fetched_at = Some(now);
        s.sso_partial = fetched.sso_partial;
        s.pull_requests = views;
        s.review_requests = review_views;
    });
    *poller.latest.lock().unwrap() = Some(fetched);
    Ok(())
}

struct Fetched {
    viewer: String,
    token_source: TokenSource,
    sso_partial: bool,
    pull_requests: Vec<PullRequest>,
    review_pull_requests: Vec<PullRequest>,
}

fn dormant_after(settings: &Settings) -> chrono::Duration {
    chrono::Duration::days(settings.dormant_after_days.into())
}

async fn fetch(poller: &Poller, reviewed_since: NaiveDate) -> Result<Fetched, Problem> {
    let token = tauri::async_runtime::spawn_blocking(auth::resolve_token)
        .await
        .map_err(|e| Problem::Api {
            message: e.to_string(),
        })?
        .map_err(|e| match e {
            AuthError::GhNotInstalled => Problem::GhNotInstalled,
            AuthError::GhNotLoggedIn => Problem::GhNotLoggedIn,
        })?;

    let fetched = github::fetch_open_pull_requests(&poller.http, &token.value, reviewed_since)
        .await
        .map_err(|e| match e {
            FetchError::Unauthorized => Problem::TokenRejected {
                source: token.source,
            },
            FetchError::RateLimited { reset_at } => Problem::RateLimited { reset_at },
            FetchError::Network(message) => Problem::Network { message },
            FetchError::Api(message) => Problem::Api { message },
        })?;

    Ok(Fetched {
        viewer: fetched.viewer,
        token_source: token.source,
        sso_partial: fetched.sso_partial,
        pull_requests: fetched.pull_requests,
        review_pull_requests: fetched.review_pull_requests,
    })
}

fn update_tray(app: &AppHandle, snapshot: &Snapshot) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let needs_action = snapshot
        .pull_requests
        .iter()
        .filter(|pr| pr.needs_author())
        .count();
    let needs_review = snapshot
        .review_requests
        .iter()
        .filter(|pr| pr.needs_review())
        .count();
    let failed_without_data =
        matches!(snapshot.status, Status::Error { .. }) && snapshot.fetched_at.is_none();

    let (title, tooltip) = tray_text(failed_without_data, needs_action, needs_review);
    let _ = tray.set_title(title);
    let _ = tray.set_tooltip(Some(tooltip));
}

/// The title shows next to the icon on macOS and Linux; Windows only has the
/// tooltip. Both numbers show whenever either is nonzero, so the position is
/// what tells them apart.
fn tray_text(
    failed_without_data: bool,
    needs_action: usize,
    needs_review: usize,
) -> (Option<String>, String) {
    if failed_without_data {
        return (
            Some("!".to_string()),
            "Review Pinger: needs setup".to_string(),
        );
    }
    if needs_action == 0 && needs_review == 0 {
        return (None, "Review Pinger: nothing needs your action".to_string());
    }
    let prs = if needs_action == 1 {
        "1 PR needs"
    } else {
        &format!("{needs_action} PRs need")
    };
    let reviews = if needs_review == 1 {
        "1 review is".to_string()
    } else {
        format!("{needs_review} reviews are")
    };
    (
        Some(format!("{needs_action} · {needs_review}")),
        format!("Review Pinger: {prs} your action, {reviews} waiting on you"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tray_shows_both_numbers() {
        assert_eq!(tray_text(false, 3, 0).0.as_deref(), Some("3 · 0"));
        assert_eq!(tray_text(false, 0, 2).0.as_deref(), Some("0 · 2"));
        assert_eq!(tray_text(false, 0, 0).0, None);
        assert_eq!(tray_text(true, 0, 0).0.as_deref(), Some("!"));
    }

    #[test]
    fn the_tooltip_spells_both_out() {
        assert_eq!(
            tray_text(false, 3, 1).1,
            "Review Pinger: 3 PRs need your action, 1 review is waiting on you"
        );
        assert_eq!(
            tray_text(false, 1, 2).1,
            "Review Pinger: 1 PR needs your action, 2 reviews are waiting on you"
        );
    }
}
