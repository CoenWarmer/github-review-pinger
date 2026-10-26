//! Turns raw GitHub pull requests into what the popover and tray show: the
//! open and quiet clocks, what needs the author's action, which PRs have gone
//! dormant, and per-reviewer state.

use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::github::types::{
    Actor, CheckState, MergeStateStatus, Mergeable, PullRequest, RequestedReviewer, ReviewDecision,
    ReviewState, TimelineItem,
};

/// Ordered by sort priority; a pull request is sorted by its first action.
/// Ready-to-merge comes first because it's the quickest win, and it never
/// co-occurs with the others.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    ReadyToMerge,
    ChangesRequested,
    NewFeedback,
    Conflicts,
    CiFailing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Group {
    /// Approved PRs, whatever else is going on; their actions still count.
    Approved,
    NeedsAction,
    Waiting,
    Snoozed,
    Dormant,
    Draft,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Checks {
    Passing,
    Pending,
    Failing,
    /// The repo runs no checks on this PR.
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewerKind {
    User,
    Team,
    Bot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewerState {
    ChangesRequested,
    Approved,
    Commented,
    Pending,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reviewer {
    pub login: String,
    pub kind: ReviewerKind,
    pub state: ReviewerState,
    /// Already reviewed, and the author has asked for another review since.
    pub rerequested: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrView {
    pub id: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub repo: String,
    pub group: Group,
    pub actions: Vec<Action>,
    pub open_since: DateTime<Utc>,
    pub quiet_since: DateTime<Utc>,
    /// The last push, or review or comment by a human including the author.
    pub last_activity: DateTime<Utc>,
    pub snoozed_until: Option<DateTime<Utc>>,
    /// Has the approvals it needs; any further wait is on checks or merging.
    pub approved: bool,
    pub checks: Checks,
    pub auto_merge: bool,
    pub reviewers: Vec<Reviewer>,
    /// Reviews and comments from other humans, oldest first, for notifications.
    #[serde(skip)]
    pub responses: Vec<Response>,
}

impl PrView {
    /// Counts toward the tray number: something for the author to do, and
    /// not parked as a draft, snoozed, or dormant.
    pub fn needs_author(&self) -> bool {
        matches!(self.group, Group::Approved | Group::NeedsAction) && !self.actions.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseKind {
    Approved,
    ChangesRequested,
    Commented,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub login: String,
    pub kind: ResponseKind,
    pub at: DateTime<Utc>,
}

pub struct Rules<'a> {
    pub ignored_logins: &'a [String],
    pub dormant_after: chrono::Duration,
    /// Snooze end times by pull request id.
    pub snoozed: &'a HashMap<String, DateTime<Utc>>,
}

pub fn derive(prs: &[PullRequest], viewer: &str, rules: &Rules, now: DateTime<Utc>) -> Vec<PrView> {
    let people = People {
        viewer,
        ignored_logins: rules.ignored_logins,
    };
    let mut views: Vec<PrView> = prs.iter().map(|pr| view(pr, &people, rules, now)).collect();
    // Within every section the stalest PRs sink to the bottom.
    views.sort_by(|a, b| {
        a.group.cmp(&b.group).then_with(|| match a.group {
            // PRs with an action come first (ready to merge leading), then
            // those just waiting on checks or auto-merge.
            Group::Approved | Group::NeedsAction => a
                .actions
                .is_empty()
                .cmp(&b.actions.is_empty())
                .then(a.actions.first().cmp(&b.actions.first()))
                .then(b.quiet_since.cmp(&a.quiet_since)),
            Group::Waiting | Group::Snoozed => b.quiet_since.cmp(&a.quiet_since),
            Group::Dormant => b.last_activity.cmp(&a.last_activity),
            Group::Draft => b.open_since.cmp(&a.open_since),
        })
    });
    views
}

struct People<'a> {
    viewer: &'a str,
    ignored_logins: &'a [String],
}

impl People<'_> {
    fn is_viewer(&self, login: &str) -> bool {
        login.eq_ignore_ascii_case(self.viewer)
    }

    fn is_automated(&self, actor: &Actor) -> bool {
        actor.typename == "Bot" || actor.login.ends_with("[bot]") || self.is_ignored(&actor.login)
    }

    fn is_ignored(&self, login: &str) -> bool {
        self.ignored_logins
            .iter()
            .any(|ignored| ignored.eq_ignore_ascii_case(login))
    }

    /// Someone other than the author or a bot.
    fn is_other_human(&self, actor: &Actor) -> bool {
        !self.is_viewer(&actor.login) && !self.is_automated(actor)
    }
}

fn view(pr: &PullRequest, people: &People, rules: &Rules, now: DateTime<Utc>) -> PrView {
    let open_since = open_since(pr);
    let quiet_since = latest_response(pr, |author| people.is_other_human(author))
        .map_or(open_since, |t| t.max(open_since));
    let last_activity = last_activity(pr, people, open_since);
    let reviewers = reviewers(pr, people);
    let responses = responses(pr, people);
    let approved = is_approved(pr, &reviewers);
    let checks = checks(pr);
    let actions = actions(
        pr,
        &reviewers,
        approved,
        checks,
        has_new_feedback(pr, people, &responses),
    );
    let snoozed_until = rules
        .snoozed
        .get(&pr.id)
        .copied()
        .filter(|&until| until > now);

    let group = if pr.is_draft {
        Group::Draft
    } else if snoozed_until.is_some() {
        Group::Snoozed
    } else if last_activity < now - rules.dormant_after {
        Group::Dormant
    } else if approved {
        Group::Approved
    } else if actions.is_empty() {
        Group::Waiting
    } else {
        Group::NeedsAction
    };

    PrView {
        id: pr.id.clone(),
        number: pr.number,
        title: pr.title.clone(),
        url: pr.url.clone(),
        repo: pr.repository.name_with_owner.clone(),
        group,
        actions,
        open_since,
        quiet_since,
        last_activity,
        snoozed_until,
        approved,
        checks,
        auto_merge: pr.auto_merge_request.is_some(),
        reviewers,
        responses,
    }
}

/// Time spent as a draft doesn't count against reviewers.
fn open_since(pr: &PullRequest) -> DateTime<Utc> {
    pr.timeline_items
        .iter()
        .filter_map(|item| match item {
            TimelineItem::ReadyForReviewEvent { created_at } => Some(*created_at),
            _ => None,
        })
        .max()
        .unwrap_or(pr.created_at)
}

fn last_activity(pr: &PullRequest, people: &People, open_since: DateTime<Utc>) -> DateTime<Utc> {
    let last_push = pr
        .commits
        .iter()
        .last()
        .map(|node| node.commit.committed_date);
    let last_response = latest_response(pr, |author| !people.is_automated(author));
    [Some(open_since), last_push, last_response]
        .into_iter()
        .flatten()
        .max()
        .unwrap_or(open_since)
}

/// Someone else commented (in a review or on the conversation) after the
/// author last pushed, replied, or requested review. Approvals and change
/// requests have their own handling and don't count.
fn has_new_feedback(pr: &PullRequest, people: &People, responses: &[Response]) -> bool {
    let Some(latest_comment) = responses
        .iter()
        .filter(|r| r.kind == ResponseKind::Commented)
        .map(|r| r.at)
        .max()
    else {
        return false;
    };
    let last_push = pr
        .commits
        .iter()
        .last()
        .map(|node| node.commit.committed_date);
    let last_reply = latest_response(pr, |author| people.is_viewer(&author.login));
    let last_request = pr
        .timeline_items
        .iter()
        .filter_map(|item| match item {
            TimelineItem::ReviewRequestedEvent { created_at } => Some(*created_at),
            _ => None,
        })
        .max();
    [last_push, last_reply, last_request]
        .into_iter()
        .flatten()
        .max()
        .is_none_or(|author_acted| latest_comment > author_acted)
}

/// The latest review or comment whose author passes `counts`.
fn latest_response(pr: &PullRequest, counts: impl Fn(&Actor) -> bool) -> Option<DateTime<Utc>> {
    pr.timeline_items
        .iter()
        .filter_map(|item| match item {
            TimelineItem::PullRequestReview {
                submitted_at: Some(at),
                author: Some(author),
                ..
            }
            | TimelineItem::IssueComment {
                created_at: at,
                author: Some(author),
            } if counts(author) => Some(*at),
            _ => None,
        })
        .max()
}

fn responses(pr: &PullRequest, people: &People) -> Vec<Response> {
    let mut responses: Vec<Response> = pr
        .timeline_items
        .iter()
        .filter_map(|item| {
            let (author, kind, at) = match item {
                TimelineItem::PullRequestReview {
                    state,
                    submitted_at: Some(at),
                    author: Some(author),
                } => {
                    let kind = match state {
                        ReviewState::Approved => ResponseKind::Approved,
                        ReviewState::ChangesRequested => ResponseKind::ChangesRequested,
                        ReviewState::Commented => ResponseKind::Commented,
                        _ => return None,
                    };
                    (author, kind, *at)
                }
                TimelineItem::IssueComment {
                    created_at,
                    author: Some(author),
                } => (author, ResponseKind::Commented, *created_at),
                _ => return None,
            };
            people.is_other_human(author).then(|| Response {
                login: author.login.clone(),
                kind,
                at,
            })
        })
        .collect();
    responses.sort_by_key(|r| r.at);
    responses
}

fn reviewers(pr: &PullRequest, people: &People) -> Vec<Reviewer> {
    let mut by_login: BTreeMap<String, Reviewer> = BTreeMap::new();

    // Opinionated reviews (approve / request changes) stand even if the
    // reviewer commented afterwards, so they take precedence.
    let opinionated = pr.latest_opinionated_reviews.iter().flat_map(|n| n.iter());
    let latest = pr.latest_reviews.iter().flat_map(|n| n.iter());
    for review in opinionated.chain(latest) {
        let Some(author) = &review.author else {
            continue;
        };
        if !people.is_other_human(author) {
            continue;
        }
        let state = match review.state {
            ReviewState::Approved => ReviewerState::Approved,
            ReviewState::ChangesRequested => ReviewerState::ChangesRequested,
            ReviewState::Commented => ReviewerState::Commented,
            _ => continue,
        };
        by_login
            .entry(author.login.to_lowercase())
            .or_insert_with(|| Reviewer {
                login: author.login.clone(),
                kind: ReviewerKind::User,
                state,
                rerequested: false,
            });
    }

    // Requested bots (e.g. Copilot) are shown; bots that merely commented are not.
    let requests = pr.review_requests.iter().flat_map(|n| n.iter());
    for requested in requests.filter_map(|r| r.requested_reviewer.as_ref()) {
        let (login, kind) = match requested {
            RequestedReviewer::User { login } | RequestedReviewer::Mannequin { login } => {
                (login.clone(), ReviewerKind::User)
            }
            RequestedReviewer::Bot { login } => (login.clone(), ReviewerKind::Bot),
            RequestedReviewer::Team { slug } => (format!("@{slug}"), ReviewerKind::Team),
            RequestedReviewer::Other => continue,
        };
        if people.is_ignored(&login) {
            continue;
        }
        by_login
            .entry(login.to_lowercase())
            .and_modify(|reviewer| reviewer.rerequested = true)
            .or_insert(Reviewer {
                login,
                kind,
                state: ReviewerState::Pending,
                rerequested: false,
            });
    }

    let mut reviewers: Vec<Reviewer> = by_login.into_values().collect();
    reviewers.sort_by_key(|r| r.state);
    reviewers
}

fn checks(pr: &PullRequest) -> Checks {
    let rollup = pr
        .commits
        .iter()
        .last()
        .and_then(|node| node.commit.status_check_rollup.as_ref());
    match rollup.map(|r| r.state) {
        None => Checks::None,
        Some(CheckState::Success) => Checks::Passing,
        Some(CheckState::Failure | CheckState::Error) => Checks::Failing,
        Some(CheckState::Pending | CheckState::Expected | CheckState::Other) => Checks::Pending,
    }
}

fn is_approved(pr: &PullRequest, reviewers: &[Reviewer]) -> bool {
    match pr.review_decision {
        Some(ReviewDecision::Approved) => true,
        // No required reviews in this repo: one approval will do.
        None => reviewers.iter().any(|r| r.state == ReviewerState::Approved),
        _ => false,
    }
}

fn actions(
    pr: &PullRequest,
    reviewers: &[Reviewer],
    approved: bool,
    checks: Checks,
    new_feedback: bool,
) -> Vec<Action> {
    // Once the author re-requests review from whoever asked for changes, the
    // ball is in the reviewer's court even though GitHub still reports
    // CHANGES_REQUESTED.
    let blocking_reviewers: Vec<&Reviewer> = reviewers
        .iter()
        .filter(|r| r.state == ReviewerState::ChangesRequested)
        .collect();
    let changes_requested = if blocking_reviewers.is_empty() {
        pr.review_decision == Some(ReviewDecision::ChangesRequested)
    } else {
        blocking_reviewers.iter().any(|r| !r.rerequested)
    };

    let conflicts = pr.mergeable == Mergeable::Conflicting;
    let ci_failing = checks == Checks::Failing;

    // Only when merging is up to the author right now: checks done, branch
    // protection satisfied, and auto-merge not already queued.
    let ready_to_merge = approved
        && blocking_reviewers.is_empty()
        && !conflicts
        && matches!(checks, Checks::Passing | Checks::None)
        && matches!(
            pr.merge_state_status,
            MergeStateStatus::Clean | MergeStateStatus::HasHooks
        )
        && pr.auto_merge_request.is_none();

    [
        (ready_to_merge, Action::ReadyToMerge),
        (changes_requested, Action::ChangesRequested),
        // A change request already says "your turn"; don't repeat it.
        (new_feedback && !changes_requested, Action::NewFeedback),
        (conflicts, Action::Conflicts),
        (ci_failing, Action::CiFailing),
    ]
    .into_iter()
    .filter_map(|(applies, action)| applies.then_some(action))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    const ME: &str = "author";
    const NOW: &str = "2026-10-10T09:00:00Z";

    fn base() -> Value {
        json!({
            "id": "PR_1",
            "number": 1,
            "title": "Title",
            "url": "https://github.com/o/r/pull/1",
            "isDraft": false,
            "createdAt": "2026-10-01T09:00:00Z",
            "reviewDecision": "REVIEW_REQUIRED",
            "mergeable": "MERGEABLE",
            "mergeStateStatus": "CLEAN",
            "autoMergeRequest": null,
            "repository": { "nameWithOwner": "o/r" },
            "commits": { "nodes": [commit("2026-10-01T09:00:00Z", "SUCCESS")] },
            "reviewRequests": { "nodes": [] },
            "latestReviews": { "nodes": [] },
            "latestOpinionatedReviews": { "nodes": [] },
            "timelineItems": { "nodes": [] }
        })
    }

    fn with(overrides: Value) -> PullRequest {
        let mut pr = base();
        for (key, value) in overrides.as_object().unwrap() {
            pr[key] = value.clone();
        }
        serde_json::from_value(pr).unwrap()
    }

    fn derive_one(overrides: Value) -> PrView {
        derive_with(overrides, &[])
    }

    fn derive_with(overrides: Value, ignored: &[String]) -> PrView {
        derive_all(vec![with(overrides)], ignored).remove(0)
    }

    fn derive_all(prs: Vec<PullRequest>, ignored: &[String]) -> Vec<PrView> {
        derive_snoozed(prs, ignored, &HashMap::new())
    }

    fn derive_snoozed(
        prs: Vec<PullRequest>,
        ignored: &[String],
        snoozed: &HashMap<String, DateTime<Utc>>,
    ) -> Vec<PrView> {
        let rules = Rules {
            ignored_logins: ignored,
            dormant_after: chrono::Duration::days(30),
            snoozed,
        };
        derive(&prs, ME, &rules, at(NOW))
    }

    fn commit(committed: &str, checks: &str) -> Value {
        json!({ "commit": { "committedDate": committed, "statusCheckRollup": { "state": checks } } })
    }

    fn user(login: &str) -> Value {
        json!({ "__typename": "User", "login": login })
    }

    fn bot(login: &str) -> Value {
        json!({ "__typename": "Bot", "login": login })
    }

    fn review(author: Value, state: &str) -> Value {
        json!({ "state": state, "author": author })
    }

    fn comment(author: Value, at: &str) -> Value {
        json!({ "__typename": "IssueComment", "createdAt": at, "author": author })
    }

    fn timeline_review(author: Value, at: &str) -> Value {
        timeline_review_with(author, "COMMENTED", at)
    }

    fn timeline_review_with(author: Value, state: &str, at: &str) -> Value {
        json!({ "__typename": "PullRequestReview", "state": state, "submittedAt": at, "author": author })
    }

    fn ready(at: &str) -> Value {
        json!({ "__typename": "ReadyForReviewEvent", "createdAt": at })
    }

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    #[test]
    fn open_clock_starts_at_latest_ready_for_review() {
        let pr = derive_one(json!({ "timelineItems": { "nodes": [
            ready("2026-10-02T09:00:00Z"),
            ready("2026-10-03T09:00:00Z"),
        ] } }));
        assert_eq!(pr.open_since, at("2026-10-03T09:00:00Z"));
    }

    #[test]
    fn open_clock_falls_back_to_creation() {
        assert_eq!(derive_one(json!({})).open_since, at("2026-10-01T09:00:00Z"));
    }

    #[test]
    fn quiet_clock_ignores_author_and_bots() {
        let ignored = vec!["kibanamachine".to_string()];
        let pr = derive_with(
            json!({ "timelineItems": { "nodes": [
                comment(user("reviewer"), "2026-10-02T09:00:00Z"),
                comment(user("Author"), "2026-10-03T09:00:00Z"),
                comment(bot("github-actions"), "2026-10-04T09:00:00Z"),
                comment(user("renovate[bot]"), "2026-10-05T09:00:00Z"),
                timeline_review(user("KibanaMachine"), "2026-10-06T09:00:00Z"),
            ] } }),
            &ignored,
        );
        assert_eq!(pr.quiet_since, at("2026-10-02T09:00:00Z"));
    }

    #[test]
    fn quiet_clock_never_predates_ready_for_review() {
        let pr = derive_one(json!({ "timelineItems": { "nodes": [
            comment(user("reviewer"), "2026-10-02T09:00:00Z"),
            ready("2026-10-04T09:00:00Z"),
        ] } }));
        assert_eq!(pr.quiet_since, at("2026-10-04T09:00:00Z"));
    }

    #[test]
    fn quiet_clock_defaults_to_open_clock() {
        let pr =
            derive_one(json!({ "timelineItems": { "nodes": [ready("2026-10-02T09:00:00Z")] } }));
        assert_eq!(pr.quiet_since, pr.open_since);
    }

    #[test]
    fn changes_requested_needs_action() {
        let pr = derive_one(json!({
            "reviewDecision": "CHANGES_REQUESTED",
            "latestOpinionatedReviews": { "nodes": [review(user("rev"), "CHANGES_REQUESTED")] },
        }));
        assert_eq!(pr.group, Group::NeedsAction);
        assert_eq!(pr.actions, vec![Action::ChangesRequested]);
    }

    #[test]
    fn re_requesting_review_hands_the_ball_back() {
        let pr = derive_one(json!({
            "reviewDecision": "CHANGES_REQUESTED",
            "latestOpinionatedReviews": { "nodes": [review(user("rev"), "CHANGES_REQUESTED")] },
            "reviewRequests": { "nodes": [{ "requestedReviewer": user("rev") }] },
        }));
        assert_eq!(pr.group, Group::Waiting);
        assert!(pr.reviewers[0].rerequested);
    }

    fn feedback(extra: Vec<Value>) -> PrView {
        let mut items = vec![timeline_review(user("rev"), "2026-10-03T09:00:00Z")];
        items.extend(extra);
        derive_one(json!({ "timelineItems": { "nodes": items } }))
    }

    #[test]
    fn a_comment_review_is_new_feedback() {
        let pr = feedback(vec![]);
        assert_eq!(pr.group, Group::NeedsAction);
        assert_eq!(pr.actions, vec![Action::NewFeedback]);
    }

    #[test]
    fn a_conversation_comment_is_new_feedback() {
        let pr = derive_one(json!({ "timelineItems": { "nodes": [
            comment(user("rev"), "2026-10-03T09:00:00Z"),
        ] } }));
        assert_eq!(pr.actions, vec![Action::NewFeedback]);
    }

    #[test]
    fn replying_pushing_or_re_requesting_answers_feedback() {
        let replied = feedback(vec![comment(user("author"), "2026-10-03T10:00:00Z")]);
        assert_eq!(replied.group, Group::Waiting);

        let thread_reply = feedback(vec![timeline_review(
            user("author"),
            "2026-10-03T10:00:00Z",
        )]);
        assert_eq!(thread_reply.group, Group::Waiting);

        let re_requested = feedback(vec![json!({
            "__typename": "ReviewRequestedEvent",
            "createdAt": "2026-10-03T10:00:00Z",
        })]);
        assert_eq!(re_requested.group, Group::Waiting);

        let pushed = derive_one(json!({
            "commits": { "nodes": [commit("2026-10-03T10:00:00Z", "SUCCESS")] },
            "timelineItems": { "nodes": [timeline_review(user("rev"), "2026-10-03T09:00:00Z")] },
        }));
        assert_eq!(pushed.group, Group::Waiting);
    }

    #[test]
    fn bots_approvals_and_change_requests_are_not_new_feedback() {
        let bot_comment = derive_one(json!({ "timelineItems": { "nodes": [
            comment(bot("github-actions"), "2026-10-03T09:00:00Z"),
        ] } }));
        assert_eq!(bot_comment.group, Group::Waiting);

        let approval = derive_one(json!({ "timelineItems": { "nodes": [
            timeline_review_with(user("rev"), "APPROVED", "2026-10-03T09:00:00Z"),
        ] } }));
        assert!(!approval.actions.contains(&Action::NewFeedback));

        let changes = derive_one(json!({
            "reviewDecision": "CHANGES_REQUESTED",
            "latestOpinionatedReviews": { "nodes": [review(user("rev"), "CHANGES_REQUESTED")] },
            "timelineItems": { "nodes": [comment(user("rev"), "2026-10-03T09:00:00Z")] },
        }));
        assert_eq!(changes.actions, vec![Action::ChangesRequested]);
    }

    #[test]
    fn approved_and_green_is_ready_to_merge() {
        let pr = derive_one(json!({
            "reviewDecision": "APPROVED",
            "latestOpinionatedReviews": { "nodes": [review(user("rev"), "APPROVED")] },
        }));
        assert_eq!(pr.actions, vec![Action::ReadyToMerge]);
    }

    #[test]
    fn approval_counts_when_repo_has_no_required_reviews() {
        let pr = derive_one(json!({
            "reviewDecision": null,
            "latestOpinionatedReviews": { "nodes": [review(user("rev"), "APPROVED")] },
        }));
        assert_eq!(pr.actions, vec![Action::ReadyToMerge]);
    }

    #[test]
    fn approval_short_of_required_count_is_not_ready() {
        let pr = derive_one(json!({
            "reviewDecision": "REVIEW_REQUIRED",
            "latestOpinionatedReviews": { "nodes": [review(user("rev"), "APPROVED")] },
        }));
        assert_eq!(pr.group, Group::Waiting);
    }

    #[test]
    fn conflicts_and_failing_ci_block_merge() {
        let pr = derive_one(json!({
            "reviewDecision": "APPROVED",
            "mergeable": "CONFLICTING",
            "commits": { "nodes": [commit("2026-10-01T09:00:00Z", "FAILURE")] },
        }));
        assert_eq!(pr.actions, vec![Action::Conflicts, Action::CiFailing]);
    }

    #[test]
    fn approved_prs_get_their_own_group_and_keep_their_actions() {
        let pr = derive_one(json!({ "reviewDecision": "APPROVED", "mergeable": "CONFLICTING" }));
        assert_eq!(pr.group, Group::Approved);
        assert_eq!(pr.actions, vec![Action::Conflicts]);
        assert!(pr.needs_author());

        let approved_draft = derive_one(json!({ "reviewDecision": "APPROVED", "isDraft": true }));
        assert_eq!(approved_draft.group, Group::Draft);
    }

    #[test]
    fn unknown_merge_state_is_not_ready() {
        let pr = derive_one(json!({
            "reviewDecision": "APPROVED",
            "mergeable": "UNKNOWN",
            "mergeStateStatus": "UNKNOWN",
        }));
        assert!(pr.actions.is_empty());
    }

    #[test]
    fn running_checks_are_not_ready_yet() {
        let pr = derive_one(json!({
            "reviewDecision": "APPROVED",
            "mergeStateStatus": "BLOCKED",
            "commits": { "nodes": [commit("2026-10-01T09:00:00Z", "PENDING")] },
        }));
        assert_eq!(pr.group, Group::Approved);
        assert_eq!(pr.checks, Checks::Pending);
        assert!(pr.actions.is_empty());
    }

    #[test]
    fn branch_protection_blocking_merge_is_not_ready() {
        let pr = derive_one(json!({ "reviewDecision": "APPROVED", "mergeStateStatus": "BLOCKED" }));
        assert!(pr.actions.is_empty());
        assert!(!pr.needs_author());
    }

    #[test]
    fn auto_merge_means_nothing_to_do() {
        let pr = derive_one(json!({
            "reviewDecision": "APPROVED",
            "autoMergeRequest": { "enabledAt": "2026-10-02T09:00:00Z" },
        }));
        assert!(pr.actions.is_empty());
        assert!(pr.auto_merge);
    }

    #[test]
    fn auto_merge_does_not_hide_what_blocks_it() {
        let pr = derive_one(json!({
            "reviewDecision": "APPROVED",
            "autoMergeRequest": { "enabledAt": "2026-10-02T09:00:00Z" },
            "commits": { "nodes": [commit("2026-10-01T09:00:00Z", "FAILURE")] },
        }));
        assert_eq!(pr.actions, vec![Action::CiFailing]);
    }

    #[test]
    fn drafts_never_need_action() {
        let pr = derive_one(json!({ "isDraft": true, "mergeable": "CONFLICTING" }));
        assert_eq!(pr.group, Group::Draft);
        assert_eq!(pr.actions, vec![Action::Conflicts]);
    }

    #[test]
    fn untouched_for_a_month_is_dormant() {
        let pr = derive_one(json!({
            "createdAt": "2026-08-01T09:00:00Z",
            "mergeable": "CONFLICTING",
            "commits": { "nodes": [commit("2026-08-01T09:00:00Z", "FAILURE")] },
            "timelineItems": { "nodes": [comment(bot("github-actions"), "2026-10-09T09:00:00Z")] },
        }));
        assert_eq!(pr.group, Group::Dormant);
        assert_eq!(pr.last_activity, at("2026-08-01T09:00:00Z"));
    }

    #[test]
    fn a_push_or_own_comment_keeps_it_alive() {
        let pushed = derive_one(json!({
            "createdAt": "2026-08-01T09:00:00Z",
            "commits": { "nodes": [commit("2026-10-05T09:00:00Z", "SUCCESS")] },
        }));
        assert_eq!(pushed.group, Group::Waiting);

        let commented = derive_one(json!({
            "createdAt": "2026-08-01T09:00:00Z",
            "commits": { "nodes": [commit("2026-08-01T09:00:00Z", "SUCCESS")] },
            "timelineItems": { "nodes": [comment(user("author"), "2026-10-05T09:00:00Z")] },
        }));
        assert_eq!(commented.group, Group::Waiting);
    }

    #[test]
    fn dormant_drafts_stay_drafts() {
        let pr = derive_one(json!({
            "isDraft": true,
            "createdAt": "2026-08-01T09:00:00Z",
            "commits": { "nodes": [commit("2026-08-01T09:00:00Z", "SUCCESS")] },
        }));
        assert_eq!(pr.group, Group::Draft);
    }

    #[test]
    fn snoozing_takes_a_pr_out_of_needs_action_until_it_expires() {
        let pr = || with(json!({ "mergeable": "CONFLICTING" }));
        let mut snoozed = HashMap::new();

        snoozed.insert("PR_1".to_string(), at("2026-10-12T09:00:00Z"));
        let view = derive_snoozed(vec![pr()], &[], &snoozed).remove(0);
        assert_eq!(view.group, Group::Snoozed);
        assert_eq!(view.snoozed_until, Some(at("2026-10-12T09:00:00Z")));

        snoozed.insert("PR_1".to_string(), at("2026-10-09T09:00:00Z"));
        let view = derive_snoozed(vec![pr()], &[], &snoozed).remove(0);
        assert_eq!(view.group, Group::NeedsAction);
        assert_eq!(view.snoozed_until, None);
    }

    #[test]
    fn responses_are_other_humans_reviews_and_comments_in_order() {
        let pr = derive_one(json!({ "timelineItems": { "nodes": [
            timeline_review_with(user("rev"), "APPROVED", "2026-10-03T09:00:00Z"),
            comment(user("other"), "2026-10-02T09:00:00Z"),
            timeline_review_with(user("author"), "COMMENTED", "2026-10-04T09:00:00Z"),
            comment(bot("github-actions"), "2026-10-05T09:00:00Z"),
            timeline_review_with(user("rev"), "DISMISSED", "2026-10-06T09:00:00Z"),
        ] } }));
        let responses: Vec<(&str, ResponseKind)> = pr
            .responses
            .iter()
            .map(|r| (r.login.as_str(), r.kind))
            .collect();
        assert_eq!(
            responses,
            vec![
                ("other", ResponseKind::Commented),
                ("rev", ResponseKind::Approved)
            ]
        );
    }

    #[test]
    fn reviewer_breakdown() {
        let ignored = vec!["kibanamachine".to_string()];
        let pr = derive_with(
            json!({
                "latestOpinionatedReviews": { "nodes": [review(user("approver"), "APPROVED")] },
                "latestReviews": { "nodes": [
                    review(user("approver"), "COMMENTED"),
                    review(user("commenter"), "COMMENTED"),
                    review(bot("infra-vault"), "COMMENTED"),
                    review(user("author"), "COMMENTED"),
                ] },
                "reviewRequests": { "nodes": [
                    { "requestedReviewer": { "__typename": "Team", "slug": "frontend" } },
                    { "requestedReviewer": bot("copilot-pull-request-reviewer") },
                    { "requestedReviewer": user("kibanamachine") },
                ] },
            }),
            &ignored,
        );
        let summary: Vec<(&str, ReviewerKind, ReviewerState)> = pr
            .reviewers
            .iter()
            .map(|r| (r.login.as_str(), r.kind, r.state))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("approver", ReviewerKind::User, ReviewerState::Approved),
                ("commenter", ReviewerKind::User, ReviewerState::Commented),
                ("@frontend", ReviewerKind::Team, ReviewerState::Pending),
                (
                    "copilot-pull-request-reviewer",
                    ReviewerKind::Bot,
                    ReviewerState::Pending
                ),
            ]
        );
    }

    #[test]
    fn sorts_by_group_then_urgency_then_staleness() {
        let prs = vec![
            with(json!({ "id": "draft", "isDraft": true })),
            with(json!({
                "id": "dormant",
                "createdAt": "2026-08-01T09:00:00Z",
                "commits": { "nodes": [commit("2026-08-01T09:00:00Z", "SUCCESS")] },
            })),
            with(json!({ "id": "waiting-new", "createdAt": "2026-10-05T09:00:00Z" })),
            with(json!({ "id": "waiting-old", "createdAt": "2026-10-02T09:00:00Z" })),
            with(json!({ "id": "ready", "reviewDecision": "APPROVED" })),
            with(json!({
                "id": "approved-pending",
                "reviewDecision": "APPROVED",
                "mergeStateStatus": "BLOCKED",
            })),
            with(json!({ "id": "conflict", "mergeable": "CONFLICTING" })),
            with(json!({
                "id": "conflict-old",
                "mergeable": "CONFLICTING",
                "createdAt": "2026-09-28T09:00:00Z",
            })),
        ];
        let ids: Vec<String> = derive_all(prs, &[]).into_iter().map(|p| p.id).collect();
        assert_eq!(
            ids,
            vec![
                "ready",
                "approved-pending",
                "conflict",
                "conflict-old",
                "waiting-new",
                "waiting-old",
                "dormant",
                "draft"
            ]
        );
    }
}
