//! One poll, minus fetching: deriving the lists, working out what to notify
//! about, and patching single pull requests into the last fetch. The desktop
//! and web apps do their own fetching and call this.

use std::collections::HashMap;

use chrono::{DateTime, Duration, TimeZone, Utc};

use crate::auth::TokenSource;
use crate::checks;
use crate::directory::Directory;
use crate::github::types::{PullRequest, RequestedReviewer};
use crate::memory::Memory;
use crate::notify::{self, Notification};
use crate::prs::{self, PrView};
use crate::reviews::{self, ReviewView};
use crate::settings::Settings;

/// A gap this long between polls means the machine slept or was offline, so
/// whatever happened meanwhile is summarized rather than replayed.
const COLD_START_GAP: Duration = Duration::minutes(15);

/// What a fetch brought back.
pub struct Fetched {
    pub viewer: String,
    pub token_source: TokenSource,
    pub sso_partial: bool,
    pub pull_requests: Vec<PullRequest>,
    pub review_pull_requests: Vec<PullRequest>,
    /// Each enabled custom view's matching PRs, by view id. Empty for a view
    /// that's off, so nothing is fetched for it.
    pub view_pull_requests: HashMap<String, Vec<PullRequest>>,
}

pub fn dormant_after(settings: &Settings) -> Duration {
    Duration::days(settings.dormant_after_days.into())
}

