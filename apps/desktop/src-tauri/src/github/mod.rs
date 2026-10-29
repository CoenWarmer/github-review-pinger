pub use review_pinger_core::github::types;
use review_pinger_core::github::{
    DETAILS_QUERY, MERGE_STATE_QUERY, MERGED_QUERY, MERGED_SEARCH, MERGED_SEARCH_QUERY,
    PR_SEARCH_QUERY, SEARCH_QUERY, STATS_MERGED_QUERY,
};

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use chrono::{DateTime, NaiveDate, Utc};
use futures_util::{StreamExt, TryStreamExt, future, stream};
use reqwest::{StatusCode, header};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::sync::Semaphore;

use crate::directory::{Directory, Found, Needs};
use types::{
    CheckState, FoundPullRequest, MergeStateStatus, Mergeable, MergedPullRequest, PullRequest,
    ReviewDecision, ReviewState, SearchedPullRequest,
};

const ENDPOINT: &str = "https://api.github.com/graphql";
const AUTHORED: &str = "is:pr is:open author:@me archived:false";
const REVIEW_REQUESTED: &str = "is:pr is:open review-requested:@me -author:@me archived:false";
const MAX_SEARCH_PAGES: usize = 10;
/// Small enough that each request finishes well inside GitHub's ~10 s
/// GraphQL timeout; batches run concurrently.
const BATCH_SIZE: usize = 10;
const MAX_CONCURRENT: usize = 8;
const MAX_ATTEMPTS: u32 = 3;

