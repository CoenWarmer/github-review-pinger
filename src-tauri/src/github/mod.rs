pub mod types;

use std::collections::HashMap;
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures_util::{StreamExt, TryStreamExt, stream};
use reqwest::{StatusCode, header};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use types::{CheckState, MergeStateStatus, Mergeable, PullRequest, ReviewDecision, ReviewState};

const ENDPOINT: &str = "https://api.github.com/graphql";
const SEARCH_QUERY: &str = include_str!("search.graphql");
const DETAILS_QUERY: &str = concat!(
    include_str!("details.graphql"),
    include_str!("pull_request.graphql")
);
const MERGE_STATE_QUERY: &str = include_str!("merge_state.graphql");
const SEARCH: &str = "is:pr is:open author:@me archived:false";
const MAX_SEARCH_PAGES: usize = 10;
/// Small enough that each request finishes well inside GitHub's ~10 s
/// GraphQL timeout; batches run concurrently.
const BATCH_SIZE: usize = 10;
const MAX_CONCURRENT: usize = 8;
const MAX_ATTEMPTS: u32 = 3;

pub struct Fetched {
    pub viewer: String,
    pub pull_requests: Vec<PullRequest>,
    /// GitHub omitted results from orgs whose SAML SSO the token isn't authorized for.
    pub sso_partial: bool,
}

#[derive(Debug)]
pub enum FetchError {
    Unauthorized,
    RateLimited { reset_at: Option<DateTime<Utc>> },
    Network(String),
    Api(String),
}

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("review-pinger/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(30))
        .build()
        .expect("HTTP client configuration is valid")
}

/// Fetches in three steps, because a single search query with all fields
/// takes long enough to hit GitHub's timeout: list the open PR ids, fetch
/// their details in concurrent batches, then fetch the expensive merge state
/// only for PRs that could be ready to merge.
pub async fn fetch_open_pull_requests(
    http: &reqwest::Client,
    token: &str,
) -> Result<Fetched, FetchError> {
    let (viewer, ids, sso_partial) = search_ids(http, token).await?;

    let mut pull_requests: Vec<PullRequest> = in_batches(
        http,
        token,
        DETAILS_QUERY,
        &ids,
        |nodes: Nodes<PullRequest>| nodes.nodes,
    )
    .await?;

    let candidates: Vec<String> = pull_requests
        .iter()
        .filter(|pr| could_be_ready(pr))
        .map(|pr| pr.id.clone())
        .collect();
    let merge_states: HashMap<String, MergeStateStatus> = in_batches(
        http,
        token,
        MERGE_STATE_QUERY,
        &candidates,
        |nodes: Nodes<MergeState>| nodes.nodes,
    )
    .await?
    .into_iter()
    .map(|state| (state.id, state.merge_state_status))
    .collect();
    for pr in &mut pull_requests {
        pr.merge_state_status = merge_states.get(&pr.id).copied();
    }

    Ok(Fetched {
        viewer,
        pull_requests,
        sso_partial,
    })
}

/// Approved, mergeable, green, and not already auto-merging: the only PRs
/// whose ready-to-merge verdict depends on `mergeStateStatus`. Mirrors the
/// other conditions of the rule in `prs::actions`.
fn could_be_ready(pr: &PullRequest) -> bool {
    let approved = match pr.review_decision {
        Some(ReviewDecision::Approved) => true,
        None => pr
            .latest_opinionated_reviews
            .iter()
            .flat_map(|nodes| nodes.iter())
            .any(|review| review.state == ReviewState::Approved),
        _ => false,
    };
    let checks_ok = pr
        .commits
        .iter()
        .last()
        .and_then(|node| node.commit.status_check_rollup.as_ref())
        .is_none_or(|rollup| rollup.state == CheckState::Success);
    approved
        && checks_ok
        && !pr.is_draft
        && pr.mergeable != Mergeable::Conflicting
        && pr.auto_merge_request.is_none()
        && pr.merge_queue_entry.is_none()
}

