import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PullRequest } from "@review-pinger/app";
import { buildTimeline, formatDuration, zoomRange } from "../../../packages/app/src/timeline.ts";

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

const owner = (
  team: string,
  requested: number | null,
  pending = true,
  responded: number | null = null,
  approved: number | null = null,
) => ({
  team,
  requestedAt: requested === null ? null : daysAgo(requested),
  pending,
  respondedAt: responded === null ? null : daysAgo(responded),
  approvedAt: approved === null ? null : daysAgo(approved),
  approvedBy: approved === null ? null : "ana",
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

  it("ends an approving team's bar at its approval, not a later comment", () => {
    const chart = buildTimeline(
      [pr("a", 10, [owner("o/ok", 8, false, 1, 5), owner("o/talked", 8, false, 5)])],
      NOW,
    );
    const [ok, talked] = chart.prs[0].teams;
    assert.equal(ok.end, talked.end);
    assert.ok(ok.approvedAt);
    assert.equal(talked.approvedAt, null);
  });

  it("says which PRs are approved, but never a draft", () => {
    const approved = (group: string) =>
      buildTimeline([{ ...pr("a", 1, [], group), approved: true } as PullRequest], NOW).prs[0].approved;
    assert.equal(approved("approved"), true);
    assert.equal(approved("draft"), false);
    assert.equal(buildTimeline([pr("a", 1, [])], NOW).prs[0].approved, false);
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

  describe("zoomed in", () => {
    const range = { from: NOW - 8 * DAY, to: NOW - 4 * DAY };

    it("fits the window, whatever the stretch", () => {
      const chart = buildTimeline([pr("a", 400, [])], NOW, { from: NOW - 300 * DAY, to: NOW - DAY });
      assert.equal(chart.trackPx, 480);
    });

    it("cuts bars off at the axis, and marks those outside it", () => {
      const chart = buildTimeline(
        [pr("across", 10, []), pr("inside", 6, []), pr("after", 2, [])],
        NOW,
        range,
      );
      const bar = (id: string) => chart.prs.find((row) => row.id === id)!;
      assert.deepEqual(chart.prs.length, 3);
      assert.equal(bar("across").start, 0);
      assert.equal(bar("across").end, 1);
      assert.equal(bar("across").visible, true);
      assert.equal(bar("inside").start, 0.5);
      assert.equal(bar("inside").visible, true);
      assert.equal(bar("after").visible, false);
    });

    it("hides a team's bar that ended before the stretch", () => {
      const chart = buildTimeline(
        [pr("a", 20, [owner("o/done", 18, false, 15, 15), owner("o/waiting", 6)])],
        NOW,
        range,
      );
      const [done, waiting] = chart.prs[0].teams;
      assert.equal(done.visible, false);
      assert.equal(waiting.visible, true);
    });

    it("has no now, unless the stretch reaches it", () => {
      assert.equal(buildTimeline([pr("a", 10, [])], NOW, range).nowPosition, null);
      const toNow = buildTimeline([pr("a", 10, [])], NOW, { from: NOW - DAY, to: NOW });
      assert.equal(toNow.nowPosition, 1);
    });

    it("labels hours when zoomed in that far, and days otherwise", () => {
      const hours = buildTimeline([pr("a", 10, [])], NOW, { from: NOW - 6 * 3600_000, to: NOW - 3600_000 });
      assert.equal(hours.hourly, true);
      assert.ok(hours.ticks.length > 0);
      for (const { position } of hours.ticks) assert.ok(position > 0 && position < 1);
      assert.equal(buildTimeline([pr("a", 10, [])], NOW, range).hourly, false);
    });
  });

  describe("formatDuration", () => {
    const HOUR = 3600_000;

    it("gives days and hours", () => {
      assert.equal(formatDuration(3 * DAY + 4 * HOUR), "3 days 4 hours");
    });

    it("leaves out days under 24 hours", () => {
      assert.equal(formatDuration(5 * HOUR), "5 hours");
      assert.equal(formatDuration(23 * HOUR + 59 * 60_000), "23 hours");
    });

    it("leaves out hours on a whole day, and uses the singular for one", () => {
      assert.equal(formatDuration(DAY), "1 day");
      assert.equal(formatDuration(2 * DAY), "2 days");
      assert.equal(formatDuration(HOUR), "1 hour");
      assert.equal(formatDuration(DAY + HOUR), "1 day 1 hour");
    });

    it("says so under an hour", () => {
      assert.equal(formatDuration(0), "under an hour");
      assert.equal(formatDuration(59 * 60_000), "under an hour");
    });
  });

  it("gives a bar's whole duration, even where a zoom cuts it off", () => {
    const whole = buildTimeline([pr("a", 10, [owner("o/t", 8)])], NOW).prs[0];
    assert.equal(whole.durationMs, 10 * DAY);
    assert.equal(whole.teams[0].durationMs, 8 * DAY);
    const zoomed = buildTimeline([pr("a", 10, [owner("o/t", 8)])], NOW, { from: NOW - 6 * DAY, to: NOW - 4 * DAY }).prs[0];
    assert.equal(zoomed.durationMs, 10 * DAY);
    assert.equal(zoomed.teams[0].durationMs, 8 * DAY);
  });

  describe("zoomRange", () => {
    const axis = { from: 0, to: 100 * 3600_000 };

    it("takes the stretch between two places, either way round", () => {
      const expected = { from: 25 * 3600_000, to: 50 * 3600_000 };
      assert.deepEqual(zoomRange(axis, 0.25, 0.5), expected);
      assert.deepEqual(zoomRange(axis, 0.5, 0.25), expected);
    });

    it("widens a stretch under an hour, staying on the axis", () => {
      const middle = zoomRange(axis, 0.5, 0.5);
      assert.equal(middle.to - middle.from, 3600_000);
      const end = zoomRange(axis, 0.999, 1);
      assert.equal(end.to, axis.to);
      assert.equal(end.to - end.from, 3600_000);
      const start = zoomRange(axis, 0, 0.001);
      assert.equal(start.from, axis.from);
      assert.equal(start.to - start.from, 3600_000);
    });
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