pub struct Fetched {
    pub viewer: String,
    /// Open PRs the viewer authored.
    pub pull_requests: Vec<PullRequest>,
    /// Open PRs by others that the viewer is asked to review or already
    /// reviewed; `review_requested` tells which.
    pub review_pull_requests: Vec<PullRequest>,
    /// Each enabled custom view's matching PRs, by view id. A PR already in
    /// `pull_requests` or `review_pull_requests` that also matches a view
    /// shows up in both.
    pub view_pull_requests: HashMap<String, Vec<PullRequest>>,
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
/// only for the viewer's own PRs that could be ready to merge.
///
/// `reviewed_since` bounds the PRs the viewer reviewed earlier by last update;
/// requested reviews are never bounded, since they're still waiting.
///
/// With `on_partial`, the viewer's own PRs are fetched first and passed to it
/// as soon as they're in (without merge states, and with nothing else yet),
/// then everything else is fetched while the merge states are. That lets the
/// first screen show My PRs in roughly a third of the time.
pub async fn fetch_open_pull_requests(
    http: &reqwest::Client,
    token: &str,
    reviewed_since: NaiveDate,
    include_authored: bool,
    views: &[(String, String)],
    on_partial: Option<&(dyn Fn(&Fetched) + Send + Sync)>,
) -> Result<Fetched, FetchError> {
    let reviewed = format!(
        "is:pr is:open reviewed-by:@me -author:@me archived:false updated:>={reviewed_since}"
    );
    let authored_search = async {
        if include_authored {
            search_ids(http, token, AUTHORED).await
        } else {
            Ok(SearchResult::default())
        }
    };
    let view_searches = future::try_join_all(
        views
            .iter()
            .map(|(_, query)| search_ids(http, token, query)),
    );
    let (authored, requested, reviewed, view_results) = future::try_join4(
        authored_search,
        search_ids(http, token, REVIEW_REQUESTED),
        search_ids(http, token, &reviewed),
        view_searches,
    )
    .await?;
    let sso_partial = authored.sso_partial
        || requested.sso_partial
        || reviewed.sso_partial
        || view_results.iter().any(|r| r.sso_partial);
    let authored_ids: HashSet<String> = authored.ids.iter().cloned().collect();
    let requested_ids: HashSet<String> = requested.ids.iter().cloned().collect();
    let reviewed_ids: HashSet<String> = reviewed.ids.iter().cloned().collect();
    // Ids per view, kept apart from the union below so each view's PRs can
    // be picked back out of the one details fetch.
    let view_ids: Vec<(String, Vec<String>)> = views
        .iter()
        .zip(view_results)
        .map(|((id, _), result)| (id.clone(), result.ids))
        .collect();

    // A PR can be in several of these at once (requested and reviewed, or
    // any of them and a view too), so dedupe for the one details fetch.
    let mut seen = HashSet::new();
    let ids: Vec<String> = authored
        .ids
        .iter()
        .cloned()
        .chain(requested.ids.iter().cloned())
        .chain(reviewed.ids.iter().cloned())
        .chain(view_ids.iter().flat_map(|(_, ids)| ids.iter().cloned()))
        .filter(|id| seen.insert(id.clone()))
        .collect();

    let viewer = if authored.viewer.is_empty() {
        requested.viewer.clone()
    } else {
        authored.viewer.clone()
    };

    let mut by_id: HashMap<String, PullRequest>;
    // Only your own PRs get the expensive merge state; write it back before
    // anything clones from `by_id`, so a PR that's also in a view carries it.
    let mut pull_requests: Vec<PullRequest>;
    match on_partial.filter(|_| !authored.ids.is_empty()) {
        Some(on_partial) => {
            // Your own PRs and the rest share the request slots, with your
            // own asked for first: they finish first, and the rest starts in
            // the slots they leave idle instead of waiting for all of them.
            let limiter = Semaphore::new(MAX_CONCURRENT);
            let rest_ids: Vec<String> = ids
                .iter()
                .filter(|id| !authored_ids.contains(*id))
                .cloned()
                .collect();
            let mine = async {
                let mut own = details_sharing(http, token, &authored.ids, &limiter).await?;
                on_partial(&Fetched {
                    viewer: viewer.clone(),
                    pull_requests: own.clone(),
                    review_pull_requests: Vec::new(),
                    view_pull_requests: HashMap::new(),
                    sso_partial,
                });
                add_merge_states(http, token, &mut own).await?;
                Ok::<_, FetchError>(own)
            };
            let (own, rest) =
                future::try_join(mine, details_sharing(http, token, &rest_ids, &limiter)).await?;
            pull_requests = own;
            by_id = rest.into_iter().map(|pr| (pr.id.clone(), pr)).collect();
        }
        None => {
            let all = fetch_details(http, token, &ids).await?;
            by_id = all.into_iter().map(|pr| (pr.id.clone(), pr)).collect();
            pull_requests = authored_ids
                .iter()
                .filter_map(|id| by_id.get(id).cloned())
                .collect();
            add_merge_states(http, token, &mut pull_requests).await?;
        }
    }
    for pr in pull_requests.iter().cloned() {
        by_id.insert(pr.id.clone(), pr);
    }

    let mut review_pull_requests: Vec<PullRequest> = by_id
        .values()
        .filter(|pr| {
            !authored_ids.contains(&pr.id)
                && (requested_ids.contains(&pr.id) || reviewed_ids.contains(&pr.id))
        })
        .cloned()
        .collect();
    for pr in &mut review_pull_requests {
        pr.review_requested = requested_ids.contains(&pr.id);
    }

    let view_pull_requests: HashMap<String, Vec<PullRequest>> = view_ids
        .into_iter()
        .map(|(id, ids)| {
            let prs = ids
                .into_iter()
                .filter_map(|pr_id| by_id.get(&pr_id).cloned())
                .collect();
            (id, prs)
        })
        .collect();

    Ok(Fetched {
        // The authored search may have been skipped; the other two always
        // know who the viewer is.
        viewer,
        pull_requests,
        review_pull_requests,
        view_pull_requests,
        sso_partial,
    })
}

/// One page of your merged PRs, newest first. `cursor` continues from a
/// previous page's `end_cursor`; `None` starts from the top.
pub async fn fetch_merged_page(
    http: &reqwest::Client,
    token: &str,
    cursor: Option<String>,
    count: u32,
) -> Result<MergedPage, FetchError> {
    let page: Response<MergedSearchData> = request(
        http,
        token,
        MERGED_SEARCH_QUERY,
        json!({ "q": MERGED_SEARCH, "count": count, "cursor": cursor }),
    )
    .await?;
    let info = page.data.search.page_info;
    Ok(MergedPage {
        items: page.data.search.nodes.into_iter().flatten().collect(),
        has_next_page: info.has_next_page,
        end_cursor: info.end_cursor,
    })
}

pub struct MergedPage {
    pub items: Vec<MergedPullRequest>,
    pub has_next_page: bool,
    pub end_cursor: Option<String>,
}

#[derive(Deserialize)]
struct MergedSearchData {
    search: MergedSearch,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergedSearch {
    page_info: PageInfo,
    nodes: Vec<Option<MergedPullRequest>>,
}

/// The first page of PRs, in any state, matching what the user typed plus
/// whatever qualifiers they added. Results are newest-updated first.
pub async fn search_pull_requests(
    http: &reqwest::Client,
    token: &str,
    text: &str,
) -> Result<Vec<FoundPullRequest>, FetchError> {
    let page: Response<PrSearchData> = request(
        http,
        token,
        PR_SEARCH_QUERY,
        json!({ "q": format!("is:pr {text} sort:updated-desc"), "count": 20 }),
    )
    .await?;
    Ok(page
        .data
        .search
        .nodes
        .into_iter()
        .flatten()
        .map(Into::into)
        .collect())
}

#[derive(Deserialize)]
struct PrSearchData {
    search: Nodes<SearchedPullRequest>,
}

/// What the Statistics section is drawn from. Averages are worked out by the
/// UI from `sample`, the same way for every host.
#[derive(Debug, Default, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatsData {
    /// All of your PRs merged in the window, in any repo.
    pub merged_by_me: u64,
    /// Your PRs merged in the window in the chosen team's organization, which
    /// is the scope the team's count is in too; `None` with no team.
    pub merged_by_me_in_team_org: Option<u64>,
    /// PRs merged by the team's members in the window, when a team is chosen.
    pub merged_by_team: Option<u64>,
    /// The team has more members than are looked up, so its count is short.
    pub team_members_capped: bool,
    /// How many members of the team were looked up; 0 with no team.
    pub team_member_count: usize,
    /// Up to 100 of your merged PRs, newest first.
    pub sample: Vec<StatsSample>,
}

#[derive(Debug, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatsSample {
    /// When the first review was asked for, if ever.
    pub requested_at: Option<DateTime<Utc>>,
    pub reviews: Vec<StatsReview>,
}

