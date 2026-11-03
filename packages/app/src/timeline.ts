import type { CodeOwnerTeam, PullRequest, ReviewRequest } from "./types";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** The chart is never narrower than this, so a phone scrolls it rather than squashes it. */
const MIN_TRACK_PX = 480;
/** Past this the chart scrolls, so one very old PR can't squash the rest. */
const MIN_PX_PER_DAY = 16;
/** How far apart date labels have to be to stay readable. */
const MIN_TICK_PX = 64;
const TICK_HOURS = [1, 2, 3, 6, 12, 24, 48, 168, 336, 720, 2160, 4320, 8760];
/** How far a zoom can go, so it can't end up between two labels. */
const MIN_ZOOM_MS = HOUR_MS;

/** A stretch of time the chart is zoomed in to, in epoch milliseconds. */
export interface TimelineRange {
  from: number;
  to: number;
}

/** Where a bar falls along the axis, from 0 to 1, cut off at the axis's ends. */
interface Placed {
  start: number;
  end: number;
  /** Any of it falls within the axis. */
  visible: boolean;
}

export interface TimelineTeam extends CodeOwnerTeam, Placed {}

export interface TimelinePr extends Placed {
  id: string;
  url: string;
  number: number;
  title: string;
  repo: string;
  openSince: string;
  draft: boolean;
  approved: boolean;
  teams: TimelineTeam[];
}

export interface Timeline extends TimelineRange {
  prs: TimelinePr[];
  /** The least the bars' track takes, in pixels. */
  trackPx: number;
  /** Times to label, each with where it falls along the axis. */
  ticks: { at: number; position: number }[];
  /** The labels are close enough together to be times, rather than days. */
  hourly: boolean;
  /** Where now falls along the axis; `null` when zoomed in to before it. */
  nowPosition: number | null;
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

/** Whole local days (or, under a day apart, hours) from `start` to `end`, `stepHours` apart. */
function timeTicks(start: number, end: number, stepHours: number): number[] {
  const tick = new Date(start);
  if (stepHours < 24) {
    tick.setHours(tick.getHours() - (tick.getHours() % stepHours), 0, 0, 0);
  } else {
    tick.setHours(0, 0, 0, 0);
  }
  const ticks: number[] = [];
  while (tick.getTime() < end) {
    if (tick.getTime() > start) ticks.push(tick.getTime());
    tick.setHours(tick.getHours() + stepHours);
  }
  return ticks;
}

/**
 * Open PRs, newest first, each with the teams that own what it changes. Without
 * a `range` the axis runs from the oldest PR to now.
 */
export function buildTimeline(
  prs: (PullRequest | ReviewRequest)[],
  now: number,
  range: TimelineRange | null = null,
): Timeline {
  const oldest = Math.min(now, ...prs.map((pr) => Date.parse(pr.openSince)));
  // A little room before the oldest bar. The other end is now, at the chart's edge.
  const from = range?.from ?? oldest - Math.max((now - oldest) * 0.02, DAY_MS / 4);
  const to = range?.to ?? now;
  const position = (ms: number) => (ms - from) / (to - from);
  const place = (start: number, end: number): Placed => ({
    start: Math.max(position(start), 0),
    end: Math.min(position(end), 1),
    visible: start <= to && end >= from,
  });

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
        ...place(open, now),
        teams: teamsOf(pr).map((team) => {
          // A request made while it was a draft waited no longer than the PR did.
          const start = Math.max(team.requestedAt ? Date.parse(team.requestedAt) : open, open);
          const end = team.pending
            ? now
            : team.approvedAt || team.respondedAt
              ? Math.min(Date.parse((team.approvedAt ?? team.respondedAt)!), now)
              : start;
          return { ...team, ...place(start, Math.max(start, end)) };
        }),
      };
    })
    .sort((a, b) => Date.parse(b.openSince) - Date.parse(a.openSince));

  const days = (to - from) / DAY_MS;
  // A zoom fits the window, as that's what was asked to be seen.
  const trackPx = range ? MIN_TRACK_PX : Math.max(MIN_TRACK_PX, days * MIN_PX_PER_DAY);
  const pxPerHour = trackPx / (days * 24);
  const stepHours = TICK_HOURS.find((step) => step * pxPerHour >= MIN_TICK_PX) ?? 8760;
  const showsNow = to >= now;
  const ticks = timeTicks(from, to, stepHours)
    // A label is centered on its time: leave it room at the start, and at the end or beside "now".
    .filter((at) => ((at - from) / HOUR_MS) * pxPerHour >= MIN_TICK_PX / 2)
    .filter(
      (at) => ((to - at) / HOUR_MS) * pxPerHour >= (showsNow ? MIN_TICK_PX * 0.75 : MIN_TICK_PX / 2),
    )
    .map((at) => ({ at, position: position(at) }));

  return {
    prs: rows,
    from,
    to,
    trackPx,
    ticks,
    hourly: stepHours < 24,
    nowPosition: showsNow ? position(now) : null,
  };
}

/** The range between two places along the axis (from 0 to 1, either way round). */
export function zoomRange(axis: TimelineRange, a: number, b: number): TimelineRange {
  const at = (fraction: number) => axis.from + fraction * (axis.to - axis.from);
  const from = at(Math.min(a, b));
  const to = at(Math.max(a, b));
  if (to - from >= MIN_ZOOM_MS) return { from, to };
  // Too narrow to read: widen it around its middle, staying on the axis.
  const start = Math.max((from + to - MIN_ZOOM_MS) / 2, axis.from);
  const end = Math.min(start + MIN_ZOOM_MS, axis.to);
  return { from: end - MIN_ZOOM_MS, to: end };
}
