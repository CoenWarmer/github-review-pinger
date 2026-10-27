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
