import type { CodeOwnerTeam, MergedPr, PullRequest, ReviewRequest } from "./types";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** The chart is never narrower than this, so a phone scrolls it rather than squashes it. */
const TRACK_PX = 480;
/** What the chart shows until it's zoomed. */
const DEFAULT_DAYS = 7;
/** How far apart date labels have to be to stay readable. */
const MIN_TICK_PX = 64;
const TICK_HOURS = [1, 2, 3, 6, 12, 24, 48, 168, 336, 720, 2160, 4320, 8760];
/** How far a zoom can go, so it can't end up between two labels. */
const MIN_ZOOM_MS = HOUR_MS;

/** A stretch of time the chart is zoomed in to, in epoch milliseconds. */
export interface TimelineRange {
  from: number;
  to: number;
  /** It ends at now, whenever that is, rather than at `to`. */
  live?: boolean;
}

/** Which PRs the chart shows, by what they are now. */
export type TimelineState = "all" | "open" | "draft" | "merged";

/** The PRs that are currently `state`. */
export function withState<T extends PullRequest | ReviewRequest>(
  prs: T[],
  state: TimelineState,
): T[] {
  if (state === "all") return prs;
  const isDraft = (pr: T) =>
    // Older saved lists only say which section it's in.
    pr.draftSpans ? pr.draftSpans.some((span) => span.to === null) : pr.group === "draft";
  return prs.filter((pr) => isDraft(pr) === (state === "draft"));
}

/** As far out as it goes: everything, until the longest bar fits. */
export const FIT_ALL: TimelineRange = { from: 0, to: 0, live: true };

/** Where a bar falls along the axis, from 0 to 1, cut off at the axis's ends. */
interface Placed {
  start: number;
  end: number;
  /** Any of it falls within the axis. */
  visible: boolean;
  /** How long the whole bar is, even where the axis cuts it off. */
  durationMs: number;
}

export interface TimelineTeam extends CodeOwnerTeam, Placed {}

/** A stretch of a PR's bar: as a draft, or open. */
export interface TimelineSegment extends Placed {
  draft: boolean;
}

export interface TimelinePr extends Placed {
  id: string;
  url: string;
  number: number;
  title: string;
  repo: string;
  /** Whether it's a draft now. */
  draft: boolean;
  /** It has merged, so its bar ends there rather than at now. */
  merged: boolean;
  /** When its bar ends. */
  endsAt: number;
  approved: boolean;
  /** Its bar, oldest first, from when it was created to now. */
  segments: TimelineSegment[];
  teams: TimelineTeam[];
}

export interface Timeline extends TimelineRange {
  prs: TimelinePr[];
  now: number;
  /** As far back as the axis can start: where the longest bar fits, or the default. */
  earliest: number;
  /** There's more to see by zooming out. */
  canZoomOut: boolean;
  /** The least the bars' track takes, in pixels. */
  trackPx: number;
  /** Times to label, each with where it falls along the axis. */
  ticks: { at: number; position: number }[];
  /** The labels are close enough together to be times, rather than days. */
  hourly: boolean;
  /** Where now falls along the axis; `null` when zoomed in to before it. */
  nowPosition: number | null;
}

/** Days and hours, leaving out whichever is zero: "3 days 4 hours", "5 hours", "1 day". */
export function formatDuration(ms: number): string {
  const totalHours = Math.floor(ms / HOUR_MS);
  if (totalHours < 1) return "under an hour";
  const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return [days > 0 && count(days, "day"), hours > 0 && count(hours, "hour")]
    .filter(Boolean)
    .join(" ");
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
    // Counted from a fixed day, Monday in fact, so they stay put as the chart pans.
    tick.setHours(0, 0, 0, 0);
    const stepDays = stepHours / 24;
    const day = Date.UTC(tick.getFullYear(), tick.getMonth(), tick.getDate()) / DAY_MS + 3;
    tick.setDate(tick.getDate() - (day % stepDays));
  }
  const ticks: number[] = [];
  while (tick.getTime() < end) {
    if (tick.getTime() > start) ticks.push(tick.getTime());
    tick.setHours(tick.getHours() + stepHours);
  }
  return ticks;
}

/** When it was a draft and when open, from `start` to `now`, as times. */
function pieces(
  pr: PullRequest | ReviewRequest,
  start: number,
  now: number,
): { from: number; to: number; draft: boolean }[] {
  // Older saved lists only say what it is now.
  const spans =
    pr.draftSpans ?? (pr.group === "draft" ? [{ from: pr.openSince, to: null }] : []);
  const result: { from: number; to: number; draft: boolean }[] = [];
  let at = start;
  for (const span of spans) {
    const from = Math.max(Date.parse(span.from), at);
    const to = Math.min(span.to ? Date.parse(span.to) : now, now);
    if (from > at) result.push({ from: at, to: from, draft: false });
    if (to > from) result.push({ from, to, draft: true });
    at = Math.max(at, to);
  }
  if (now > at || result.length === 0) result.push({ from: at, to: now, draft: false });
  return result;
}

