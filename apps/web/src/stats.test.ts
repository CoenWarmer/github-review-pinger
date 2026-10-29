import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PullRequest } from "@review-pinger/app";
import {
  averageApproval,
  averageCodeOwners,
  averageReadyToMerged,
  averageReviewWait,
  change,
  duration,
  median,
  perMember,
} from "../../../packages/app/src/stats.ts";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const pr = (over: Partial<PullRequest> = {}): PullRequest =>
  ({ id: "p", group: "waiting", openSince: hoursAgo(100), reviewers: [], codeOwners: 0, ...over }) as PullRequest;

describe("review wait on merged PRs", () => {
  const sample = (requestedAt: string | null, reviews: [string | null, string][]) => ({
    createdAt: hoursAgo(200),
    mergedAt: hoursAgo(0),
    draftEvents: [],
    requestedAt,
    reviews: reviews.map(([by, at]) => ({ by, at })),
    approvals: [],
  });

  it("is the time from the first request to the first review by someone else", () => {
    const merged = [
      sample(hoursAgo(10), [["me", hoursAgo(9)], ["ana", hoursAgo(6)], ["bo", hoursAgo(3)]]),
      sample(hoursAgo(5), [["bo", hoursAgo(4)]]),
    ];
    // 4h and 1h.
    assert.deepEqual(averageReviewWait(merged, "ME"), { average: 2.5 * 3_600_000, count: 2 });
  });

  it("skips PRs merged without a request or without a review, and reviews from before the request", () => {
    const merged = [
      sample(null, [["ana", hoursAgo(3)]]),
      sample(hoursAgo(10), []),
      sample(hoursAgo(10), [["ana", hoursAgo(12)]]),
      sample(hoursAgo(10), [["me", hoursAgo(8)]]),
    ];
    assert.deepEqual(averageReviewWait(merged, "me"), { average: null, count: 0 });
  });
});

describe("code owners", () => {
  it("averages the pending code-owner requests over open PRs that aren't drafts", () => {
    const prs = [pr({ codeOwners: 2 }), pr({ codeOwners: 1 }), pr({ codeOwners: 0 }), pr({ group: "draft", codeOwners: 9 })];
    assert.deepEqual(averageCodeOwners(prs), { average: 1, count: 3 });
  });

  it("treats PRs from lists saved before the count existed as having none", () => {
    const old = { ...pr(), codeOwners: undefined } as PullRequest;
    assert.deepEqual(averageCodeOwners([old, pr({ codeOwners: 3 })]), { average: 1.5, count: 2 });
  });
});

describe("durations", () => {
  it("reads at a glance", () => {
    assert.equal(duration(0), "0m");
    assert.equal(duration(12 * 60_000), "12m");
    assert.equal(duration(60 * 60_000), "1h");
    assert.equal(duration(5.5 * 3_600_000), "5h 30m");
    assert.equal(duration(24 * 3_600_000), "1d");
    assert.equal(duration(52 * 3_600_000), "2d 4h");
  });
});

describe("merged per team member", () => {
  it("divides the team's merges by its members", () => {
    assert.equal(perMember(87, 12), 7.25);
    assert.equal(perMember(0, 4), 0);
  });

  it("is nothing without a team or without members", () => {
    assert.equal(perMember(null, 5), null);
    assert.equal(perMember(10, 0), null);
  });
});

describe("median", () => {
  it("is the middle value, or the mean of the two in the middle", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([7]), 7);
  });

  it("isn't thrown by a few big numbers, unlike the average", () => {
    // Fifteen members as measured: two heavy mergers and one who merged nothing.
    const counts = [0, 1, 1, 10, 14, 15, 15, 16, 21, 25, 27, 31, 57, 72, 98];
    assert.equal(median(counts), 16);
    assert.ok(counts.reduce((a, b) => a + b, 0) / counts.length > 26);
  });

  it("is nothing for no values, and doesn't reorder what it's given", () => {
    assert.equal(median([]), null);
    const given = [3, 1, 2];
    median(given);
    assert.deepEqual(given, [3, 1, 2]);
  });
});

describe("change since the window before", () => {
  it("says which way it moved, by how much, and what it was", () => {
    assert.deepEqual(change(60, 4), { direction: "up", text: "▲ 56 (was 4)" });
    assert.deepEqual(change(3, 10), { direction: "down", text: "▼ 7 (was 10)" });
  });

  it("says when nothing moved", () => {
    assert.deepEqual(change(7, 7), { direction: "same", text: "same (was 7)" });
    // A rounding error isn't a change.
    assert.equal(change(15.7, 15.72).direction, "same");
  });

  it("rounds the size of a move that isn't whole to a tenth", () => {
    assert.equal(change(17.4, 15.2).text, "▲ 2.2 (was 15.2)");
    assert.equal(change(0, 2.5).text, "▼ 2.5 (was 2.5)");
  });

  it("can read durations, where under a minute is no change", () => {
    const minute = 60_000;
    const text = (ms: number) => `${Math.round(ms / minute)}m`;
    assert.equal(change(90 * minute, 150 * minute, text, minute).text, "▼ 60m (was 150m)");
    assert.equal(change(90 * minute + 20_000, 90 * minute, text, minute).direction, "same");
  });
});

