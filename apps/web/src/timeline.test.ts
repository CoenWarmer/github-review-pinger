import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PullRequest } from "@review-pinger/app";
import { buildTimeline } from "../../../packages/app/src/timeline.ts";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const DAY = 24 * 60 * 60_000;
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();

const mine = (id: string, days: number, teams?: string[], group = "waiting"): PullRequest =>
  ({
    id,
    number: 1,
    title: id,
    url: `https://github.com/o/r/pull/${id}`,
    repo: "o/r",
    group,
    openSince: daysAgo(days),
    reviewers: [],
    requestedTeams: teams,
  }) as unknown as PullRequest;

describe("buildTimeline", () => {
  it("is empty with no pull requests", () => {
    const chart = buildTimeline([], NOW);
    assert.deepEqual(chart.rows, []);
    assert.ok(Number.isFinite(chart.nowPosition));
  });

  it("lists a PR under every team requested on it, with no team last", () => {
    const chart = buildTimeline(
      [mine("a", 3, ["o/web", "o/core"]), mine("b", 2, []), mine("c", 1, ["o/web"])],
      NOW,
    );
    assert.deepEqual(
      chart.rows.map((row) => [row.team, row.bars.map((bar) => bar.id)]),
      [
        ["o/core", ["a"]],
        ["o/web", ["a", "c"]],
        [null, ["b"]],
      ],
    );
  });

  it("puts the longest open first", () => {
    const chart = buildTimeline([mine("new", 1, ["o/t"]), mine("old", 5, ["o/t"])], NOW);
    const [row] = chart.rows;
    assert.deepEqual(row.bars.map((bar) => bar.id), ["old", "new"]);
    assert.ok(row.bars[0].start < row.bars[1].start);
    assert.ok(row.bars[1].start < chart.nowPosition);
  });

  it("marks drafts", () => {
    const chart = buildTimeline([mine("d", 1, [], "draft")], NOW);
    assert.equal(chart.rows[0].bars[0].draft, true);
  });

  it("falls back to pending team chips for lists saved before requestedTeams", () => {
    const saved = {
      ...mine("a", 1),
      reviewers: [{ team: "o/web" }, { team: null }],
    } as unknown as PullRequest;
    assert.deepEqual(buildTimeline([saved], NOW).rows.map((row) => row.team), ["o/web"]);
  });

  it("scrolls rather than squashes around one very old PR", () => {
    const chart = buildTimeline([mine("old", 400, []), mine("new", 1, [])], NOW);
    assert.ok(chart.trackPx >= 400 * 16);
  });

  it("keeps a minimum width, and labels within the axis, before now", () => {
    const chart = buildTimeline([mine("a", 10, [])], NOW);
    assert.equal(chart.trackPx, 640);
    assert.ok(chart.ticks.length > 0);
    for (const { at, position } of chart.ticks) {
      assert.ok(at < NOW);
      assert.ok(position > 0 && position < chart.nowPosition);
      // Room for a label centered on it, at both ends.
      assert.ok(position * chart.trackPx >= 32);
      assert.ok((chart.nowPosition - position) * chart.trackPx >= 32);
    }
  });
});
