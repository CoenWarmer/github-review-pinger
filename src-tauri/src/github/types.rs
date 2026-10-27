//! Shapes returned by `query.graphql`. Enums carry an `Other` fallback so new
//! values GitHub adds don't break deserialization.

use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde::de::IgnoredAny;

#[derive(Debug, Deserialize)]
pub struct Nodes<T> {
    pub nodes: Vec<Option<T>>,
}

impl<T> Nodes<T> {
    pub fn iter(&self) -> impl Iterator<Item = &T> {
        self.nodes.iter().flatten()
    }
}

impl<T> Default for Nodes<T> {
    fn default() -> Self {
        Self { nodes: Vec::new() }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub id: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    /// `None` when the account was deleted.
    #[serde(default)]
    pub author: Option<Actor>,
    pub is_draft: bool,
    /// Merged or closed; only matters when a single PR is refreshed after
    /// the list was fetched.
    #[serde(default)]
    pub closed: bool,
    pub created_at: DateTime<Utc>,
    pub review_decision: Option<ReviewDecision>,
    pub mergeable: Mergeable,
    /// Not part of the details query; filled in afterwards for PRs that could
    /// be ready to merge, and `None` for the rest.
    #[serde(default)]
    pub merge_state_status: Option<MergeStateStatus>,
    /// Not part of the details query; set for PRs by others that came back
    /// from the `review-requested` search, i.e. a review is pending from the
    /// viewer or one of their teams.
    #[serde(default)]
    pub review_requested: bool,
    /// Only presence matters: auto-merge is enabled.
    pub auto_merge_request: Option<IgnoredAny>,
    /// Present while the PR sits in the repo's merge queue.
    #[serde(default)]
    pub merge_queue_entry: Option<MergeQueueEntry>,
    pub repository: Repository,
    pub commits: Nodes<CommitNode>,
    #[serde(default)]
    pub review_requests: Option<Nodes<ReviewRequest>>,
    #[serde(default)]
    pub latest_reviews: Option<Nodes<Review>>,
    #[serde(default)]
    pub latest_opinionated_reviews: Option<Nodes<Review>>,
    #[serde(default)]
    pub reviews: Nodes<Review>,
    pub timeline_items: Nodes<TimelineItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub name_with_owner: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewDecision {
    Approved,
    ChangesRequested,
    ReviewRequired,
    #[serde(other)]
    Other,
}

// Mirrors GitHub's MergeableState values.
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Mergeable {
    Mergeable,
    Conflicting,
    #[serde(other)]
    Unknown,
}

/// GitHub's overall verdict on whether the PR can be merged right now,
/// including branch protection (required checks and reviews).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MergeStateStatus {
    Clean,
    HasHooks,
    Unstable,
    Blocked,
    Behind,
    Dirty,
    Draft,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeQueueEntry {
    pub position: Option<u32>,
    /// GitHub's estimate, in seconds from the time of the query.
    pub estimated_time_to_merge: Option<i64>,
    pub enqueued_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct CommitNode {
    pub commit: Commit,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    /// Tells pushes apart, so a new push starts a new timing of the checks.
    #[serde(default)]
    pub oid: Option<String>,
    /// Updated by rebases and amends, so it approximates the last push.
    pub committed_date: DateTime<Utc>,
    pub status_check_rollup: Option<StatusCheckRollup>,
}

#[derive(Debug, Deserialize)]
pub struct StatusCheckRollup {
    pub state: CheckState,
    #[serde(default)]
    pub contexts: Option<Nodes<CheckContext>>,
}

/// One check on the head commit, reduced to what's needed for timing.
#[derive(Debug, Deserialize)]
#[serde(tag = "__typename", rename_all_fields = "camelCase")]
pub enum CheckContext {
    /// A GitHub Actions or other check run. Keeps its `started_at` once done.
    CheckRun {
        status: CheckRunStatus,
        started_at: Option<DateTime<Utc>>,
        completed_at: Option<DateTime<Utc>>,
    },
    /// A commit status, as reported by external CI such as Buildkite. Its
    /// `created_at` is when it last changed state, so it marks the start while
    /// pending and the finish once done.
    StatusContext {
        state: CheckState,
        created_at: DateTime<Utc>,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CheckRunStatus {
    Completed,
    #[serde(other)]
    Unfinished,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CheckState {
    Success,
    Pending,
    Expected,
    Failure,
    Error,
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    pub requested_reviewer: Option<RequestedReviewer>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "__typename")]
pub enum RequestedReviewer {
    User {
        login: String,
    },
    Bot {
        login: String,
    },
    Mannequin {
        login: String,
    },
    Team {
        slug: String,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
pub struct Review {
    pub state: ReviewState,
    /// `None` for pending reviews, and not requested for `latestReviews`.
    #[serde(default, rename = "submittedAt")]
    pub submitted_at: Option<DateTime<Utc>>,
    pub author: Option<Actor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewState {
    Approved,
    ChangesRequested,
    Commented,
    Dismissed,
    Pending,
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
pub struct Actor {
    #[serde(rename = "__typename")]
    pub typename: String,
    pub login: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "__typename", rename_all_fields = "camelCase")]
pub enum TimelineItem {
    ReadyForReviewEvent {
        created_at: DateTime<Utc>,
    },
    ReviewRequestedEvent {
        created_at: DateTime<Utc>,
        #[serde(default)]
        requested_reviewer: Option<RequestedReviewer>,
    },
    IssueComment {
        created_at: DateTime<Utc>,
        author: Option<Actor>,
    },
    #[serde(other)]
    Other,
}
