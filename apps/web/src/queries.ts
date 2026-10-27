import type { Queries } from "./github.ts";
import details from "../../../crates/core/src/github/details.graphql?raw";
import mergeState from "../../../crates/core/src/github/merge_state.graphql?raw";
import pullRequest from "../../../crates/core/src/github/pull_request.graphql?raw";
import search from "../../../crates/core/src/github/search.graphql?raw";

/** The same documents the Rust code includes, so both ask GitHub for the same fields. */
export const queries: Queries = { search, details: details + pullRequest, mergeState };
