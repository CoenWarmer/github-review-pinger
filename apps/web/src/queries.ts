import type { Queries } from "./github.ts";
import details from "../../../crates/core/src/github/details.graphql?raw";
import mergedSearch from "../../../crates/core/src/github/merged_search.graphql?raw";
import mergeState from "../../../crates/core/src/github/merge_state.graphql?raw";
import pullRequest from "../../../crates/core/src/github/pull_request.graphql?raw";
import prDetails from "../../../crates/core/src/github/pr_details.graphql?raw";
import prSearch from "../../../crates/core/src/github/pr_search.graphql?raw";
import statsMerged from "../../../crates/core/src/github/stats_merged.graphql?raw";
import search from "../../../crates/core/src/github/search.graphql?raw";

/** The same documents the Rust code includes, so both ask GitHub for the same fields. */
export const queries: Queries = {
  search,
  details: details + pullRequest,
  mergeState,
  mergedSearch,
  prSearch,
  prDetails,
  statsMerged,
};
