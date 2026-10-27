//! Background polling. The poller owns the latest snapshot, pushes it to the
//! popover as a `snapshot` event, keeps the tray count in sync, and sends
//! notifications for what changed between polls.

use std::collections::{HashMap, HashSet};
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
use crate::checks;
use crate::github::types::{PullRequest, RequestedReviewer};
use crate::github::{self, FetchError};
use crate::memory::Memory;
use crate::notify;
use crate::prs::{self, PrView};
use crate::reviews::{self, ReviewView};
use crate::settings::{self, Settings, SlackOpensIn};
use crate::slack;

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
    /// Slack channel links by lowercase `org/team-slug`, from settings and
    /// those saved in the popover.
    pub team_channels: HashMap<String, String>,
    pub slack_opens_in: SlackOpensIn,
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
    /// Pull requests the user opened on GitHub since the popover last
    /// showed; refreshed first when it next opens. Not persisted.
    visited: Mutex<HashSet<String>>,
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
        self.rederive(app);
    }

    /// Saves the Slack channel for a team. Fails when the link isn't a
    /// Slack link.
    pub fn set_team_channel(&self, app: &AppHandle, team: &str, link: &str) -> Result<(), String> {
        if !slack::is_valid_link(link) {
            return Err("That doesn't look like a Slack channel link.".to_string());
        }
        let channels = {
            let mut memory = self.memory.lock().unwrap();
            memory
                .team_channels
                .insert(team.to_lowercase(), link.to_string());
            self.save(&memory);
            self.channels(&settings::load(app), &memory)
        };
        self.update(app, |s| s.team_channels = channels);
        Ok(())
    }

    fn channels(&self, settings: &Settings, memory: &Memory) -> HashMap<String, String> {
        slack::merged_channels(&memory.team_channels, &settings.team_channels)
    }

    /// Remembers that the user opened this PR on GitHub, so it's refreshed
    /// first the next time the popover shows.
    pub fn visit(&self, id: &str) {
        self.visited.lock().unwrap().insert(id.to_string());
    }

    /// Updates the snapshot from the last fetch, after snoozes or a single
    /// PR changed.
    fn rederive(&self, app: &AppHandle) {
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
        let (snoozed, estimates) = {
            let memory = self.memory.lock().unwrap();
            (
                memory.snoozes(),
                checks::estimates(&memory, &settings.check_durations),
            )
        };
        let rules = prs::Rules {
            ignored_logins: &settings.ignored_logins,
            dormant_after: dormant_after(&settings),
            snoozed: &snoozed,
        };
        let mut views = prs::derive(&fetched.pull_requests, &fetched.viewer, &rules, now);
        for view in &mut views {
            view.checks_estimate_secs = estimates.get(&view.repo).copied();
        }
        (
            views,
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
            team_channels: HashMap::new(),
            slack_opens_in: SlackOpensIn::default(),
        }),
        latest: Mutex::new(None),
        memory: Mutex::new(memory),
        memory_path,
        visited: Mutex::new(HashSet::new()),
        first_poll: AtomicBool::new(true),
        wake: Notify::new(),
        http: github::http_client(),
    });
    tauri::async_runtime::spawn(run(app.clone(), poller.clone()));
    poller
}

/// Called when the popover opens. PRs the user visited on GitHub since last
/// time are refreshed alone first, so what they changed shows up quickly,
/// and then the whole list is refreshed if it's stale.
pub fn on_popover_open(app: &AppHandle, poller: Arc<Poller>) {
    let visited: Vec<String> = poller.visited.lock().unwrap().drain().collect();
    if visited.is_empty() {
        poller.refresh_if_stale();
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        refresh_visited(&app, &poller, visited).await;
        poller.refresh_if_stale();
    });
}

/// Refetches just `ids` and patches them into the last fetch. Notifications
/// are left to the full poll that follows, which compares against memory this
/// leaves untouched. Failures are only logged, since the full refresh reports
/// problems.
async fn refresh_visited(app: &AppHandle, poller: &Poller, ids: Vec<String>) {
    let Ok(Ok(token)) = tauri::async_runtime::spawn_blocking(auth::resolve_token).await else {
        return;
    };
    let result = async {
        let mut fresh = github::fetch_details(&poller.http, &token.value, &ids).await?;
        // Only the viewer's own PRs need the expensive merge state.
        let authored: HashSet<String> = match poller.latest.lock().unwrap().as_ref() {
            Some(fetched) => fetched
                .pull_requests
                .iter()
                .map(|pr| pr.id.clone())
                .collect(),
            None => return Ok(()),
        };
        let (mut own, others): (Vec<_>, Vec<_>) =
            fresh.drain(..).partition(|pr| authored.contains(&pr.id));
        github::add_merge_states(&poller.http, &token.value, &mut own).await?;
        own.extend(others);

        if let Some(fetched) = poller.latest.lock().unwrap().as_mut() {
            apply_refresh(fetched, own);
        }
        Ok::<(), FetchError>(())
    }
    .await;

    match result {
        Ok(()) => poller.rederive(app),
        Err(e) => log::warn!("Could not refresh visited pull requests: {e:?}"),
    }
}

