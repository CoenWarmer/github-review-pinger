import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PullRequest } from "@review-pinger/app";
import {
  averageCodeOwners,
  averageReviewWait,
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
    requestedAt,
    reviews: reviews.map(([by, at]) => ({ by, at })),
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