async fn search_ids(
    http: &reqwest::Client,
    token: &str,
) -> Result<(String, Vec<String>, bool), FetchError> {
    let mut viewer = String::new();
    let mut ids = Vec::new();
    let mut sso_partial = false;
    let mut cursor: Option<String> = None;

    for _ in 0..MAX_SEARCH_PAGES {
        let page: Response<SearchData> = request(
            http,
            token,
            SEARCH_QUERY,
            json!({ "q": SEARCH, "cursor": cursor }),
        )
        .await?;
        viewer = page.data.viewer.login;
        sso_partial |= page.sso_partial;
        ids.extend(page.data.search.nodes.into_iter().flatten().map(|n| n.id));

        let info = page.data.search.page_info;
        match info.end_cursor {
            Some(next) if info.has_next_page => cursor = Some(next),
            _ => break,
        }
    }
    Ok((viewer, ids, sso_partial))
}

/// Runs `query` for `ids` in concurrent batches and collects the non-null nodes.
async fn in_batches<D, T>(
    http: &reqwest::Client,
    token: &str,
    query: &str,
    ids: &[String],
    nodes: impl Fn(D) -> Vec<Option<T>>,
) -> Result<Vec<T>, FetchError>
where
    D: DeserializeOwned,
{
    // Owned variables keep the stream's closure free of borrowed arguments,
    // which a Send future spawned on the runtime can't express.
    let variables: Vec<Value> = ids
        .chunks(BATCH_SIZE)
        .map(|chunk| json!({ "ids": chunk }))
        .collect();
    let batches: Vec<Response<D>> = stream::iter(variables)
        .map(|variables| request::<D>(http, token, query, variables))
        .buffer_unordered(MAX_CONCURRENT)
        .try_collect()
        .await?;
    Ok(batches
        .into_iter()
        .flat_map(|batch| nodes(batch.data))
        .flatten()
        .collect())
}

#[derive(Deserialize)]
struct Nodes<T> {
    nodes: Vec<Option<T>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergeState {
    id: String,
    merge_state_status: MergeStateStatus,
}

#[derive(Deserialize)]
struct SearchData {
    viewer: Viewer,
    search: Search,
}

#[derive(Deserialize)]
struct Viewer {
    login: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Search {
    page_info: PageInfo,
    nodes: Vec<Option<SearchNode>>,
}

#[derive(Deserialize)]
struct SearchNode {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

struct Response<D> {
    data: D,
    sso_partial: bool,
}

#[derive(Deserialize)]
struct Envelope<D> {
    data: Option<D>,
    #[serde(default)]
    errors: Vec<GraphqlError>,
}

#[derive(Deserialize)]
struct GraphqlError {
    #[serde(rename = "type")]
    kind: Option<String>,
    message: String,
}

async fn request<D: DeserializeOwned>(
    http: &reqwest::Client,
    token: &str,
    query: &str,
    variables: Value,
) -> Result<Response<D>, FetchError> {
    let body = json!({ "query": query, "variables": variables });

    let mut attempt = 0;
    let response = loop {
        attempt += 1;
        let response = http
            .post(ENDPOINT)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(|e| FetchError::Network(e.to_string()))?;

        // GitHub occasionally times out heavy queries with a 502.
        if response.status().is_server_error() && attempt < MAX_ATTEMPTS {
            log::warn!("GitHub returned {}, retrying", response.status());
            tokio::time::sleep(Duration::from_secs(2 * u64::from(attempt))).await;
            continue;
        }
        break response;
    };

    let status = response.status();
    let headers = response.headers().clone();

    if status == StatusCode::UNAUTHORIZED {
        return Err(FetchError::Unauthorized);
    }
    if let Some(reset_at) = rate_limit_reset(status, &headers) {
        return Err(FetchError::RateLimited { reset_at });
    }
    if !status.is_success() {
        return Err(FetchError::Api(format!("GitHub returned HTTP {status}")));
    }

    let sso_partial = headers
        .get("x-github-sso")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("partial-results"));

    let parsed: Envelope<D> = response
        .json()
        .await
        .map_err(|e| FetchError::Api(format!("Unexpected response from GitHub: {e}")))?;

    if parsed
        .errors
        .iter()
        .any(|e| e.kind.as_deref() == Some("RATE_LIMITED"))
    {
        return Err(FetchError::RateLimited { reset_at: None });
    }

    let messages = || {
        parsed
            .errors
            .iter()
            .map(|e| e.message.as_str())
            .collect::<Vec<_>>()
            .join("; ")
    };
    match parsed.data {
        Some(data) => {
            if !parsed.errors.is_empty() {
                log::warn!("GitHub returned partial data: {}", messages());
            }
            Ok(Response { data, sso_partial })
        }
        None => Err(FetchError::Api(messages())),
    }
}

/// Returns `Some` when the response is a primary or secondary rate-limit rejection.
fn rate_limit_reset(
    status: StatusCode,
    headers: &header::HeaderMap,
) -> Option<Option<DateTime<Utc>>> {
    if status != StatusCode::FORBIDDEN && status != StatusCode::TOO_MANY_REQUESTS {
        return None;
    }
    let header_num = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<i64>().ok())
    };

