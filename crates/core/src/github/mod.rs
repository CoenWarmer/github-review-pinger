pub mod types;

use std::collections::HashSet;

use serde::Deserialize;

// The GraphQL documents live next to the types they fill, so every front end
// asks GitHub for the same fields.

/// Lists the ids of the PRs matching a search, cheaply.
pub const SEARCH_QUERY: &str = include_str!("search.graphql");
/// Fetches the details of PRs by id.
pub const DETAILS_QUERY: &str = concat!(
    include_str!("details.graphql"),
    include_str!("pull_request.graphql")
);
/// Fetches the merge state, which is expensive, of a few PRs by id.
pub const MERGE_STATE_QUERY: &str = include_str!("merge_state.graphql");
/// Tells a merge from a plain close, for PRs that dropped out of the open search.
pub const MERGED_QUERY: &str = include_str!("merged.graphql");
/// One page of your merged PRs, for the "Merged" section.
pub const MERGED_SEARCH_QUERY: &str = include_str!("merged_search.graphql");
/// The first page of PRs matching free-form text, for "Search on GitHub".
pub const PR_SEARCH_QUERY: &str = include_str!("pr_search.graphql");
/// Your merged PRs in a window, for the statistics.
pub const STATS_MERGED_QUERY: &str = include_str!("stats_merged.graphql");
/// The query text for the merged PRs search: always this one text, so
/// "Load more" can keep paging through the same cursor sequence.
pub const MERGED_SEARCH: &str = "is:pr is:merged author:@me archived:false sort:updated-desc";

/// Asks which of each PR's head-commit checks are required. `isRequired`
/// needs the PR it's asked about, which a query over many PRs can't pass
/// along, so each PR gets its own aliased lookup (`r0`, `r1`, ...).
pub fn required_checks_query(ids: &[String]) -> String {
    let lookups: String = ids
        .iter()
        .enumerate()
        .map(|(i, id)| {
            // JSON quoting is GraphQL string quoting, and an id can't break out of it.
            let id = serde_json::to_string(id).expect("a string serializes");
            format!(
                "  r{i}: node(id: {id}) {{ ... on PullRequest {{ id commits(last: 1) {{ nodes {{ commit {{ \
statusCheckRollup {{ contexts(first: 100) {{ nodes {{ __typename \
... on CheckRun {{ name isRequired(pullRequestId: {id}) }} \
... on StatusContext {{ context isRequired(pullRequestId: {id}) }} }} }} }} }} }} }} }} }}\n"
            )
        })
        .collect();
    format!("query RequiredChecks {{\n{lookups}}}")
}

/// One PR's reply to [`required_checks_query`].
#[derive(Debug, Deserialize)]
pub struct RequiredChecksReply {
    pub id: String,
    #[serde(default)]
    pub commits: Option<types::Nodes<RequiredCommit>>,
}

#[derive(Debug, Deserialize)]
pub struct RequiredCommit {
    pub commit: RequiredCommitChecks,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredCommitChecks {
    pub status_check_rollup: Option<RequiredRollup>,
}

#[derive(Debug, Deserialize)]
pub struct RequiredRollup {
    pub contexts: Option<types::Nodes<RequiredContext>>,
}

/// A check run is named `name`, a commit status `context`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredContext {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub is_required: bool,
}

impl RequiredChecksReply {
    /// The PR's id and the names of its required checks.
    pub fn required_names(&self) -> (String, HashSet<String>) {
        let names = self
            .commits
            .iter()
            .flat_map(|commits| commits.iter())
            .filter_map(|node| node.commit.status_check_rollup.as_ref())
            .filter_map(|rollup| rollup.contexts.as_ref())
            .flat_map(|contexts| contexts.iter())
            .filter(|context| context.is_required)
            .filter_map(|context| context.name.clone().or_else(|| context.context.clone()))
            .collect();
        (self.id.clone(), names)
    }
}

/// Whether a PR's checks fail, so which of them are required decides whether
/// that counts. Mirrored by the web fetch.
pub fn needs_required_checks(pr: &types::PullRequest) -> bool {
    pr.commits
        .iter()
        .last()
        .and_then(|node| node.commit.status_check_rollup.as_ref())
        .is_some_and(|rollup| {
            matches!(
                rollup.state,
                types::CheckState::Failure | types::CheckState::Error
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_required_checks_query_asks_about_each_pr_by_its_own_id() {
        let query = required_checks_query(&["PR_a".to_string(), "PR\"b".to_string()]);
        assert!(query.contains("r0: node(id: \"PR_a\")"));
        assert!(query.contains("isRequired(pullRequestId: \"PR_a\")"));
        // An id can't end the string it's quoted in.
        assert!(query.contains("r1: node(id: \"PR\\\"b\")"));
    }

    #[test]
    fn a_reply_names_the_required_checks_of_runs_and_statuses() {
        let reply: RequiredChecksReply = serde_json::from_value(json!({
            "id": "PR_a",
            "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "contexts": { "nodes": [
                { "__typename": "CheckRun", "name": "build", "isRequired": true },
                { "__typename": "CheckRun", "name": "docs", "isRequired": false },
                { "__typename": "StatusContext", "context": "kibana-ci", "isRequired": true },
            ] } } } }] },
        }))
        .unwrap();

        let (id, names) = reply.required_names();

        assert_eq!(id, "PR_a");
        assert_eq!(
            names,
            HashSet::from(["build".to_string(), "kibana-ci".to_string()])
        );
    }
}