#[derive(Debug, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatsReview {
    pub by: Option<String>,
    pub at: DateTime<Utc>,
}

/// GitHub rejects search text over 256 characters.
const MAX_SEARCH_CHARS: usize = 250;
/// How many members of a team are looked up: `MAX_MEMBER_PAGES` of 100.
const MEMBERS_READ_LIMIT: usize = MAX_MEMBER_PAGES * 100;

/// Search texts that count PRs merged since `since` in `org` by any of
/// `logins`: several `author:` qualifiers match any of them, but only so many
/// fit in one search, so the logins are split across as few as will hold them.
fn merged_by_searches(since: NaiveDate, org: &str, logins: &[String]) -> Vec<String> {
    let start = format!("is:pr is:merged merged:>={since} org:{org}");
    let mut searches = Vec::new();
    let mut current = start.clone();
    for login in logins {
        let author = format!(" author:{login}");
        if current != start && current.len() + author.len() > MAX_SEARCH_CHARS {
            searches.push(std::mem::replace(&mut current, start.clone()));
        }
        current += &author;
    }
    if current != start {
        searches.push(current);
    }
    searches
}

/// The statistics for the last window: your merged PRs, and when a team is
/// chosen (`org/slug`, which needs `read:org`) what its members merged.
pub async fn fetch_stats(
    http: &reqwest::Client,
    token: &str,
    team: Option<&str>,
    since: NaiveDate,
) -> Result<StatsData, FetchError> {
    let mine = async {
        let reply: Response<StatsMergedData> = request(
            http,
            token,
            STATS_MERGED_QUERY,
            json!({ "q": format!("is:pr is:merged author:@me merged:>={since} sort:updated-desc") }),
        )
        .await?;
        let search = reply.data.search;
        let sample = search
            .nodes
            .into_iter()
            .flatten()
            .map(|pr| StatsSample {
                requested_at: pr
                    .timeline_items
                    .nodes
                    .into_iter()
                    .flatten()
                    .find_map(|event| event.created_at),
                reviews: pr
                    .reviews
                    .nodes
                    .into_iter()
                    .flatten()
                    .filter_map(|review| {
                        Some(StatsReview {
                            by: review.author.map(|author| author.login),
                            at: review.submitted_at?,
                        })
                    })
                    .collect(),
            })
            .collect();
        Ok::<_, FetchError>((search.issue_count, sample))
    };
    let team_count = async {
        let Some(team) = team else {
            return Ok(TeamStats::default());
        };
        let Some((org, slug)) = team.split_once('/') else {
            return Err(FetchError::Api(format!("Not a team: {team}")));
        };
        let needs = Needs {
            teams: [(org.to_string(), slug.to_string())].into(),
        };
        let found = fetch_directory(http, token, &needs).await?;
        if found.denied {
            return Err(FetchError::Api(
                "Counting a team's merges needs the read:org scope.".into(),
            ));
        }
        let mut logins: Vec<String> = found
            .teams
            .get(&Directory::key(org, slug))
            .map(|members| members.iter().cloned().collect())
            .unwrap_or_default();
        logins.sort();
        // Members are read a page at a time up to a limit, so a team that
        // reaches it may have more.
        let capped = logins.len() >= MEMBERS_READ_LIMIT;
        let searches = merged_by_searches(since, org, &logins);
        // One request for all the counts, each its own aliased search: the
        // team's members in the org, and you in the same org.
        let mine = format!("is:pr is:merged author:@me merged:>={since} org:{org}");
        let quote = |text: &str| serde_json::to_string(text).expect("a string serializes");
        let query = format!(
            "query {{\nme: search(type: ISSUE, query: {}) {{ issueCount }}\n{}}}",
            quote(&mine),
            searches
                .iter()
                .enumerate()
                .map(|(i, text)| format!(
                    "s{i}: search(type: ISSUE, query: {}) {{ issueCount }}\n",
                    quote(text)
                ))
                .collect::<String>()
        );
        let reply: Response<Value> = request(http, token, &query, json!({})).await?;
        let total = (0..searches.len())
            .filter_map(|i| reply.data[format!("s{i}")]["issueCount"].as_u64())
            .sum();
        Ok(TeamStats {
            merged: Some(total),
            capped,
            members: logins.len(),
            mine_in_org: reply.data["me"]["issueCount"].as_u64(),
        })
    };
    let ((merged_by_me, sample), team_stats) = future::try_join(mine, team_count).await?;
    Ok(StatsData {
        merged_by_me,
        merged_by_me_in_team_org: team_stats.mine_in_org,
        merged_by_team: team_stats.merged,
        team_members_capped: team_stats.capped,
        team_member_count: team_stats.members,
        sample,
    })
}