/**
 * Open PRs, newest first, each with the teams that own what it changes. Without
 * a `range` the axis shows the last week.
 */
export function buildTimeline(
  prs: (PullRequest | ReviewRequest | MergedPr)[],
  now: number,
  range: TimelineRange | null = null,
): Timeline {
  const createdAt = (pr: PullRequest | ReviewRequest | MergedPr) => {
    // A list saved before it existed doesn't say.
    const fallback = "mergedAt" in pr ? pr.mergedAt : pr.openSince;
    return Date.parse(pr.createdAt ?? fallback);
  };
  const oldest = Math.min(now, ...prs.map(createdAt));
  const week = now - DEFAULT_DAYS * DAY_MS;
  // A little room before the oldest bar.
  const earliest = Math.min(oldest - Math.max((now - oldest) * 0.02, DAY_MS / 4), week);
  const from = range ? Math.max(range.from, earliest) : week;
  const live = !range || !!range.live;
  const to = live ? now : range.to;
  const position = (ms: number) => (ms - from) / (to - from);
  const place = (start: number, end: number): Placed => ({
    start: Math.max(position(start), 0),
    end: Math.min(position(end), 1),
    visible: start <= to && end >= from,
    durationMs: end - start,
  });

  const rows = prs
    .map((pr): TimelinePr => {
      if ("mergedAt" in pr) {
        const endsAt = Math.min(Date.parse(pr.mergedAt), now);
        const start = Math.min(createdAt(pr), endsAt);
        return {
          id: pr.id,
          url: pr.url,
          number: pr.number,
          title: pr.title,
          repo: pr.repo,
          draft: false,
          merged: true,
          endsAt,
          approved: false,
          ...place(start, endsAt),
          // Its draft history isn't fetched: nothing else about it needs that query.
          segments: [{ draft: false, ...place(start, endsAt) }],
          teams: [],
        };
      }
      const open = Date.parse(pr.openSince);
      const created = Math.min(createdAt(pr), open);
      const segments = pieces(pr, created, now).map(({ from: start, to: end, draft }) => ({
        draft,
        ...place(start, end),
      }));
      const draft = segments[segments.length - 1].draft;
      return {
        id: pr.id,
        url: pr.url,
        number: pr.number,
        title: pr.title,
        repo: pr.repo,
        draft,
        merged: false,
        endsAt: now,
        approved: !draft && !!pr.approved,
        ...place(created, now),
        segments,
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
    // The latest to end first, which for open PRs, all ending now, is the shortest: the newest.
    .sort((a, b) => b.endsAt - a.endsAt || a.durationMs - b.durationMs);

  const pxPerHour = TRACK_PX / ((to - from) / HOUR_MS);
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
    now,
    from,
    to,
    live,
    earliest,
    canZoomOut: from > earliest || !live,
    trackPx: TRACK_PX,
    ticks,
    hourly: stepHours < 24,
    nowPosition: showsNow ? position(now) : null,
  };
}

/** The range between two places along the axis (from 0 to 1, either way round). */
export function zoomRange(axis: TimelineRange, a: number, b: number): TimelineRange {
  const at = (fraction: number) => axis.from + fraction * (axis.to - axis.from);
  const end = (from: number, to: number): TimelineRange =>
    // Reaching the end of an axis that ends at now, it keeps on doing that.
    axis.live && to >= axis.to ? { from, to, live: true } : { from, to };
  const from = at(Math.min(a, b));
  const to = at(Math.max(a, b));
  if (to - from >= MIN_ZOOM_MS) return end(from, to);
  // Too narrow to read: widen it around its middle, staying on the axis.
  const start = Math.max((from + to - MIN_ZOOM_MS) / 2, axis.from);
  const stop = Math.min(start + MIN_ZOOM_MS, axis.to);
  return end(stop - MIN_ZOOM_MS, stop);
}

/**
 * The same length of time as `chart` shows, moved later by `by` of its length (or
 * earlier when negative), staying between as far back as it goes and now.
 */
export function panRange(chart: Timeline, by: number): TimelineRange {
  const span = chart.to - chart.from;
  const to = Math.min(Math.max(chart.to + by * span, chart.earliest + span), chart.now);
  const from = to - span;
  return to >= chart.now ? { from, to, live: true } : { from, to };
}

/** Twice as much as `chart` shows, around its middle, up to everything. */
export function zoomOut(chart: Timeline): TimelineRange {
  const span = (chart.to - chart.from) * 2;
  const middle = (chart.from + chart.to) / 2;
  const to = chart.live ? chart.now : Math.min(middle + span / 2, chart.now);
  const from = Math.max(to - span, chart.earliest);
  const stop = Math.min(from + span, chart.now);
  if (from <= chart.earliest && stop >= chart.now) return FIT_ALL;
  return stop >= chart.now ? { from, to: stop, live: true } : { from, to: stop };
}