describe("ready for review to merged", () => {
  const pr = (
    createdAt: string,
    mergedAt: string,
    draftEvents: { kind: "ready" | "draft"; at: string }[] = [],
  ) => ({ createdAt, mergedAt, draftEvents, requestedAt: null, reviews: [], approvals: [] });
  const HOUR = 3_600_000;

  it("counts from opening for a PR that was never a draft", () => {
    const merged = [pr(hoursAgo(10), hoursAgo(4)), pr(hoursAgo(5), hoursAgo(1))];
    // 6h and 4h.
    assert.deepEqual(averageReadyToMerged(merged), { average: 5 * HOUR, count: 2 });
  });

  it("counts from being marked ready for a PR opened as a draft", () => {
    // Opened 100h ago as a draft, ready 8h ago, merged 2h ago: 6h, not 98h.
    const merged = [pr(hoursAgo(100), hoursAgo(2), [{ kind: "ready", at: hoursAgo(8) }])];
    assert.equal(averageReadyToMerged(merged).average, 6 * HOUR);
  });

  it("counts from opening when the first draft event is turning it into a draft", () => {
    // Opened ready 20h ago, back to draft at 15h, ready again at 6h, merged 2h ago: 18h.
    const merged = [
      pr(hoursAgo(20), hoursAgo(2), [
        { kind: "draft", at: hoursAgo(15) },
        { kind: "ready", at: hoursAgo(6) },
      ]),
    ];
    assert.equal(averageReadyToMerged(merged).average, 18 * HOUR);
  });

  it("counts from the first ready time, so a later round through draft is still time to merge", () => {
    // Draft, ready at 30h, draft again at 20h, ready at 10h, merged 2h ago: 28h from the first.
    const merged = [
      pr(hoursAgo(50), hoursAgo(2), [
        { kind: "ready", at: hoursAgo(30) },
        { kind: "draft", at: hoursAgo(20) },
        { kind: "ready", at: hoursAgo(10) },
      ]),
    ];
    assert.equal(averageReadyToMerged(merged).average, 28 * HOUR);
  });

  it("is nothing for no PRs, and skips a PR merged before it was ready", () => {
    assert.deepEqual(averageReadyToMerged([]), { average: null, count: 0 });
    const odd = [pr(hoursAgo(1), hoursAgo(5))];
    assert.deepEqual(averageReadyToMerged(odd), { average: null, count: 0 });
  });
});

describe("time to get approved", () => {
  const HOUR = 3_600_000;
  const pr = (requestedAt: string | null, approvals: [string | null, string][]) => ({
    createdAt: hoursAgo(200),
    mergedAt: hoursAgo(0),
    draftEvents: [],
    requestedAt,
    reviews: [],
    approvals: approvals.map(([by, at]) => ({ by, at })),
  });

  it("runs from the first request to the last approval in effect, so every approver is waited for", () => {
    const merged = [
      // Asked 10h ago; ana approved at 8h, bo at 3h: the last is 7h after the request.
      pr(hoursAgo(10), [["ana", hoursAgo(8)], ["bo", hoursAgo(3)]]),
      // One approver, 1h after the request.
      pr(hoursAgo(5), [["cy", hoursAgo(4)]]),
    ];
    assert.deepEqual(averageApproval(merged, "me"), { average: 4 * HOUR, count: 2 });
  });

  it("leaves out your own approvals, approvals from before the request, and PRs with none", () => {
    const merged = [
      pr(hoursAgo(10), [["ME", hoursAgo(5)]]),
      pr(hoursAgo(10), [["ana", hoursAgo(12)]]),
      pr(hoursAgo(10), []),
      pr(null, [["ana", hoursAgo(5)]]),
      pr(hoursAgo(10), [["ana", hoursAgo(12)], ["bo", hoursAgo(6)]]),
    ];
    // Only the last counts, from bo's approval: 4h after the request.
    assert.deepEqual(averageApproval(merged, "me"), { average: 4 * HOUR, count: 1 });
  });

  it("is nothing for no PRs", () => {
    assert.deepEqual(averageApproval([], "me"), { average: null, count: 0 });
  });
});
