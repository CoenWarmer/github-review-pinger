// Runs the web app's fetching and the WebAssembly logic against your real
// GitHub account, using the GitHub CLI's token. Nothing is stored.
// Usage: pnpm --filter @review-pinger/web live
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { initSync, Pinger } from "../../../packages/wasm/pkg/review_pinger_wasm.js";
import { createGithub } from "../src/github.ts";

const graphql = (name: string) =>
  readFileSync(new URL(`../../../crates/core/src/github/${name}.graphql`, import.meta.url), "utf8");
const queries = {
  search: graphql("search"),
  details: graphql("details") + graphql("pull_request"),
  mergeState: graphql("merge_state"),
  mergedSearch: graphql("merged_search"),
  prSearch: graphql("pr_search"),
};

initSync({
  module: readFileSync(
    new URL("../../../packages/wasm/pkg/review_pinger_wasm_bg.wasm", import.meta.url),
  ),
});

const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const github = createGithub({ token, queries });
const pinger = new Pinger();
const now = new Date().toISOString();

let started = performance.now();
const fetched = await github.fetchOpenPullRequests(pinger.reviewedSince(now), true, []);
console.log(
  `fetched for ${fetched.viewer}: ${fetched.pullRequests.length} own PRs, ` +
    `${fetched.reviewPullRequests.length} review PRs ` +
    `(${fetched.reviewPullRequests.filter((pr) => pr.reviewRequested).length} requested), ` +
    `sso partial: ${fetched.ssoPartial}, ${Math.round(performance.now() - started)} ms`,
);

started = performance.now();
const update = JSON.parse(
  pinger.poll(JSON.stringify(fetched), now, -new Date().getTimezoneOffset()),
);
const groups = (list: { group: string }[]) =>
  Object.entries(Object.groupBy(list, (item) => item.group))
    .map(([group, items]) => `${group} ${items?.length}`)
    .join(", ");
console.log(`derived in ${Math.round(performance.now() - started)} ms`);
console.log(`  my PRs: ${groups(update.pullRequests)}`);
console.log(`  review requests: ${groups(update.reviewRequests)}`);

started = performance.now();
const needs = JSON.parse(pinger.directoryNeeds(now));
const found = await github.fetchDirectory(needs);
const changed = pinger.mergeDirectory(JSON.stringify(needs), JSON.stringify(found), now);
console.log(
  `teams: asked ${needs.teams.length}, found ${Object.keys(found.teams).length}, ` +
    `denied ${found.denied}, changed ${changed}, ${Math.round(performance.now() - started)} ms`,
);
const withCards = JSON.parse(pinger.derived(now)!).pullRequests.filter(
  (pr: { reviewers: { teams: string[]; membersKnown: boolean }[] }) =>
    pr.reviewers.some((r) => r.teams.length > 0 || r.membersKnown),
).length;
console.log(`  PRs with team details on a reviewer chip: ${withCards}`);
