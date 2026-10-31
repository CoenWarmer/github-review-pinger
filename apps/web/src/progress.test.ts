import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Fetched, Matches, RawPullRequest } from "./github.ts";
import { applyProgress, emptyFetched } from "./progress.ts";

const pr = (id: string, extra: Partial<RawPullRequest> = {}): RawPullRequest => ({ id, ...extra });
const matches = (overrides: Partial<Matches>): Matches => ({
  authored: [],
  requested: [],
  reviewed: [],
  views: {},
  ...overrides,
});
const base = (): Fetched => ({
  ...emptyFetched(),
  viewer: "me",
  pullRequests: [pr("mine", { title: "Old", mergeStateStatus: "CLEAN" })],
  reviewPullRequests: [pr("theirs", { reviewRequested: true })],
});
const ids = (prs: RawPullRequest[]) => prs.map((p) => p.id);

describe("applyProgress", () => {
  it("before the searches only replaces PRs it already has", () => {
    const next = applyProgress(base(), {
      fresh: [pr("mine", { title: "New" }), pr("stranger")],
      matches: null,
      viewer: "",
      ssoPartial: false,
    });
    assert.deepEqual(ids(next.pullRequests), ["mine"]);
    assert.equal(next.pullRequests[0].title, "New");
    assert.deepEqual(ids(next.reviewPullRequests), ["theirs"]);
  });

  it("keeps the merge state shown until the new one arrives", () => {
    const next = applyProgress(base(), {
      fresh: [pr("mine")],
      matches: null,
      viewer: "",
      ssoPartial: false,
    });
    assert.equal(next.pullRequests[0].mergeStateStatus, "CLEAN");
  });

  it("after the searches files new PRs where they were found", () => {
    const next = applyProgress(base(), {
      fresh: [pr("own"), pr("asked"), pr("done")],
      matches: matches({ authored: ["own"], requested: ["asked"], reviewed: ["done"] }),
      viewer: "me",
      ssoPartial: false,
    });
    assert.deepEqual(ids(next.pullRequests), ["mine", "own"]);
    assert.deepEqual(
      next.reviewPullRequests.map((p) => [p.id, p.reviewRequested]),
      [["theirs", true], ["asked", true], ["done", false]],
    );
  });

  it("drops a PR that was merged or closed, and builds up from nothing on a first load", () => {
    const first = applyProgress(emptyFetched(), {
      fresh: [pr("a"), pr("b")],
      matches: matches({ authored: ["a", "b"], views: { v: ["a"] } }),
      viewer: "me",
      ssoPartial: true,
    });
    assert.equal(first.viewer, "me");
    assert.equal(first.ssoPartial, true);
    assert.deepEqual(ids(first.viewPullRequests.v), ["a"]);

    const next = applyProgress(first, {
      fresh: [pr("a", { closed: true })],
      matches: null,
      viewer: "",
      ssoPartial: false,
    });
    assert.deepEqual(ids(next.pullRequests), ["b"]);
    assert.deepEqual(ids(next.viewPullRequests.v), []);
  });
});
