import type { CodeOwnerTeam, PullRequest, ReviewRequest } from "./types";

const DAY_MS = 24 * 60 * 60_000;
/** The chart is never narrower than this, so a phone scrolls it rather than squashes it. */
const MIN_TRACK_PX = 480;
/** Past this the chart scrolls, so one very old PR can't squash the rest. */
const MIN_PX_PER_DAY = 16;
/** How far apart date labels have to be to stay readable. */
const MIN_TICK_PX = 64;
const TICK_DAYS = [1, 2, 7, 14, 30, 90, 180, 365];

export interface TimelineTeam extends CodeOwnerTeam {
  /** Where its bar starts and ends along the axis, from 0 to 1. */
  start: number;
  end: number;
}

export interface TimelinePr {
  id: string;
  url: string;
  number: number;
  title: string;
  repo: string;
  openSince: string;
  draft: boolean;
  approved: boolean;
  /** Where its bar starts along the axis, from 0 to 1. */
  start: number;
  teams: TimelineTeam[];
}

export interface Timeline {
  prs: TimelinePr[];
  /** The least the bars' track takes, in pixels. */
  trackPx: number;
  /** Whole local days to label, each with where it falls along the axis, which ends at now. */
  ticks: { at: number; position: number }[];
}

/** Older saved lists don't have `codeOwnerTeams`, so fall back to the pending team chips. */
function teamsOf(pr: PullRequest | ReviewRequest): CodeOwnerTeam[] {
  return (
    pr.codeOwnerTeams ??
    pr.reviewers.flatMap((reviewer) =>
      reviewer.team
        ? [
            {
              team: reviewer.team,
              requestedAt: reviewer.requestedAt,
              pending: true,
              respondedAt: null,
              approvedAt: null,
              approvedBy: null,
            },
          ]
        : [],
    )
  );
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

/** Open PRs, newest first, each with the teams that own what it changes. */
export function buildTimeline(prs: (PullRequest | ReviewRequest)[], now: number): Timeline {
  const oldest = Math.min(now, ...prs.map((pr) => Date.parse(pr.openSince)));
  // A little room before the oldest bar. The other end is now, at the chart's edge.
  const start = oldest - Math.max((now - oldest) * 0.02, DAY_MS / 4);
  const position = (ms: number) => (ms - start) / (now - start);

  const rows = prs
    .map((pr): TimelinePr => {
      const open = Date.parse(pr.openSince);
      return {
        id: pr.id,
        url: pr.url,
        number: pr.number,
        title: pr.title,
        repo: pr.repo,
        openSince: pr.openSince,
        draft: pr.group === "draft",
        approved: pr.group !== "draft" && !!pr.approved,
        start: position(open),
        teams: teamsOf(pr).map((team) => {
          // A request made while it was a draft waited no longer than the PR did.
          const from = Math.max(team.requestedAt ? Date.parse(team.requestedAt) : open, open);
          const to = team.pending
            ? now
            : team.approvedAt || team.respondedAt
              ? Math.min(Date.parse((team.approvedAt ?? team.respondedAt)!), now)
              : from;
          return { ...team, start: position(from), end: position(Math.max(from, to)) };
        }),
      };
    })
    .sort((a, b) => b.start - a.start);

  const days = (now - start) / DAY_MS;
  const trackPx = Math.max(MIN_TRACK_PX, days * MIN_PX_PER_DAY);
  const pxPerDay = trackPx / days;
  const stepDays = TICK_DAYS.find((step) => step * pxPerDay >= MIN_TICK_PX) ?? 365;
  const ticks = dayTicks(start, now, stepDays)
    // A label is centered on its day: leave it room at the start, and beside "now".
    .filter((at) => ((at - start) / DAY_MS) * pxPerDay >= MIN_TICK_PX / 2)
    .filter((at) => ((now - at) / DAY_MS) * pxPerDay >= MIN_TICK_PX * 0.75)
    .map((at) => ({ at, position: position(at) }));

  return { prs: rows, trackPx, ticks };
}