/// Replaces each refreshed PR in place, or drops it if it was merged or
/// closed. PRs the last fetch didn't list are ignored; the full refresh
/// decides what belongs in the lists.
fn apply_refresh(fetched: &mut Fetched, fresh: Vec<PullRequest>) {
    for pr in fresh {
        if let Some(at) = fetched.pull_requests.iter().position(|p| p.id == pr.id) {
            if pr.closed {
                fetched.pull_requests.remove(at);
            } else {
                fetched.pull_requests[at] = pr;
            }
        } else if let Some(at) = fetched
            .review_pull_requests
            .iter()
            .position(|p| p.id == pr.id)
        {
            if pr.closed {
                fetched.review_pull_requests.remove(at);
            } else {
                let was_requested = fetched.review_pull_requests[at].review_requested;
                let mut pr = pr;
                pr.review_requested = still_requested(&pr, &fetched.viewer, was_requested);
                fetched.review_pull_requests[at] = pr;
            }
        }
    }
}

/// The `review-requested` search isn't repeated for one PR, so infer it:
/// the viewer is asked directly, or a team still is and they were requested
/// through it before. A review by the viewer clears only their own request.
fn still_requested(pr: &PullRequest, viewer: &str, was_requested: bool) -> bool {
    let pending = || {
        pr.review_requests
            .iter()
            .flat_map(|n| n.iter())
            .filter_map(|r| r.requested_reviewer.as_ref())
    };
    let directly = pending().any(
        |r| matches!(r, RequestedReviewer::User { login } if login.eq_ignore_ascii_case(viewer)),
    );
    let via_team = was_requested && pending().any(|r| matches!(r, RequestedReviewer::Team { .. }));
    directly || via_team
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
    let channels = poller.channels(&settings, &poller.memory.lock().unwrap());
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
        checks::track(&fetched.pull_requests, &mut memory);
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
        s.team_channels = channels;
        s.slack_opens_in = settings.slack_opens_in;
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

    fn pr(id: &str, overrides: serde_json::Value) -> PullRequest {
        let mut pr = serde_json::json!({
            "id": id,
            "number": 1,
            "title": "Old",
            "url": "https://github.com/o/r/pull/1",
            "isDraft": false,
            "createdAt": "2026-10-01T09:00:00Z",
            "reviewDecision": null,
            "mergeable": "MERGEABLE",
            "autoMergeRequest": null,
            "repository": { "nameWithOwner": "o/r" },
            "commits": { "nodes": [] },
            "timelineItems": { "nodes": [] },
        });
        for (key, value) in overrides.as_object().unwrap() {
            pr[key] = value.clone();
        }
        serde_json::from_value(pr).unwrap()
    }

    fn fetched() -> Fetched {
        Fetched {
            viewer: "me".into(),
            token_source: TokenSource::Gh,
            sso_partial: false,
            pull_requests: vec![pr("mine", serde_json::json!({}))],
            review_pull_requests: vec![pr(
                "theirs",
                serde_json::json!({ "reviewRequested": true }),
            )],
        }
    }

    #[test]
    fn a_refreshed_pr_replaces_its_old_self() {
        let mut fetched = fetched();
        apply_refresh(
            &mut fetched,
            vec![pr("mine", serde_json::json!({ "title": "New" }))],
        );
        assert_eq!(fetched.pull_requests[0].title, "New");
        assert_eq!(fetched.review_pull_requests[0].title, "Old");
    }

    #[test]
    fn merged_or_closed_prs_are_dropped() {
        let mut fetched = fetched();
        let closed = serde_json::json!({ "closed": true });
        apply_refresh(
            &mut fetched,
            vec![pr("mine", closed.clone()), pr("theirs", closed)],
        );
        assert!(fetched.pull_requests.is_empty());
        assert!(fetched.review_pull_requests.is_empty());
    }

    #[test]
    fn unknown_prs_are_left_to_the_full_refresh() {
        let mut fetched = fetched();
        apply_refresh(&mut fetched, vec![pr("other", serde_json::json!({}))]);
        assert_eq!(fetched.pull_requests.len(), 1);
        assert_eq!(fetched.review_pull_requests.len(), 1);
    }

    #[test]
    fn reviewing_clears_a_direct_request_but_not_a_team_one() {
        let direct = serde_json::json!({ "reviewRequests": { "nodes": [
            { "requestedReviewer": { "__typename": "User", "login": "Me" } },
        ] } });
        let team = serde_json::json!({ "reviewRequests": { "nodes": [
            { "requestedReviewer": { "__typename": "Team", "slug": "t" } },
        ] } });
        let none = serde_json::json!({ "reviewRequests": { "nodes": [] } });

        assert!(still_requested(&pr("p", direct), "me", false));
        assert!(still_requested(&pr("p", team.clone()), "me", true));
        assert!(!still_requested(&pr("p", team), "me", false));
        assert!(!still_requested(&pr("p", none), "me", true));
    }
}
