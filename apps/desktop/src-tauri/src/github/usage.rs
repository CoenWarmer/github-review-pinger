//! What each GitHub request costs, to see where the rate limit goes. Every attempt
//! is one line in `api-usage.jsonl` in the log folder, read by
//! `apps/desktop/scripts/api-usage.mjs`. It holds no token or response, only what
//! was asked for and what GitHub says it cost.

use std::fs::{self, OpenOptions};
use std::future::Future;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use chrono::Utc;
use reqwest::header::HeaderMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The alias of the cost field added to each query, taken out of the reply again
/// since some callers read every key of `data`.
const COST_FIELD: &str = "pingerUsage";
/// Asking for this costs nothing.
const COST_SELECTION: &str =
    "pingerUsage: rateLimit { cost nodeCount limit remaining used resetAt } ";
/// The file is started over past this, keeping the previous one.
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

static LOG: OnceLock<Mutex<PathBuf>> = OnceLock::new();

tokio::task_local! {
    /// What set off the request, and which run of it.
    static TRIGGER: (&'static str, u64);
}

/// Starts writing to `path`. Without this nothing is written.
pub fn init(path: PathBuf) {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = LOG.set(Mutex::new(path));
}

/// Marks every request made by `work` as set off by `trigger`, as one run.
pub async fn during<F: Future>(trigger: &'static str, work: F) -> F::Output {
    // Its start, so a run's number stays its own across restarts.
    let cycle = Utc::now().timestamp_millis().unsigned_abs();
    TRIGGER.scope((trigger, cycle), work).await
}

fn start_of_selection(query: &str) -> Option<usize> {
    // The operation, whatever comes before it: comments, or fragments.
    let mut offset = 0;
    let operation = query.split_inclusive('\n').find_map(|line| {
        let at = offset;
        offset += line.len();
        line.trim_start().starts_with("query").then_some(at)
    })?;
    let mut parens = 0;
    for (i, c) in query[operation..].char_indices() {
        match c {
            '(' => parens += 1,
            ')' => parens -= 1,
            '{' if parens == 0 => return Some(operation + i + 1),
            _ => {}
        }
    }
    None
}

/// `query` also asking what it cost. One it can't place that in is left as it is.
pub fn with_cost(query: &str) -> String {
    match start_of_selection(query) {
        Some(at) => format!("{} {COST_SELECTION}{}", &query[..at], &query[at..]),
        None => query.to_string(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cost {
    pub cost: u64,
    pub node_count: u64,
    pub limit: u64,
    pub remaining: u64,
    pub used: u64,
    pub reset_at: String,
}

/// Takes the cost back out of a reply, leaving what the caller asked for.
pub fn take_cost(reply: &mut Value) -> Option<Cost> {
    let field = reply.get_mut("data")?.as_object_mut()?.remove(COST_FIELD)?;
    serde_json::from_value(field).ok()
}

/// A name for the query: its own, or else the first thing it asks for, as some
/// are built on the fly with an alias per item.
pub fn label(query: &str) -> String {
    let Some(at) = start_of_selection(query) else {
        return "unknown".to_string();
    };
    let head = query[..at].trim_start();
    let named = head
        .lines()
        .find_map(|line| line.trim_start().strip_prefix("query "))
        .map(|rest| rest.split(['(', '{', ' ']).next().unwrap_or(""))
        .filter(|name| !name.is_empty());
    if let Some(name) = named {
        return name.to_string();
    }
    // `a0: organization(login: ...)` or `viewer {`.
    let rest = query[at..].trim_start();
    let first = rest.split(['(', '{', '\n']).next().unwrap_or("");
    let field = first.rsplit(':').next().unwrap_or(first).trim();
    let inner: String = rest
        .chars()
        .skip_while(|c| *c != '{')
        .skip(1)
        .take_while(|c| *c != '(' && *c != '{')
        .collect();
    let inner = inner.trim();
    if inner.is_empty() {
        field.to_string()
    } else {
        format!(
            "{field}.{}",
            inner.rsplit(':').next().unwrap_or(inner).trim()
        )
    }
}

/// Whether GitHub turned this down for a rate limit, and which. `primary` is the
/// hourly budget running out; `secondary` is asking too much, too fast.
pub fn rejection(headers: &HeaderMap, status: u16, messages: &str) -> Option<&'static str> {
    let text = messages.to_lowercase();
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    if text.contains("secondary rate limit")
        || text.contains("abuse")
        || header("retry-after").is_some()
    {
        return Some("secondary");
    }
    if text.contains("rate limit")
        || ((status == 403 || status == 429) && header("x-ratelimit-remaining") == Some("0"))
    {
        return Some("primary");
    }
    (status == 429).then_some("secondary")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry<'a> {
    pub at: String,
    pub trigger: &'static str,
    pub cycle: u64,
    pub op: &'a str,
    pub attempt: u32,
    pub status: u16,
    pub ms: u128,
    pub bytes: usize,
    /// How many PRs it asked about, for those that ask by id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ids: Option<usize>,
    /// What it searched for, for those that search.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub q: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<Cost>,
    /// Headers GitHub always sends, so a rejected request still says.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header_used: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header_remaining: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header_resource: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejected: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_types: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The fields every entry has, from a request and its response headers.
pub struct Attempt<'a> {
    pub op: &'a str,
    pub variables: &'a Value,
    pub attempt: u32,
    pub ms: u128,
}

impl Attempt<'_> {
    pub fn entry(&self, status: u16, bytes: usize, headers: Option<&HeaderMap>) -> Entry<'_> {
        let (trigger, cycle) = TRIGGER
            .try_with(|current| *current)
            .unwrap_or(("on-demand", 0));
        let header = |name: &str| {
            headers
                .and_then(|h| h.get(name))
                .and_then(|v| v.to_str().ok())
        };
        let number = |name: &str| header(name).and_then(|v| v.parse().ok());
        Entry {
            at: Utc::now().to_rfc3339(),
            trigger,
            cycle,
            op: self.op,
            attempt: self.attempt,
            status,
            ms: self.ms,
            bytes,
            ids: self
                .variables
                .get("ids")
                .and_then(Value::as_array)
                .map(Vec::len),
            q: self
                .variables
                .get("q")
                .and_then(Value::as_str)
                .map(str::to_string),
            cost: None,
            header_used: number("x-ratelimit-used"),
            header_remaining: number("x-ratelimit-remaining"),
            header_resource: header("x-ratelimit-resource").map(str::to_string),
            retry_after: header("retry-after").map(str::to_string),
            rejected: None,
            error_types: None,
            error: None,
        }
    }
}

/// Adds a line to the file. Measuring must never get in the way of the request.
pub fn record(entry: &Entry<'_>) {
    let Some(log) = LOG.get() else {
        return;
    };
    let Ok(line) = serde_json::to_string(entry) else {
        return;
    };
    let Ok(path) = log.lock() else {
        return;
    };
    if fs::metadata(&*path).is_ok_and(|file| file.len() > MAX_LOG_BYTES) {
        let _ = fs::rename(&*path, path.with_extension("previous.jsonl"));
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&*path) {
        let _ = writeln!(file, "{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;
    use serde_json::json;

    /// Everything before the first `{` of the operation stays, and the field comes first.
    fn asks_for_cost(query: &str) {
        let with = with_cost(query);
        assert!(with.contains(COST_SELECTION), "no cost in: {query}");
        let at = with.find(COST_FIELD).unwrap();
        let opening = with[..at].rfind('{').unwrap();
        let operation = with[..opening].rfind("query").unwrap();
        assert!(
            !with[operation..opening].contains('}'),
            "misplaced in: {query}"
        );
        assert_eq!(with.replace(&format!(" {COST_SELECTION}"), ""), query);
    }

    #[test]
    fn adds_the_cost_to_every_query_the_app_sends() {
        let documents = [
            include_str!("../../../../../crates/core/src/github/details.graphql"),
            include_str!("../../../../../crates/core/src/github/merge_state.graphql"),
            include_str!("../../../../../crates/core/src/github/merged_search.graphql"),
            include_str!("../../../../../crates/core/src/github/merged.graphql"),
            include_str!("../../../../../crates/core/src/github/pr_details.graphql"),
            include_str!("../../../../../crates/core/src/github/pr_search.graphql"),
            include_str!("../../../../../crates/core/src/github/review_comment.graphql"),
            include_str!("../../../../../crates/core/src/github/search.graphql"),
            include_str!("../../../../../crates/core/src/github/stats_merged.graphql"),
        ];
        for document in documents {
            asks_for_cost(document);
        }
        let fragment = include_str!("../../../../../crates/core/src/github/pull_request.graphql");
        asks_for_cost(&format!("{}\n{fragment}", documents[0]));
        asks_for_cost(&format!("{fragment}\n{}", documents[0]));
        asks_for_cost("query {\n  a0: organization(login: \"o\") { id }\n}");
        asks_for_cost("query($q: String!, $n: Int = 5) { search(query: $q) { nodes { id } } }");
    }

    #[test]
    fn leaves_what_it_cannot_place_alone() {
        let fragment = include_str!("../../../../../crates/core/src/github/pull_request.graphql");
        assert_eq!(with_cost(fragment), fragment);
        assert_eq!(with_cost(""), "");
    }

    #[test]
    fn takes_the_cost_back_out_leaving_the_rest() {
        let mut reply = json!({ "data": {
            "a0": { "id": 1 },
            COST_FIELD: { "cost": 3, "nodeCount": 120, "limit": 5000, "remaining": 4000,
                "used": 1000, "resetAt": "2026-11-03T14:00:00Z" },
        } });
        let cost = take_cost(&mut reply).unwrap();
        assert_eq!((cost.cost, cost.node_count, cost.used), (3, 120, 1000));
        assert_eq!(reply, json!({ "data": { "a0": { "id": 1 } } }));
        assert_eq!(take_cost(&mut json!({ "data": null })), None);
        assert_eq!(take_cost(&mut json!({ "errors": [] })), None);
    }

    #[test]
    fn names_queries() {
        assert_eq!(
            label("query MergeStates($ids: [ID!]!) {\n nodes(ids: $ids) { id } }"),
            "MergeStates"
        );
        assert_eq!(
            label("# about this\nquery OpenPullRequestIds($q: String!) { search { x } }"),
            "OpenPullRequestIds"
        );
        assert_eq!(
            label("query($q: String!) { search(query: $q) { nodes { id } } }"),
            "search.nodes"
        );
        assert_eq!(
            label("query {\n a0: organization(login: \"o\") { team(slug: \"t\") { id } }\n}"),
            "organization.team"
        );
        assert_eq!(label("fragment Only on PullRequest { id }"), "unknown");
    }

    #[test]
    fn tells_the_two_rate_limits_apart() {
        let none = HeaderMap::new();
        let mut retry = HeaderMap::new();
        retry.insert("retry-after", HeaderValue::from_static("60"));
        let mut empty = HeaderMap::new();
        empty.insert("x-ratelimit-remaining", HeaderValue::from_static("0"));

        assert_eq!(
            rejection(&none, 200, "API rate limit already exceeded for user ID 1."),
            Some("primary")
        );
        assert_eq!(rejection(&empty, 403, ""), Some("primary"));
        assert_eq!(rejection(&retry, 403, ""), Some("secondary"));
        assert_eq!(
            rejection(&none, 403, "You have exceeded a secondary rate limit."),
            Some("secondary")
        );
        assert_eq!(rejection(&none, 429, ""), Some("secondary"));
        assert_eq!(rejection(&none, 200, "Could not resolve to a node"), None);
        assert_eq!(rejection(&none, 502, ""), None);
    }
}
