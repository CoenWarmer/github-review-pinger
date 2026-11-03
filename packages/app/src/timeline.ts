import type { PullRequest } from "./types";

const DAY_MS = 24 * 60 * 60_000;
/** The chart is never narrower than this, so a phone scrolls it rather than squashes it. */
const MIN_TRACK_PX = 640;
/** Past this the chart scrolls, so one very old PR can't squash the rest. */
const MIN_PX_PER_DAY = 16;
/** How far apart date labels have to be to stay readable. */
const MIN_TICK_PX = 64;
const TICK_DAYS = [1, 2, 7, 14, 30, 90, 180, 365];

export interface TimelineBar {
  id: string;
  url: string;
  number: number;
  title: string;
  repo: string;
  openSince: string;
  draft: boolean;
  /** Where it starts along the axis, from 0 to 1. */
  start: number;
}

export interface TimelineRow {
  /** Lowercase `org/slug`, or `null` for the PRs with no team requested. */
  team: string | null;
  bars: TimelineBar[];
}

export interface Timeline {
  rows: TimelineRow[];
  /** The least the bars' track takes, in pixels. */
  trackPx: number;
  /** Whole local days to label, each with where it falls along the axis. */
  ticks: { at: number; position: number }[];
  /** Where now falls along the axis, from 0 to 1. */
  nowPosition: number;
}

/** Older saved lists don't have `requestedTeams`, so fall back to the pending team chips. */
function teamsOf(pr: PullRequest): string[] {
  return pr.requestedTeams ?? pr.reviewers.flatMap((reviewer) => reviewer.team ?? []);
}

/** The whole local days from `start` to `end`, `stepDays` apart. */
function dayTicks(start: number, end: number, stepDays: number): number[] {
  const day = new Date(start);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() + 1);
  const ticks: number[] = [];
  while (day.getTime() < end) {
    ticks.push(day.getTime());
    day.setDate(day.getDate() + stepDays);
  }
  return ticks;
}

/**
 * Your open PRs under each team requested on them, so a PR two teams were asked
 * about shows in both. Teams go alphabetically with "no team" last, and the
 * longest open PR comes first in each.
 */
export function buildTimeline(prs: PullRequest[], now: number): Timeline {
  const oldest = Math.min(now, ...prs.map((pr) => Date.parse(pr.openSince)));
  // A little room at both ends, so neither the oldest bar nor now is on the edge.
  const margin = Math.max((now - oldest) * 0.02, DAY_MS / 4);
  const start = oldest - margin;
  const end = now + margin;
  const position = (ms: number) => (ms - start) / (end - start);

  const byTeam = new Map<string | null, TimelineBar[]>();
  for (const pr of prs) {
    const bar: TimelineBar = {
      id: pr.id,
      url: pr.url,
      number: pr.number,
      title: pr.title,
      repo: pr.repo,
      openSince: pr.openSince,
      draft: pr.group === "draft",
      start: position(Date.parse(pr.openSince)),
    };
    const teams = teamsOf(pr);
    for (const team of teams.length > 0 ? teams : [null]) {
      byTeam.set(team, [...(byTeam.get(team) ?? []), bar]);
    }
  }

  const rows = [...byTeam]
    .map(([team, bars]) => ({
      team,
      bars: bars.sort((a, b) => a.start - b.start),
    }))
    .sort((a, b) =>
      a.team === null ? 1 : b.team === null ? -1 : a.team.localeCompare(b.team),
    );

  const days = (end - start) / DAY_MS;
  const trackPx = Math.max(MIN_TRACK_PX, days * MIN_PX_PER_DAY);
  const pxPerDay = trackPx / days;
  const stepDays = TICK_DAYS.find((step) => step * pxPerDay >= MIN_TICK_PX) ?? 365;
  const ticks = dayTicks(start, end, stepDays)
    // A label is centered on its day: leave it room at the start, and beside "now".
    .filter((at) => ((at - start) / DAY_MS) * pxPerDay >= MIN_TICK_PX / 2)
    .filter((at) => ((now - at) / DAY_MS) * pxPerDay >= MIN_TICK_PX / 2)
    .map((at) => ({ at, position: position(at) }));

  return { rows, trackPx, ticks, nowPosition: position(now) };
}