    if let Some(seconds) = header_num("retry-after") {
        return Some(Some(Utc::now() + chrono::Duration::seconds(seconds)));
    }
    if header_num("x-ratelimit-remaining") == Some(0) {
        return Some(header_num("x-ratelimit-reset").and_then(|t| DateTime::from_timestamp(t, 0)));
    }
    if status == StatusCode::TOO_MANY_REQUESTS {
        return Some(None);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{auth, prs};

    fn pr(overrides: Value) -> PullRequest {
        let mut pr = json!({
            "id": "PR_1",
            "number": 1,
            "title": "Title",
            "url": "https://github.com/o/r/pull/1",
            "isDraft": false,
            "createdAt": "2026-10-01T09:00:00Z",
            "reviewDecision": "APPROVED",
            "mergeable": "MERGEABLE",
            "autoMergeRequest": null,
            "repository": { "nameWithOwner": "o/r" },
            "commits": { "nodes": [{ "commit": {
                "committedDate": "2026-10-01T09:00:00Z",
                "statusCheckRollup": { "state": "SUCCESS" },
            } }] },
            "timelineItems": { "nodes": [] },
        });
        for (key, value) in overrides.as_object().unwrap() {
            pr[key] = value.clone();
        }
        serde_json::from_value(pr).unwrap()
    }

    #[test]
    fn merge_state_is_only_fetched_for_possible_merges() {
        assert!(could_be_ready(&pr(json!({}))));
        assert!(could_be_ready(&pr(json!({
            "reviewDecision": null,
            "latestOpinionatedReviews": { "nodes": [{ "state": "APPROVED", "author": null }] },
        }))));

        assert!(!could_be_ready(&pr(
            json!({ "reviewDecision": "REVIEW_REQUIRED" })
        )));
        assert!(!could_be_ready(&pr(json!({ "isDraft": true }))));
        assert!(!could_be_ready(&pr(json!({ "mergeable": "CONFLICTING" }))));
        assert!(!could_be_ready(&pr(
            json!({ "autoMergeRequest": { "enabledAt": null } })
        )));
        assert!(!could_be_ready(&pr(
            json!({ "mergeQueueEntry": { "position": 1 } })
        )));
        assert!(!could_be_ready(&pr(
            json!({ "commits": { "nodes": [{ "commit": {
            "committedDate": "2026-10-01T09:00:00Z",
            "statusCheckRollup": { "state": "PENDING" },
        } }] } })
        )));
    }

    /// Fetches the logged-in user's real pull requests. Run with
    /// `cargo test -- --ignored --nocapture live_fetch`.
    #[test]
    #[ignore = "calls the GitHub API with your gh token"]
    fn live_fetch() {
        let token = auth::resolve_token().expect("gh is logged in");
        let fetched =
            tauri::async_runtime::block_on(fetch_open_pull_requests(&http_client(), &token.value))
                .expect("fetch succeeds");
        println!(
            "{} open PRs for {}, sso_partial={}",
            fetched.pull_requests.len(),
            fetched.viewer,
            fetched.sso_partial
        );
        let ignored = ["kibanamachine".to_string(), "elasticmachine".to_string()];
        let rules = prs::Rules {
            ignored_logins: &ignored,
            dormant_after: chrono::Duration::days(30),
            snoozed: &Default::default(),
        };
        for pr in prs::derive(&fetched.pull_requests, &fetched.viewer, &rules, Utc::now()) {
            let reviewers: Vec<String> = pr
                .reviewers
                .iter()
                .map(|r| {
                    format!(
                        "{}:{:?}{}",
                        r.login,
                        r.state,
                        if r.rerequested { "↻" } else { "" }
                    )
                })
                .collect();
            println!(
                "{:?} {:?} {}#{} open={} quiet={} [{}]",
                pr.group,
                pr.actions,
                pr.repo,
                pr.number,
                pr.open_since.format("%m-%d"),
                pr.quiet_since.format("%m-%d"),
                reviewers.join(", ")
            );
        }
    }
}