/// What the team part of the statistics found.
#[derive(Default)]
struct TeamStats {
    merged: Option<u64>,
    capped: bool,
    members: usize,
    mine_in_org: Option<u64>,
}

#[derive(Deserialize)]
struct StatsMergedData {
    search: StatsMergedSearch,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatsMergedSearch {
    issue_count: u64,
    nodes: Vec<Option<StatsMergedPr>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatsMergedPr {
    timeline_items: Nodes<StatsRequested>,
    reviews: Nodes<StatsReviewNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatsRequested {
    created_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatsReviewNode {
    submitted_at: Option<DateTime<Utc>>,
    author: Option<StatsLogin>,
}

#[derive(Deserialize)]
struct StatsLogin {
    login: String,
}

/// The teams you belong to, as `org/slug`, across your organizations. Needs
/// `read:org`; without it the answer is an error saying so.
pub async fn fetch_my_teams(
    http: &reqwest::Client,
    token: &str,
) -> Result<Vec<String>, FetchError> {
    let orgs: Response<Value> = request(
        http,
        token,
        "query { viewer { login organizations(first: 50) { nodes { login } } } }",
        json!({}),
    )
    .await?;
    if orgs.scope_missing {
        return Err(FetchError::Api(
            "Listing your teams needs the read:org scope.".into(),
        ));
    }
    let viewer = orgs.data["viewer"]["login"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let org_logins: Vec<String> = orgs.data["viewer"]["organizations"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|org| org["login"].as_str().map(str::to_string))
        .collect();
    if org_logins.is_empty() {
        return Ok(Vec::new());
    }
    let quote = |s: &str| serde_json::to_string(s).expect("a string serializes");
    let query = format!(
        "query {{\n{}}}",
        org_logins
            .iter()
            .enumerate()
            .map(|(i, org)| format!(
                "o{i}: organization(login: {}) {{ login teams(first: 100, userLogins: [{}]) {{ nodes {{ slug }} }} }}\n",
                quote(org),
                quote(&viewer)
            ))
            .collect::<String>()
    );
    let reply: Response<Value> = request(http, token, &query, json!({})).await?;
    let mut teams: Vec<String> = (0..org_logins.len())
        .flat_map(|i| {
            let org = &reply.data[format!("o{i}")];
            let login = org["login"].as_str().unwrap_or_default().to_lowercase();
            org["teams"]["nodes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(move |team| {
                    team["slug"]
                        .as_str()
                        .map(|slug| Directory::key(&login, slug))
                })
                .collect::<Vec<_>>()
        })
        .collect();
    teams.sort();
    Ok(teams)
}

/// Fetches the details of specific pull requests, for refreshing a few
/// without searching again. Closed and merged ones come back with `closed` set.
pub async fn fetch_details(
    http: &reqwest::Client,
    token: &str,
    ids: &[String],
) -> Result<Vec<PullRequest>, FetchError> {
    in_batches(
        http,
        token,
        DETAILS_QUERY,
        ids,
        |nodes: Nodes<PullRequest>| nodes.nodes,
    )
    .await
}

/// Fills in `merge_state_status`, which is expensive, only for PRs that
/// could be ready to merge.
pub async fn add_merge_states(
    http: &reqwest::Client,
    token: &str,
    pull_requests: &mut [PullRequest],
) -> Result<(), FetchError> {
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
    for pr in pull_requests {
        pr.merge_state_status = merge_states.get(&pr.id).copied();
    }
    Ok(())
}

/// Which of `ids`, previously your own open PRs, are merged rather than just
/// closed. Called for the few that drop out of a poll's open search.
pub async fn fetch_merged(
    http: &reqwest::Client,
    token: &str,
    ids: &[String],
) -> Result<Vec<String>, FetchError> {
    let states: Vec<Merged> = in_batches(http, token, MERGED_QUERY, ids, |nodes: Nodes<Merged>| {
        nodes.nodes
    })
    .await?;
    Ok(states
        .into_iter()
        .filter(|state| state.merged)
        .map(|state| state.id)
        .collect())
}

/// Aliases per directory query, which keeps each query light.
/// Measured against a real account: 8 teams per query and 10 queries at once
/// looked up 75 teams in about 3.5 s, where 15 per query and 2 at once took
/// about 10 s.
const DIRECTORY_BATCH: usize = 8;
const DIRECTORY_CONCURRENT: usize = 10;
/// Members are read 100 at a time, so this reads teams of up to 500.
const MAX_MEMBER_PAGES: usize = 5;

/// What one directory query asks for: team members by alias, each with the
/// cache key it answers.
struct DirectoryQuery {
    text: String,
    teams: Vec<(String, String)>,
}

fn directory_queries(needs: &Needs) -> Vec<DirectoryQuery> {
    let teams: Vec<&(String, String)> = needs.teams.iter().collect();
    // JSON strings are valid GraphQL string literals.
    let quote = |s: &str| serde_json::to_string(s).expect("a string serializes");
    teams
        .chunks(DIRECTORY_BATCH)
        .map(|chunk| {
            let mut query = DirectoryQuery {
                text: String::new(),
                teams: Vec::new(),
            };
            for (i, (org, slug)) in chunk.iter().map(|team| (&team.0, &team.1)).enumerate() {
                query.text += &format!(
                    "t{i}: organization(login: {}) {{ team(slug: {}) {{ members(first: 100) {{ nodes {{ login }} pageInfo {{ hasNextPage endCursor }} }} }} }}\n",
                    quote(org),
                    quote(slug)
                );
                query.teams.push((format!("t{i}"), Directory::key(org, slug)));
            }
            query.text = format!("query {{\n{}}}", query.text);
            query
        })
        .collect()
}

/// The logins on a page of team members, and the cursor of the next page.
fn members_page(members: &Value) -> (Vec<String>, Option<String>) {
    let logins = members["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|node| node["login"].as_str())
        .map(str::to_lowercase)
        .collect();
    let info = &members["pageInfo"];
    let next = info["hasNextPage"]
        .as_bool()
        .unwrap_or(false)
        .then(|| info["endCursor"].as_str().map(str::to_string))
        .flatten();
    (logins, next)
}

/// Looks up the members of teams. Needs `read:org`; without it the answer is
/// `denied`.
pub async fn fetch_directory(
    http: &reqwest::Client,
    token: &str,
    needs: &Needs,
) -> Result<Found, FetchError> {
    let responses: Vec<(DirectoryQuery, Response<Value>)> = stream::iter(directory_queries(needs))
        .map(|query| async move {
            let response = request::<Value>(http, token, &query.text, json!({})).await?;
            Ok::<_, FetchError>((query, response))
        })
        .buffer_unordered(DIRECTORY_CONCURRENT)
        .try_collect()
        .await?;

    let mut found = Found::default();
    for (query, response) in responses {
        if response.scope_missing {
            return Ok(Found {
                denied: true,
                ..Found::default()
            });
        }
        for (alias, key) in query.teams {
            let members = &response.data[alias.as_str()]["team"]["members"];
            if !members.is_object() {
                continue;
            }
            let (mut logins, mut next) = members_page(members);
            if let Some((org, slug)) = key.split_once('/') {
                for _ in 1..MAX_MEMBER_PAGES {
                    let Some(cursor) = next.take() else { break };
                    let page = request::<Value>(
                        http,
                        token,
                        MEMBERS_QUERY,
                        json!({ "org": org, "slug": slug, "after": cursor }),
                    )
                    .await?;
                    let (more, after) = members_page(&page.data["organization"]["team"]["members"]);
                    logins.extend(more);
                    next = after;
                }
            }
            found.teams.insert(key, logins.into_iter().collect());
        }
    }
    Ok(found)
}

const MEMBERS_QUERY: &str = "query($org: String!, $slug: String!, $after: String) { organization(login: $org) { team(slug: $slug) { members(first: 100, after: $after) { nodes { login } pageInfo { hasNextPage endCursor } } } } }";

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

#[derive(Default)]
struct SearchResult {
    viewer: String,
    ids: Vec<String>,
    sso_partial: bool,
}

async fn search_ids(
    http: &reqwest::Client,
    token: &str,
    search: &str,
) -> Result<SearchResult, FetchError> {
    let mut result = SearchResult {
        viewer: String::new(),
        ids: Vec::new(),
        sso_partial: false,
    };
    let mut cursor: Option<String> = None;

    for _ in 0..MAX_SEARCH_PAGES {
        let page: Response<SearchData> = request(
            http,
            token,
            SEARCH_QUERY,
            json!({ "q": search, "cursor": cursor }),
        )
        .await?;
        result.viewer = page.data.viewer.login;
        result.sso_partial |= page.sso_partial;
        result
            .ids
            .extend(page.data.search.nodes.into_iter().flatten().map(|n| n.id));

        let info = page.data.search.page_info;
        match info.end_cursor {
            Some(next) if info.has_next_page => cursor = Some(next),
            _ => break,
        }
    }
    Ok(result)
}

/// Fetches details in batches that wait their turn for one of `limiter`'s
/// slots, in the order they were asked for, so several callers can share the
/// slots with the first to ask finishing first.
async fn details_sharing(
    http: &reqwest::Client,
    token: &str,
    ids: &[String],
    limiter: &Semaphore,
) -> Result<Vec<PullRequest>, FetchError> {
    let batches: Vec<Response<Nodes<PullRequest>>> =
        future::try_join_all(ids.chunks(BATCH_SIZE).map(|chunk| async move {
            let _slot = limiter
                .acquire()
                .await
                .expect("the semaphore is never closed");
            request(http, token, DETAILS_QUERY, json!({ "ids": chunk })).await
        }))
        .await?;
    Ok(batches
        .into_iter()
        .flat_map(|batch| batch.data.nodes)
        .flatten()
        .collect())
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
struct Merged {
    id: String,
    merged: bool,
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
    /// An error says the token lacks a scope, such as `read:org`.
    scope_missing: bool,
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
    let scope_missing = parsed.errors.iter().any(|e| {
        e.kind.as_deref() == Some("INSUFFICIENT_SCOPES") || e.message.contains("read:org")
    });
    match parsed.data {
        Some(data) => {
            if !parsed.errors.is_empty() {
                log::warn!("GitHub returned partial data: {}", messages());
            }
            Ok(Response {
                data,
                sso_partial,
                scope_missing,
            })
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

    #[test]
    fn splits_authors_across_searches_that_fit() {
        let since = NaiveDate::from_ymd_opt(2026, 10, 1).unwrap();
        assert!(merged_by_searches(since, "o", &[]).is_empty());

        let few = vec!["ana".to_string(), "bo".to_string()];
        assert_eq!(
            merged_by_searches(since, "o", &few),
            ["is:pr is:merged merged:>=2026-10-01 org:o author:ana author:bo"]
        );

        let many: Vec<String> = (0..120).map(|i| format!("member-number-{i}")).collect();
        let searches = merged_by_searches(since, "o", &many);
        assert!(searches.len() > 1);
        assert!(searches.iter().all(|s| s.len() <= MAX_SEARCH_CHARS));
        // Every login is in exactly one search.
        let counted: usize = searches.iter().map(|s| s.matches(" author:").count()).sum();
        assert_eq!(counted, many.len());
    }

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

    /// Looks up the teams requested on the logged-in user's real pull requests.
    /// Run with `cargo test -- --ignored --nocapture live_directory`.
    #[test]
    #[ignore = "calls the GitHub API with your gh token"]
    fn live_directory() {
        let token = auth::resolve_token(None).expect("gh is logged in");
        let http = http_client();
        let since = (Utc::now() - chrono::Duration::days(30)).date_naive();
        let fetched = tauri::async_runtime::block_on(fetch_open_pull_requests(
            &http,
            &token.value,
            since,
            true,
            &[],
            None,
        ))
        .expect("fetch succeeds");
        let needs = prs::directory_needs(
            fetched
                .pull_requests
                .iter()
                .chain(&fetched.review_pull_requests),
        );
        println!("{} teams to look up", needs.teams.len());
        let started = std::time::Instant::now();
        let found = tauri::async_runtime::block_on(fetch_directory(&http, &token.value, &needs))
            .expect("lookup succeeds");
        println!(
            "denied={} teams={} in {:?}",
            found.denied,
            found.teams.len(),
            started.elapsed()
        );
        for (team, members) in found.teams.iter().take(5) {
            println!("  {team}: {} members", members.len());
        }
        assert!(!found.denied);
    }

    /// Fetches the logged-in user's real pull requests. Run with
    /// `cargo test -- --ignored --nocapture live_fetch`.
    #[test]
    #[ignore = "calls the GitHub API with your gh token"]
    fn live_fetch() {
        let token = auth::resolve_token(None).expect("gh is logged in");
        let since = (Utc::now() - chrono::Duration::days(30)).date_naive();
        let fetched = tauri::async_runtime::block_on(fetch_open_pull_requests(
            &http_client(),
            &token.value,
            since,
            true,
            &[],
            None,
        ))
        .expect("fetch succeeds");
        println!(
            "{} open PRs for {}, {} review PRs ({} requested), sso_partial={}",
            fetched.pull_requests.len(),
            fetched.viewer,
            fetched.review_pull_requests.len(),
            fetched
                .review_pull_requests
                .iter()
                .filter(|pr| pr.review_requested)
                .count(),
            fetched.sso_partial
        );
        let ignored = ["kibanamachine".to_string(), "elasticmachine".to_string()];
        let rules = prs::Rules {
            directory: &Directory::default(),
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
                "{:?} {:?} {}#{} open={} quiet={} checks_started={:?} [{}]",
                pr.group,
                pr.actions,
                pr.repo,
                pr.number,
                pr.open_since.format("%m-%d"),
                pr.quiet_since.format("%m-%d"),
                pr.checks_started,
                reviewers.join(", ")
            );
        }
    }

    #[test]
    #[ignore = "calls the GitHub API with your gh token"]
    fn live_merged() {
        let token = auth::resolve_token(None).expect("gh is logged in");
        let http = http_client();
        let page = tauri::async_runtime::block_on(fetch_merged_page(&http, &token.value, None, 10))
            .expect("fetch succeeds");
        println!(
            "{} merged PRs, has_next_page={}",
            page.items.len(),
            page.has_next_page
        );
        for pr in &page.items {
            println!(
                "{} {}#{} merged {}",
                pr.title, pr.repository.name_with_owner, pr.number, pr.merged_at
            );
        }
        if let Some(cursor) = page.end_cursor {
            let next = tauri::async_runtime::block_on(fetch_merged_page(
                &http,
                &token.value,
                Some(cursor),
                5,
            ))
            .expect("second page succeeds");
            println!("next page: {} items", next.items.len());
            let overlap = next
                .items
                .iter()
                .any(|a| page.items.iter().any(|b| a.id == b.id));
            assert!(!overlap, "pages should not repeat the same PR");
        }
    }

    #[test]
    #[ignore = "calls the GitHub API with your gh token"]
    fn live_view() {
        let token = auth::resolve_token(None).expect("gh is logged in");
        let http = http_client();
        let since = (Utc::now() - chrono::Duration::days(30)).date_naive();
        let views = vec![(
            "v1".to_string(),
            review_pinger_core::views::View {
                id: "v1".to_string(),
                name: "Kibana PRs".to_string(),
                query: "repo:elastic/kibana".to_string(),
            }
            .search(),
        )];
        let fetched = tauri::async_runtime::block_on(fetch_open_pull_requests(
            &http,
            &token.value,
            since,
            true,
            &views,
            None,
        ))
        .expect("fetch succeeds");
        let matched = fetched.view_pull_requests.get("v1").expect("the view ran");
        println!(
            "{} own PRs, {} review PRs, {} matched the view",
            fetched.pull_requests.len(),
            fetched.review_pull_requests.len(),
            matched.len()
        );
        // Every match really is in that repo.
        for pr in matched {
            assert_eq!(pr.repository.name_with_owner, "elastic/kibana");
        }
        // A PR that's both yours and in the repo shows up in both places.
        let overlap: Vec<&str> = fetched
            .pull_requests
            .iter()
            .filter(|pr| matched.iter().any(|m| m.id == pr.id))
            .map(|pr| pr.id.as_str())
            .collect();
        println!("{} of your own PRs are also in the view", overlap.len());
    }
}
