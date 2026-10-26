pub mod types;

use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::{StatusCode, header};
use serde::Deserialize;
use serde_json::json;

use types::PullRequest;

const ENDPOINT: &str = "https://api.github.com/graphql";
const QUERY: &str = include_str!("query.graphql");
const SEARCH: &str = "is:pr is:open author:@me archived:false";
const PAGE_SIZE: u32 = 25;
const MAX_PAGES: usize = 10;
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

pub async fn fetch_open_pull_requests(
    http: &reqwest::Client,
    token: &str,
) -> Result<Fetched, FetchError> {
    let mut fetched = Fetched {
        viewer: String::new(),
        pull_requests: Vec::new(),
        sso_partial: false,
    };
    let mut cursor: Option<String> = None;

    for _ in 0..MAX_PAGES {
        let page = fetch_page(http, token, cursor.as_deref()).await?;
        fetched.viewer = page.data.viewer.login;
        fetched.sso_partial |= page.sso_partial;
        fetched
            .pull_requests
            .extend(page.data.search.nodes.into_iter().flatten());

        let info = page.data.search.page_info;
        match info.end_cursor {
            Some(next) if info.has_next_page => cursor = Some(next),
            _ => break,
        }
    }

    Ok(fetched)
}

struct Page {
    data: Data,
    sso_partial: bool,
}

#[derive(Deserialize)]
struct Response {
    data: Option<Data>,
    #[serde(default)]
    errors: Vec<GraphqlError>,
}

#[derive(Deserialize)]
struct GraphqlError {
    #[serde(rename = "type")]
    kind: Option<String>,
    message: String,
}

#[derive(Deserialize)]
struct Data {
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
    nodes: Vec<Option<PullRequest>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

async fn fetch_page(
    http: &reqwest::Client,
    token: &str,
    cursor: Option<&str>,
) -> Result<Page, FetchError> {
    let body = json!({
        "query": QUERY,
        "variables": { "q": SEARCH, "first": PAGE_SIZE, "cursor": cursor },
    });

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

        // The search query is heavy and GitHub occasionally times out with a 502.
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

    let parsed: Response = response
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
            Ok(Page { data, sso_partial })
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
        };
        for pr in prs::derive(fetched.pull_requests, &fetched.viewer, &rules, Utc::now()) {
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
