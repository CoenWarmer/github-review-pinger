//! Turns pull requests by others into the review-request view: which ones are
//! waiting on the viewer, which the viewer has already reviewed, and since
//! when it has been the viewer's turn.

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::github::types::{PullRequest, RequestedReviewer, Review, ReviewState, TimelineItem};
use crate::prs::{self, People, Reviewer, ReviewerState, Rules};

/// Ordered by display order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewGroup {
    /// Requested of the viewer or one of their teams.
    NeedsReview,
    /// Reviewed by the viewer and no longer requested.
    WaitingOnAuthor,
    Snoozed,
    Draft,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewView {
    pub id: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub repo: String,
    pub author: String,
    pub group: ReviewGroup,
    pub open_since: DateTime<Utc>,
    /// When it became the viewer's turn; only for requested PRs.
    pub waiting_since: Option<DateTime<Utc>>,
    /// Requested again after the viewer already reviewed.
    pub rerequested: bool,
    /// The viewer's latest submitted review.
    pub my_state: Option<ReviewerState>,
    pub reviewed_at: Option<DateTime<Utc>>,
    pub last_activity: DateTime<Utc>,
    pub snoozed_until: Option<DateTime<Utc>>,
    /// Everyone but the viewer and the author.
    pub reviewers: Vec<Reviewer>,
}

impl ReviewView {
    /// Counts toward the tray number: a review is due and the PR isn't
    /// parked as a draft or snoozed.
    pub fn needs_review(&self) -> bool {
        self.group == ReviewGroup::NeedsReview
    }
}

pub fn derive(
    prs: &[PullRequest],
    viewer: &str,
    rules: &Rules,
    now: DateTime<Utc>,
) -> Vec<ReviewView> {
    let mut views: Vec<ReviewView> = prs
        .iter()
        .filter_map(|pr| view(pr, viewer, rules, now))
        .collect();
    views.sort_by(|a, b| {
        a.group.cmp(&b.group).then_with(|| match a.group {
            ReviewGroup::NeedsReview => a.waiting_since.cmp(&b.waiting_since),
            ReviewGroup::WaitingOnAuthor | ReviewGroup::Snoozed => {
                b.last_activity.cmp(&a.last_activity)
            }
            ReviewGroup::Draft => b.open_since.cmp(&a.open_since),
        })
    });
    views
}

/// `None` for PRs the viewer is no longer involved in, such as when their
/// only review was dismissed and the request is gone.
fn view(pr: &PullRequest, viewer: &str, rules: &Rules, now: DateTime<Utc>) -> Option<ReviewView> {
    let mine = my_review(pr, viewer);
    let requested = pr.review_requested;
    if !requested && mine.is_none() {
        return None;
    }

    let author = pr.author.as_ref().map_or("ghost", |a| a.login.as_str());
    let open_since = prs::open_since(pr);
    // Judge everyone else's activity from the author's side, so the author
    // and bots are left out of the chips and the viewer is kept for now.
    let people = People {
        viewer: author,
        ignored_logins: rules.ignored_logins,
    };
    let mut reviewers = prs::reviewers(pr, &people);
    reviewers.retain(|r| !r.login.eq_ignore_ascii_case(viewer));

    let waiting_since = requested.then(|| waiting_since(pr, viewer, open_since));
    let snoozed_until = rules
        .snoozed
        .get(&pr.id)
        .copied()
        .filter(|&until| until > now);
    let group = if pr.is_draft {
        ReviewGroup::Draft
    } else if snoozed_until.is_some() {
        ReviewGroup::Snoozed
    } else if requested {
        ReviewGroup::NeedsReview
    } else {
        ReviewGroup::WaitingOnAuthor
    };

    Some(ReviewView {
        id: pr.id.clone(),
        number: pr.number,
        title: pr.title.clone(),
        url: pr.url.clone(),
        repo: pr.repository.name_with_owner.clone(),
        author: author.to_string(),
        group,
        open_since,
        waiting_since,
        rerequested: requested && mine.is_some(),
        my_state: mine.map(|(state, _)| state),
        reviewed_at: mine.and_then(|(_, at)| at),
        last_activity: prs::last_activity(pr, &people, open_since),
        snoozed_until,
        reviewers,
    })
}

/// The viewer's latest submitted review: its verdict, and when it was
/// submitted if known. An approval or change request outranks a later comment.
fn my_review(pr: &PullRequest, viewer: &str) -> Option<(ReviewerState, Option<DateTime<Utc>>)> {
    let mine = |review: &&Review| {
        review
            .author
            .as_ref()
            .is_some_and(|a| a.login.eq_ignore_ascii_case(viewer))
    };
    let latest = || pr.latest_reviews.iter().flat_map(|n| n.iter());
    let opinionated = || pr.latest_opinionated_reviews.iter().flat_map(|n| n.iter());

    let state = opinionated()
        .chain(latest())
        .filter(mine)
        .find_map(|r| match r.state {
            ReviewState::Approved => Some(ReviewerState::Approved),
            ReviewState::ChangesRequested => Some(ReviewerState::ChangesRequested),
            ReviewState::Commented => Some(ReviewerState::Commented),
            _ => None,
        })?;
    let at = pr
        .reviews
        .iter()
        .chain(latest())
        .chain(opinionated())
        .filter(mine)
        .filter(|r| r.state != ReviewState::Pending)
        .filter_map(|r| r.submitted_at)
        .max();
    Some((state, at))
}

