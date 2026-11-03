import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PullRequest } from "@review-pinger/app";
import { buildTimeline } from "../../../packages/app/src/timeline.ts";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const DAY = 24 * 60 * 60_000;
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();

const pr = (id: string, days: number, teams?: object[], group = "waiting"): PullRequest =>
  ({
    id,
    number: 1,
    title: id,
    url: `https://github.com/o/r/pull/${id}`,
    repo: "o/r",
    group,
    openSince: daysAgo(days),
    reviewers: [],
    codeOwnerTeams: teams,
  }) as unknown as PullRequest;

const owner = (team: string, requested: number | null, pending = true, responded: number | null = null) => ({
  team,
  requestedAt: requested === null ? null : daysAgo(requested),
  pending,
  respondedAt: responded === null ? null : daysAgo(responded),
});

describe("buildTimeline", () => {
  it("is empty with no pull requests", () => {
    const chart = buildTimeline([], NOW);
    assert.deepEqual(chart.prs, []);
    assert.ok(Number.isFinite(chart.trackPx));
  });

  it("puts the newest PR first, with its own teams", () => {
    const chart = buildTimeline(
      [pr("new", 1, [owner("o/web", 1)]), pr("old", 5, [owner("o/core", 5), owner("o/web", 4)]), pr("none", 2, [])],
      NOW,
    );
    assert.deepEqual(
      chart.prs.map((row) => [row.id, row.teams.map((team) => team.team)]),
      [
        ["new", ["o/web"]],
        ["none", []],
        ["old", ["o/core", "o/web"]],
      ],
    );
    assert.ok(chart.prs[2].start < chart.prs[0].start);
    assert.ok(chart.prs[0].start < 1);
  });

  it("ends the axis at now, so a pending team's bar reaches the edge", () => {
    const chart = buildTimeline([pr("a", 200, [owner("o/waiting", 4)])], NOW);
    assert.equal(chart.prs[0].teams[0].end, 1);
  });

  it("runs a pending team's bar to now, and one that responded to its response", () => {
    const chart = buildTimeline(
      [pr("a", 10, [owner("o/waiting", 4), owner("o/done", 8, false, 6)])],
      NOW,
    );
    const [waiting, done] = chart.prs[0].teams;
    assert.equal(waiting.end, 1);
    assert.ok(done.start < done.end);
    assert.ok(done.end < waiting.start);
  });

  it("keeps a team with no known response to a mark where it was requested", () => {
    const chart = buildTimeline([pr("a", 10, [owner("o/gone", 5, false)])], NOW);
    const [gone] = chart.prs[0].teams;
    assert.equal(gone.start, gone.end);
    assert.ok(gone.start > chart.prs[0].start);
  });

  it("starts a team no earlier than the PR, or at it when the request isn't known", () => {
    const chart = buildTimeline([pr("a", 5, [owner("o/early", 9), owner("o/unknown", null)])], NOW);
    const [row] = chart.prs;
    assert.equal(row.teams[0].start, row.start);
    assert.equal(row.teams[1].start, row.start);
  });

  it("marks drafts", () => {
    assert.equal(buildTimeline([pr("d", 1, [], "draft")], NOW).prs[0].draft, true);
  });

  it("falls back to pending team chips for lists saved before codeOwnerTeams", () => {
    const saved = {
      ...pr("a", 1),
      reviewers: [{ team: "o/web", requestedAt: daysAgo(1) }, { team: null, requestedAt: null }],
    } as unknown as PullRequest;
    assert.deepEqual(buildTimeline([saved], NOW).prs[0].teams.map((team) => team.team), ["o/web"]);
  });

  it("scrolls rather than squashes around one very old PR", () => {
    const chart = buildTimeline([pr("old", 400, []), pr("new", 1, [])], NOW);
    assert.ok(chart.trackPx >= 400 * 16);
  });

  it("keeps a minimum width, and labels within the axis, before now", () => {
    const chart = buildTimeline([pr("a", 10, [])], NOW);
    assert.equal(chart.trackPx, 480);
    assert.ok(chart.ticks.length > 0);
    for (const { at, position } of chart.ticks) {
      assert.ok(at < NOW);
      assert.ok(position > 0 && position < 1);
      // Room for a label centered on it, and for "now" beside it.
      assert.ok(position * chart.trackPx >= 32);
      assert.ok((1 - position) * chart.trackPx >= 48);
    }
  });
});
