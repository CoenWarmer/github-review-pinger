pub mod types;

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
