import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Fetched, Matches, RawPullRequest } from "./github.ts";
import { applyProgress, emptyFetched, withKnownRequiredChecks } from "./progress.ts";

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

  it("keeps the required checks shown until the new ones arrive", () => {
    const required: RawPullRequest["requiredChecks"] = [{ name: "build", outcome: "failed" }];
    const before = { ...base(), pullRequests: [pr("mine", { requiredChecks: required })] };
    const next = applyProgress(before, {
      fresh: [pr("mine")],
      matches: null,
      viewer: "",
      ssoPartial: false,
    });
    assert.deepEqual(next.pullRequests[0].requiredChecks, required);
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

describe("withKnownRequiredChecks", () => {
  const failing = (id: string, extra: Partial<RawPullRequest> = {}): RawPullRequest =>
    pr(id, { commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] }, ...extra } as Partial<RawPullRequest>);
  const known = new Map([["a", [{ name: "ci", outcome: "passed" as const }]]]);

  it("gives a failing PR the required checks it had, until the lookup is in", () => {
    const [a] = withKnownRequiredChecks([failing("a")], known);
    assert.deepEqual(a.requiredChecks, [{ name: "ci", outcome: "passed" }]);
  });

  it("leaves alone a PR that isn't failing, has its own, or wasn't known", () => {
    const passing = pr("a", { commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] } } as Partial<RawPullRequest>);
    const own = failing("a", { requiredChecks: [] });
    const out = withKnownRequiredChecks([passing, own, failing("b")], known);
    assert.equal(out[0].requiredChecks, undefined);
    assert.deepEqual(out[1].requiredChecks, []);
    assert.equal(out[2].requiredChecks, undefined);
  });
});