/// When it became the viewer's turn: the latest request naming them, or,
/// when they're only requested through a team, the latest request naming a
/// team. Not earlier than the open clock, which time as a draft doesn't count
/// against.
fn waiting_since(pr: &PullRequest, viewer: &str, open_since: DateTime<Utc>) -> DateTime<Utc> {
    let requested_directly = pr
        .review_requests
        .iter()
        .flat_map(|n| n.iter())
        .filter_map(|r| r.requested_reviewer.as_ref())
        .any(|reviewer| matches!(reviewer, RequestedReviewer::User { login } if login.eq_ignore_ascii_case(viewer)));

    let events = pr.timeline_items.iter().filter_map(|item| match item {
        TimelineItem::ReviewRequestedEvent {
            created_at,
            requested_reviewer: Some(reviewer),
        } => Some((*created_at, reviewer)),
        _ => None,
    });
    let latest = events
        .filter(|(_, reviewer)| match reviewer {
            RequestedReviewer::User { login } => {
                requested_directly && login.eq_ignore_ascii_case(viewer)
            }
            RequestedReviewer::Team { .. } => !requested_directly,
            _ => false,
        })
        .map(|(at, _)| at)
        .max();
    latest.map_or(open_since, |at| at.max(open_since))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::collections::HashMap;

    const ME: &str = "me";
    const NOW: &str = "2026-10-10T09:00:00Z";

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    fn pr(overrides: Value) -> PullRequest {
        let mut pr = json!({
            "id": "PR_1",
            "number": 1,
            "title": "Title",
            "url": "https://github.com/o/r/pull/1",
            "author": { "__typename": "User", "login": "ana" },
            "isDraft": false,
            "createdAt": "2026-10-01T09:00:00Z",
            "reviewDecision": "REVIEW_REQUIRED",
            "mergeable": "MERGEABLE",
            "autoMergeRequest": null,
            "repository": { "nameWithOwner": "o/r" },
            "commits": { "nodes": [{ "commit": {
                "committedDate": "2026-10-01T09:00:00Z",
                "statusCheckRollup": null,
            } }] },
            "reviewRequests": { "nodes": [] },
            "latestReviews": { "nodes": [] },
            "latestOpinionatedReviews": { "nodes": [] },
            "reviews": { "nodes": [] },
            "timelineItems": { "nodes": [] },
            "reviewRequested": true,
        });
        for (key, value) in overrides.as_object().unwrap() {
            pr[key] = value.clone();
        }
        serde_json::from_value(pr).unwrap()
    }

    fn derive_with(
        overrides: Value,
        snoozed: &HashMap<String, DateTime<Utc>>,
    ) -> Option<ReviewView> {
        let rules = Rules {
            ignored_logins: &[],
            dormant_after: chrono::Duration::days(30),
            snoozed,
        };
        derive(&[pr(overrides)], ME, &rules, at(NOW)).pop()
    }

    fn derive_one(overrides: Value) -> Option<ReviewView> {
        derive_with(overrides, &HashMap::new())
    }

    fn requested(login_or_team: Value, when: &str) -> Value {
        json!({
            "__typename": "ReviewRequestedEvent",
            "createdAt": when,
            "requestedReviewer": login_or_team,
        })
    }

    fn user(login: &str) -> Value {
        json!({ "__typename": "User", "login": login })
    }

    fn team(slug: &str) -> Value {
        json!({ "__typename": "Team", "slug": slug })
    }

    fn review(login: &str, state: &str, when: &str) -> Value {
        json!({
            "state": state,
            "submittedAt": when,
            "author": { "__typename": "User", "login": login },
        })
    }

    #[test]
    fn requested_prs_need_your_review() {
        let v = derive_one(json!({})).unwrap();
        assert_eq!(v.group, ReviewGroup::NeedsReview);
        assert!(v.needs_review());
        assert_eq!(v.author, "ana");
        assert!(!v.rerequested);
        assert_eq!(v.waiting_since, Some(at("2026-10-01T09:00:00Z")));
    }

    #[test]
    fn the_clock_starts_at_your_request() {
        let v = derive_one(json!({
            "reviewRequests": { "nodes": [{ "requestedReviewer": user(ME) }] },
            "timelineItems": { "nodes": [
                requested(user(ME), "2026-10-05T09:00:00Z"),
                requested(user("bo"), "2026-10-08T09:00:00Z"),
                requested(team("t"), "2026-10-09T09:00:00Z"),
            ] },
        }))
        .unwrap();
        assert_eq!(v.waiting_since, Some(at("2026-10-05T09:00:00Z")));
    }

    #[test]
    fn team_requests_count_when_you_are_not_requested_directly() {
        let v = derive_one(json!({
            "reviewRequests": { "nodes": [{ "requestedReviewer": team("t") }] },
            "timelineItems": { "nodes": [
                requested(team("t"), "2026-10-04T09:00:00Z"),
                requested(user("bo"), "2026-10-08T09:00:00Z"),
            ] },
        }))
        .unwrap();
        assert_eq!(v.waiting_since, Some(at("2026-10-04T09:00:00Z")));
    }

    #[test]
    fn time_as_a_draft_does_not_count() {
        let v = derive_one(json!({
            "timelineItems": { "nodes": [
                requested(user(ME), "2026-10-02T09:00:00Z"),
                { "__typename": "ReadyForReviewEvent", "createdAt": "2026-10-06T09:00:00Z" },
            ] },
            "reviewRequests": { "nodes": [{ "requestedReviewer": user(ME) }] },
        }))
        .unwrap();
        assert_eq!(v.waiting_since, Some(at("2026-10-06T09:00:00Z")));
    }

    #[test]
    fn a_re_request_after_reviewing_is_flagged() {
        let v = derive_one(json!({
            "latestReviews": { "nodes": [review(ME, "COMMENTED", "2026-10-03T09:00:00Z")] },
            "latestOpinionatedReviews": { "nodes": [review(ME, "CHANGES_REQUESTED", "2026-10-02T09:00:00Z")] },
        }))
        .unwrap();
        assert_eq!(v.group, ReviewGroup::NeedsReview);
        assert!(v.rerequested);
        // The change request outranks the later comment.
        assert_eq!(v.my_state, Some(ReviewerState::ChangesRequested));
        assert_eq!(v.reviewed_at, Some(at("2026-10-03T09:00:00Z")));
    }

    #[test]
    fn reviewed_prs_wait_on_the_author_whatever_the_verdict() {
        for state in ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"] {
            let v = derive_one(json!({
                "reviewRequested": false,
                "latestReviews": { "nodes": [review(ME, state, "2026-10-03T09:00:00Z")] },
                "latestOpinionatedReviews": { "nodes": [] },
            }))
            .unwrap();
            assert_eq!(v.group, ReviewGroup::WaitingOnAuthor, "{state}");
            assert!(!v.needs_review());
            assert_eq!(v.waiting_since, None);
        }
    }

    #[test]
    fn prs_you_are_not_involved_in_are_dropped() {
        assert!(derive_one(json!({ "reviewRequested": false })).is_none());
        // A dismissed review doesn't make you a reviewer.
        assert!(
            derive_one(json!({
                "reviewRequested": false,
                "latestReviews": { "nodes": [review(ME, "DISMISSED", "2026-10-03T09:00:00Z")] },
            }))
            .is_none()
        );
    }

    #[test]
    fn drafts_and_snoozed_prs_are_parked() {
        assert_eq!(
            derive_one(json!({ "isDraft": true })).unwrap().group,
            ReviewGroup::Draft
        );

        let mut snoozed = HashMap::new();
        snoozed.insert("PR_1".to_string(), at("2026-10-11T09:00:00Z"));
        let v = derive_with(json!({}), &snoozed).unwrap();
        assert_eq!(v.group, ReviewGroup::Snoozed);
        assert!(!v.needs_review());

        // An expired snooze no longer applies.
        snoozed.insert("PR_1".to_string(), at("2026-10-09T09:00:00Z"));
        assert_eq!(
            derive_with(json!({}), &snoozed).unwrap().group,
            ReviewGroup::NeedsReview
        );
    }

    #[test]
    fn chips_leave_out_you_and_the_author() {
        let v = derive_one(json!({
            "latestReviews": { "nodes": [
                review(ME, "COMMENTED", "2026-10-03T09:00:00Z"),
                review("ana", "COMMENTED", "2026-10-03T10:00:00Z"),
                review("bo", "APPROVED", "2026-10-03T11:00:00Z"),
            ] },
            "reviewRequests": { "nodes": [
                { "requestedReviewer": user(ME) },
                { "requestedReviewer": user("cy") },
            ] },
        }))
        .unwrap();
        let logins: Vec<&str> = v.reviewers.iter().map(|r| r.login.as_str()).collect();
        assert_eq!(logins, ["bo", "cy"]);
    }

    #[test]
    fn longest_waiting_comes_first() {
        let rules = Rules {
            ignored_logins: &[],
            dormant_after: chrono::Duration::days(30),
            snoozed: &HashMap::new(),
        };
        let mut newer = pr(json!({ "id": "newer", "createdAt": "2026-10-08T09:00:00Z" }));
        newer.number = 2;
        let older = pr(json!({ "id": "older", "createdAt": "2026-10-02T09:00:00Z" }));
        let ids: Vec<String> = derive(&[newer, older], ME, &rules, at(NOW))
            .into_iter()
            .map(|v| v.id)
            .collect();
        assert_eq!(ids, ["older", "newer"]);
    }
}
