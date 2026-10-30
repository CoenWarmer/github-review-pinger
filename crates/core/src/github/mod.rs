pub mod types;

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

/// Most pages of checks followed for one PR, so a runaway PR can't make
/// the lookup endless.
pub const MAX_CHECK_PAGES: usize = 5;

/// Asks which of each PR's head-commit checks are required, and how each
/// stands. `isRequired` needs the PR it's asked about, which a query over
/// many PRs can't pass along, so each PR gets its own aliased lookup (`r0`,
/// `r1`, ...), after the cursor given for it when its checks span pages.
pub fn required_checks_query(lookups: &[(String, Option<String>)]) -> String {
    let lookups: String = lookups
        .iter()
        .enumerate()
        .map(|(i, (id, cursor))| {
            // JSON quoting is GraphQL string quoting, and an id can't break out of it.
            let id = serde_json::to_string(id).expect("a string serializes");
            let after = cursor
                .as_ref()
                .map(|c| format!(", after: {}", serde_json::to_string(c).expect("a string serializes")))
                .unwrap_or_default();
            format!(
                "  r{i}: node(id: {id}) {{ ... on PullRequest {{ id commits(last: 1) {{ nodes {{ commit {{ \
statusCheckRollup {{ contexts(first: 100{after}) {{ pageInfo {{ hasNextPage endCursor }} nodes {{ __typename \
... on CheckRun {{ name status conclusion isRequired(pullRequestId: {id}) }} \
... on StatusContext {{ context state isRequired(pullRequestId: {id}) }} }} }} }} }} }} }} }} }}\n"
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
    pub contexts: Option<RequiredContexts>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredContexts {
    pub page_info: PageInfo,
    pub nodes: Vec<Option<RequiredContext>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub has_next_page: bool,
    pub end_cursor: Option<String>,
}

/// A check run has `name`, `status` and `conclusion`; a commit status has
/// `context` and `state`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredContext {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub status: Option<types::CheckRunStatus>,
    #[serde(default)]
    pub conclusion: Option<String>,
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub state: Option<types::CheckState>,
    #[serde(default)]
    pub is_required: bool,
}

impl RequiredContext {
    /// The required check this is, or `None` when it isn't required.
    fn required(&self) -> Option<types::RequiredCheck> {
        use types::{CheckOutcome, CheckRunStatus, CheckState};
        if !self.is_required {
            return None;
        }
        let name = self.name.clone().or_else(|| self.context.clone())?;
        let outcome = match (&self.status, &self.state) {
            (Some(CheckRunStatus::Completed), _) => match self.conclusion.as_deref() {
                Some("SUCCESS" | "SKIPPED" | "NEUTRAL") => CheckOutcome::Passed,
                _ => CheckOutcome::Failed,
            },
            (Some(_), _) => CheckOutcome::Running,
            (None, Some(CheckState::Success)) => CheckOutcome::Passed,
            (None, Some(CheckState::Failure | CheckState::Error)) => CheckOutcome::Failed,
            (None, _) => CheckOutcome::Running,
        };
        Some(types::RequiredCheck { name, outcome })
    }
}

impl RequiredChecksReply {
    /// The PR's id, the required checks on this page, and the cursor to ask
    /// for the next page with, when there is one.
    pub fn page(&self) -> (String, Vec<types::RequiredCheck>, Option<String>) {
        let contexts = self
            .commits
            .iter()
            .flat_map(|commits| commits.iter())
            .filter_map(|node| node.commit.status_check_rollup.as_ref())
            .filter_map(|rollup| rollup.contexts.as_ref())
            .next();
        let checks = contexts
            .iter()
            .flat_map(|contexts| contexts.nodes.iter().flatten())
            .filter_map(RequiredContext::required)
            .collect();
        let next = contexts
            .filter(|contexts| contexts.page_info.has_next_page)
            .and_then(|contexts| contexts.page_info.end_cursor.clone());
        (self.id.clone(), checks, next)
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
    use types::{CheckOutcome, RequiredCheck};

    #[test]
    fn the_required_checks_query_asks_about_each_pr_by_its_own_id() {
        let query = required_checks_query(&[
            ("PR_a".to_string(), None),
            ("PR\"b".to_string(), Some("cur".to_string())),
        ]);
        assert!(query.contains("r0: node(id: \"PR_a\")"));
        assert!(query.contains("isRequired(pullRequestId: \"PR_a\")"));
        assert!(query.contains("contexts(first: 100) {"));
        // An id can't end the string it's quoted in, and a cursor continues the page.
        assert!(query.contains("r1: node(id: \"PR\\\"b\")"));
        assert!(query.contains("contexts(first: 100, after: \"cur\") {"));
    }

    #[test]
    fn the_required_checks_query_is_well_formed() {
        let query = required_checks_query(&[
            ("PR_a".to_string(), None),
            ("PR_b".to_string(), Some("cur".to_string())),
        ]);
        // GitHub rejects the whole request for a stray brace, so every lookup
        // must close exactly what it opens, and none may end the query early.
        let mut depth = 0i32;
        let mut parens = 0i32;
        let mut quoted = false;
        for c in query.chars() {
            match c {
                '"' => quoted = !quoted,
                '{' if !quoted => depth += 1,
                '}' if !quoted => depth -= 1,
                '(' if !quoted => parens += 1,
                ')' if !quoted => parens -= 1,
                _ => {}
            }
            assert!(depth >= 0, "closed more than was opened in:\n{query}");
        }
        assert_eq!((depth, parens), (0, 0), "unbalanced:\n{query}");
        // Each lookup is its own balanced line, so one can't swallow the next.
        for line in query.lines().filter(|l| l.trim_start().starts_with('r')) {
            let opens = line.matches('{').count();
            let closes = line.matches('}').count();
            assert_eq!(opens, closes, "lookup out of balance: {line}");
        }
    }

    #[test]
    fn a_reply_gives_the_required_checks_with_how_they_stand() {
        let reply: RequiredChecksReply = serde_json::from_value(json!({
            "id": "PR_a",
            "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "contexts": {
                "pageInfo": { "hasNextPage": true, "endCursor": "next" },
                "nodes": [
                    { "__typename": "CheckRun", "name": "build", "status": "COMPLETED",
                      "conclusion": "SUCCESS", "isRequired": true },
                    { "__typename": "CheckRun", "name": "lint", "status": "IN_PROGRESS",
                      "conclusion": null, "isRequired": true },
                    { "__typename": "CheckRun", "name": "docs", "status": "COMPLETED",
                      "conclusion": "FAILURE", "isRequired": false },
                    { "__typename": "StatusContext", "context": "kibana-ci",
                      "state": "PENDING", "isRequired": true },
                    { "__typename": "StatusContext", "context": "snyk",
                      "state": "FAILURE", "isRequired": true },
                ],
            } } } }] },
        }))
        .unwrap();

        let (id, checks, next) = reply.page();

        assert_eq!(id, "PR_a");
        assert_eq!(next.as_deref(), Some("next"));
        let check = |name: &str, outcome| RequiredCheck {
            name: name.to_string(),
            outcome,
        };
        assert_eq!(
            checks,
            vec![
                check("build", CheckOutcome::Passed),
                check("lint", CheckOutcome::Running),
                check("kibana-ci", CheckOutcome::Running),
                check("snyk", CheckOutcome::Failed),
            ]
        );
    }

    #[test]
    fn the_last_page_has_no_cursor() {
        let reply: RequiredChecksReply = serde_json::from_value(json!({
            "id": "PR_a",
            "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "contexts": {
                "pageInfo": { "hasNextPage": false, "endCursor": "end" },
                "nodes": [],
            } } } }] },
        }))
        .unwrap();
        assert_eq!(reply.page().2, None);
    }
}