/// The lists as they stand at `now`.
pub fn derive(
    fetched: &Fetched,
    settings: &Settings,
    memory: &Memory,
    directory: &Directory,
    now: DateTime<Utc>,
) -> (Vec<PrView>, Vec<ReviewView>) {
    let snoozed = memory.snoozes();
    let estimates = checks::estimates(memory, &settings.check_durations);
    let rules = prs::Rules {
        directory,
        ignored_logins: &settings.ignored_logins,
        dormant_after: dormant_after(settings),
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

/// Each custom view's PRs, derived the same way as your own (actions,
/// checks, reviewers), but shown as one flat list, not split by group.
/// Informational only: unlike `derive`'s lists, these don't feed
/// notifications or the tray count (see `notify::diff`'s `other_ids`).
pub fn derive_views(
    fetched: &Fetched,
    settings: &Settings,
    memory: &Memory,
    directory: &Directory,
    now: DateTime<Utc>,
) -> HashMap<String, Vec<PrView>> {
    let snoozed = memory.snoozes();
    let estimates = checks::estimates(memory, &settings.check_durations);
    let rules = prs::Rules {
        directory,
        ignored_logins: &settings.ignored_logins,
        dormant_after: dormant_after(settings),
        snoozed: &snoozed,
    };
    fetched
        .view_pull_requests
        .iter()
        .map(|(id, pull_requests)| {
            let mut views = prs::derive(pull_requests, &fetched.viewer, &rules, now);
            for view in &mut views {
                view.checks_estimate_secs = estimates.get(&view.repo).copied();
            }
            (id.clone(), views)
        })
        .collect()
}

/// Records a full poll in `memory` and returns what to notify about. The
/// first poll after launch, or after a gap, summarizes instead of replaying,
/// and the very first one after install is silent.
#[allow(clippy::too_many_arguments)]
pub fn record_poll<Tz: TimeZone>(
    views: &[PrView],
    review_views: &[ReviewView],
    other_ids: &[String],
    pull_requests: &[PullRequest],
    settings: &Settings,
    memory: &mut Memory,
    now: DateTime<Utc>,
    first_poll_since_launch: bool,
    tz: &Tz,
) -> Vec<Notification> {
    let first_ever = memory.last_poll_at.is_none();
    let cold_start = first_poll_since_launch
        || memory
            .last_poll_at
            .is_some_and(|at| now - at > COLD_START_GAP);
    let events = notify::diff(
        views,
        review_views,
        other_ids,
        memory,
        now,
        Duration::hours(settings.nudge_after_hours.into()),
        Duration::hours(settings.review_nudge_after_hours.into()),
        tz,
    );
    checks::track(pull_requests, memory);
    // Right after install everything is new; the list itself says what's pending.
    if first_ever {
        Vec::new()
    } else {
        notify::compose(&events, cold_start)
    }
}

/// Replaces each refreshed PR in place, or drops it if it was merged or
/// closed. PRs the last fetch didn't list are ignored; the full refresh
/// decides what belongs in the lists.
pub fn apply_refresh(fetched: &mut Fetched, fresh: Vec<PullRequest>) {
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
pub fn still_requested(pr: &PullRequest, viewer: &str, was_requested: bool) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;

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
            view_pull_requests: HashMap::new(),
        }
    }

    #[test]
    fn each_views_prs_are_derived_the_same_way_as_your_own() {
        let mut fetched = fetched();
        fetched.view_pull_requests.insert(
            "v1".to_string(),
            vec![pr(
                "matched",
                serde_json::json!({ "author": { "__typename": "User", "login": "ana" } }),
            )],
        );
        let settings = Settings::default();
        let memory = Memory::default();
        let directory = Directory::default();
        let now: DateTime<Utc> = "2026-10-28T12:00:00Z".parse().unwrap();

        let views = derive_views(&fetched, &settings, &memory, &directory, now);

        assert_eq!(views.len(), 1);
        assert_eq!(views["v1"][0].id, "matched");
        // A view with nothing enabled, or nothing fetched, derives nothing.
        assert!(derive_views(&fetched, &settings, &memory, &directory, now).contains_key("v1"));
        fetched.view_pull_requests.clear();
        assert!(derive_views(&fetched, &settings, &memory, &directory, now).is_empty());
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

    fn approval(login: &str, at: &str) -> serde_json::Value {
        serde_json::json!({ "reviews": { "nodes": [{
            "state": "APPROVED",
            "submittedAt": at,
            "author": { "__typename": "User", "login": login },
        }] } })
    }

    fn poll(
        pr: PullRequest,
        memory: &mut Memory,
        now: &str,
        first_poll_since_launch: bool,
    ) -> Vec<Notification> {
        let now: DateTime<Utc> = now.parse().unwrap();
        let fetched = Fetched {
            viewer: "me".into(),
            token_source: TokenSource::Pat,
            sso_partial: false,
            pull_requests: vec![pr],
            review_pull_requests: Vec::new(),
            view_pull_requests: HashMap::new(),
        };
        let settings = Settings::default();
        let (views, review_views) = derive(&fetched, &settings, memory, &Directory::default(), now);
        record_poll(
            &views,
            &review_views,
            &[],
            &fetched.pull_requests,
            &settings,
            memory,
            now,
            first_poll_since_launch,
            &Utc,
        )
    }

    #[test]
    fn the_first_poll_after_install_is_silent_and_later_ones_notify() {
        let mut memory = Memory::default();
        assert!(
            poll(
                pr("mine", approval("ana", "2026-10-02T09:00:00Z")),
                &mut memory,
                "2026-10-02T10:00:00Z",
                true,
            )
            .is_empty()
        );

        // A new approval, a few minutes later.
        let notes = poll(
            pr("mine", approval("bo", "2026-10-02T10:03:00Z")),
            &mut memory,
            "2026-10-02T10:04:00Z",
            false,
        );
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].detail.as_deref(), Some("bo approved"));
    }

    #[test]
    fn after_a_long_gap_what_happened_is_summarized() {
        let mut memory = Memory::default();
        poll(
            pr("mine", serde_json::json!({})),
            &mut memory,
            "2026-10-02T10:00:00Z",
            true,
        );

        let notes = poll(
            pr("mine", approval("bo", "2026-10-02T12:00:00Z")),
            &mut memory,
            "2026-10-02T12:30:00Z",
            false,
        );
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].label, "While you were away");
    }
}
