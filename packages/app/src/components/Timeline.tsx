import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { Check, Circle, Maximize2, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { elapsed } from "../format";
import { useReportOpen } from "../hooks";
import { usePlatform, type Platform } from "../platform";
import {
  buildTimeline,
  FIT_ALL,
  formatDuration,
  panRange,
  zoomOut,
  withState,
  zoomRange,
  type Timeline as Chart,
  type TimelinePr,
  type TimelineRange,
  type TimelineState,
  type TimelineTeam,
} from "../timeline";
import type { MergedPr, PullRequest, ReviewRequest } from "../types";

/** Width of the column of titles and team names. */
const NAME_COLUMN = 280;
const ROW = "h-[24px]";
/** Dragging across it zooms. On touch a sideways drag does that, and an upward one still scrolls. */
const TRACK = "cursor-crosshair touch-pan-y";

const WAITING = "bg-info/40";
const RESPONDED = "bg-muted-foreground/40";
const TEAM_APPROVED = "bg-success/60";
const DRAFT = "border border-dashed border-muted-foreground bg-muted";
const MERGED = "bg-violet-500";
/** How far a drag has to go to be a zoom, rather than a click with a shaky hand. */
const DRAG_PX = 4;

const STATES: { id: TimelineState; label: string }[] = [
  { id: "all", label: "All PRs" },
  { id: "open", label: "Open PRs" },
  { id: "draft", label: "Draft PRs" },
  { id: "merged", label: "Merged PRs" },
];

/** Opens a PR from the chart. One that has merged has nothing left to refresh. */
function openPr(platform: Platform, pr: TimelinePr) {
  if (pr.merged) platform.openUrl(pr.url);
  else platform.visit(pr.id, pr.url);
}

function percent(fraction: number): string {
  return `${fraction * 100}%`;
}

function teamName(team: string): string {
  return `@${team.split("/").pop()}`;
}

/** What a team's bar stands for, with how long it is where that's known. */
function describeTeam(team: TimelineTeam, now: number): string {
  // Without the request's time the bar's start is a guess, and so would its length be.
  const duration = team.requestedAt ? formatDuration(team.durationMs) : null;
  if (team.approvedAt) {
    const approved = `Approved by ${team.approvedBy}, ${elapsed(team.approvedAt, now)} ago`;
    return duration ? `${duration} · ${approved}` : approved;
  }
  if (team.pending) return duration ? `${duration} · Waiting` : "Waiting";
  if (team.respondedAt) {
    const responded = `Last response ${elapsed(team.respondedAt, now)} ago`;
    return duration ? `${duration} · ${responded}` : responded;
  }
  return "No longer requested";
}

function PrBar({ pr, now }: { pr: TimelinePr; now: number }) {
  const platform = usePlatform();
  const whole =
    pr.segments.length > 1 ? ` · ${formatDuration(pr.durationMs)} in all` : "";
  return (
    <div className={cn("relative", ROW)}>
      {pr.segments.map(
        (segment, index) =>
          segment.visible && (
            <button
              key={index}
              type="button"
              aria-label={`Open #${pr.number} ${pr.title}`}
              data-tip={`${pr.repo}#${pr.number} ${pr.title}\n${formatDuration(segment.durationMs)} · ${
                segment.draft
                  ? "Draft"
                  : pr.merged
                    ? `Merged ${elapsed(new Date(pr.endsAt).toISOString(), now)} ago`
                    : pr.approved
                      ? "Open, Approved"
                      : "Open"
              }${whole}`}
              onClick={() => openPr(platform, pr)}
              // Measured from the right, so the least width grows away from the edge.
              style={{
                right: percent(1 - segment.end),
                width: percent(segment.end - segment.start),
              }}
              className={cn(
                "absolute inset-y-[6px] min-w-1.5 cursor-pointer rounded-[3px] border-0 p-0 hover:brightness-110",
                segment.draft
                  ? DRAFT
                  : pr.merged
                    ? MERGED
                    : pr.approved
                      ? "bg-success"
                      : "bg-info",
              )}
            />
          ),
      )}
    </div>
  );
}

function TeamBar({ team, now }: { team: TimelineTeam; now: number }) {
  const description = describeTeam(team, now);
  return (
    <div className={cn("relative", ROW)}>
      {team.visible && (
        <span
          role="img"
          aria-label={`${teamName(team.team)}: ${description}`}
          data-tip={`${teamName(team.team)}\n${description}`}
          style={{
            right: percent(1 - team.end),
            width: percent(team.end - team.start),
          }}
          className={cn(
            "absolute inset-y-[7px] min-w-1 rounded-[2px]",
            team.approvedAt
              ? TEAM_APPROVED
              : team.pending
                ? WAITING
                : RESPONDED,
          )}
        />
      )}
    </div>
  );
}

function Lines({ chart }: { chart: Chart }) {
  return (
    <>
      {chart.ticks.map(({ at, position }) => (
        <span
          key={at}
          aria-hidden="true"
          className="absolute inset-y-0 w-px bg-border"
          style={{ left: percent(position) }}
        />
      ))}
      {chart.nowPosition !== null && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 right-0 w-px bg-info"
        />
      )}
    </>
  );
}

/** So approval doesn't rest on the bar's color alone. */
function Approved({ label }: { label: string }) {
  return (
    <Check
      role="img"
      aria-label={label}
      className="mr-1 inline size-3 align-[-2px] text-success"
      strokeWidth={3}
    />
  );
}

/** Takes the check's place on a team that hasn't approved, so the names line up. */
function NotApproved() {
  return (
    <Circle
      role="img"
      aria-label="Not approved yet"
      className="mr-1 inline size-3 align-[-2px] text-muted-foreground"
      strokeWidth={1.5}
    />
  );
}

/** A PR's title and its teams' names, in line with their bars. */
function Names({ pr, now }: { pr: TimelinePr; now: number }) {
  const platform = usePlatform();
  return (
    <div
      className="sticky left-0 z-10 py-1 shrink-0 border-r bg-background"
      style={{ width: NAME_COLUMN }}
    >
      <button
        type="button"
        title={`${pr.repo}#${pr.number} ${pr.title}`}
        onClick={() => openPr(platform, pr)}
        className={cn(
          "block w-full cursor-pointer truncate border-0 bg-transparent px-3 text-left text-xs leading-[28px] font-medium hover:underline",
          ROW,
        )}
      >
        {pr.approved && <Approved label="Approved" />}
        <span className="font-normal text-muted-foreground tabular-nums">
          #{pr.number}
        </span>{" "}
        {pr.title}
      </button>
      <div>
        {pr.teams.map((team) => (
          <div
            key={team.team}
            title={`${team.team} · ${describeTeam(team, now)}`}
            className={cn(
              "truncate pr-3 pl-3 text-[11px] leading-[28px] text-muted-foreground",
              ROW,
            )}
          >
            {team.approvedAt ? <Approved label="Approved" /> : <NotApproved />}
            {teamName(team.team)}
          </div>
        ))}
      </div>
    </div>
  );
}

function Legend() {
  const swatch = "inline-block h-2 w-4 rounded-[2px]";
  return (
    <p className="m-0 flex min-h-[33px] flex-wrap justify-end items-center gap-x-3 border-b px-3 py-1 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1">
        <span className={cn(swatch, DRAFT)} /> Draft
      </span>
      <span className="flex items-center gap-1">
        <span className={cn(swatch, "bg-info")} /> Open
      </span>
      <span className="flex items-center gap-1">
        <span className={cn(swatch, WAITING)} /> Waiting on team
      </span>
      <span className="flex items-center gap-1">
        <span className={cn(swatch, RESPONDED)} /> Team responded
      </span>
      <span className="flex items-center gap-1">
        <span className={cn(swatch, TEAM_APPROVED)} /> Team approved
      </span>
      <span className="flex items-center gap-1">
        <span className={cn(swatch, "bg-success")} /> Approved
      </span>
      <span className="flex items-center gap-1">
        <span className={cn(swatch, MERGED)} /> Merged
      </span>
    </p>
  );
}

/** Short enough for an axis label: a date, or a time when zoomed in that far. */
function tickLabel(ms: number, hourly: boolean): string {
  return hourly
    ? new Date(ms).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      })
    : shortDate(ms);
}

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * Follows the pointer, on whichever side of it has the room, from the moment it's
 * over a bar: a native tooltip takes a while to appear.
 */
function BarTip({ tip }: { tip: Tip }) {
  const [title, detail] = tip.text.split("\n");
  const gap = 14;
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 w-max max-w-[320px] rounded-md border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow-md"
      style={{
        left: tip.x,
        top: tip.y,
        transform: `translate(${tip.x > window.innerWidth / 2 ? `calc(-100% - ${gap}px)` : `${gap}px`}, ${
          tip.y > window.innerHeight / 2 ? `calc(-100% - ${gap}px)` : `${gap}px`
        })`,
      }}
    >
      <div className="truncate">{title}</div>
      <div className="text-muted-foreground">{detail}</div>
    </div>
  );
}

/** The stretch of time the axis shows. */
function axisLabel(chart: Chart): string {
  const end = chart.live
    ? "now"
    : chart.hourly
      ? tickLabel(chart.to, true)
      : shortDate(chart.to);
  const start = chart.hourly
    ? `${shortDate(chart.from)} ${tickLabel(chart.from, true)}`
    : shortDate(chart.from);
  return `${start} – ${end}`;
}

/** A bar's tooltip, at the pointer. */
interface Tip {
  text: string;
  x: number;
  y: number;
}

/** A drag under way across the bars, in pixels from the chart's left edge. */
interface Drag {
  pointerId: number;
  startX: number;
  /** The track's left edge and width on screen, for what the drag covers of it. */
  trackLeft: number;
  trackWidth: number;
  /** How far on screen it can reach: what's in view of the track. */
  minX: number;
  maxX: number;
  /** The chart's left edge on screen, which the highlight is placed from. */
  chartLeft: number;
  moved: boolean;
}

function Scroller({
  chart,
  now,
  range,
  onZoom,
}: {
  chart: Chart;
  now: number;
  range: TimelineRange | null;
  onZoom: (range: TimelineRange) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const justDragged = useRef(false);
  const [highlight, setHighlight] = useState<{
    left: number;
    width: number;
  } | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  // Starts at now, the end people look at. The window widening keeps it there.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [range]);

  // Sideways on a trackpad, or shift and a wheel, moves through time. Added by hand,
  // as React's own wheel listener is passive, and so can't stop the browser acting on it.
  const latest = useRef({ chart, onZoom });
  latest.current = { chart, onZoom };
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0);
      const sideways = Math.abs(dx) > Math.abs(e.shiftKey ? 0 : e.deltaY);
      // A window too narrow for the chart scrolls it by itself.
      if (!sideways || el.scrollWidth > el.clientWidth) return;
      e.preventDefault();
      const width = el
        .querySelector("[data-track]")
        ?.getBoundingClientRect().width;
      if (!width) return;
      const { chart: shown, onZoom: show } = latest.current;
      const next = panRange(shown, ((e.deltaMode === 1 ? 16 : 1) * dx) / width);
      // At either end nothing moves, and it shouldn't look zoomed either.
      if (next.from === shown.from && next.to === shown.to) return;
      setTip(null);
      show(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    justDragged.current = false;
    const track = (e.target as Element).closest("[data-track]");
    const el = scroller.current;
    if (e.button !== 0 || !track || !el) return;
    const box = track.getBoundingClientRect();
    const view = el.getBoundingClientRect();
    const minX = Math.max(box.left, view.left + NAME_COLUMN);
    const maxX = Math.min(box.right, view.left + el.clientWidth);
    drag.current = {
      pointerId: e.pointerId,
      startX: Math.min(Math.max(e.clientX, minX), maxX),
      trackLeft: box.left,
      trackWidth: box.width,
      minX,
      maxX,
      chartLeft: e.currentTarget.getBoundingClientRect().left,
      moved: false,
    };
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const over = (e.target as Element).closest("[data-tip]");
    const text =
      e.pointerType === "mouse" &&
      !drag.current?.moved &&
      over?.getAttribute("data-tip");
    setTip(text ? { text, x: e.clientX, y: e.clientY } : null);
    const current = drag.current;
    if (!current || e.pointerId !== current.pointerId) return;
    const x = Math.min(Math.max(e.clientX, current.minX), current.maxX);
    if (!current.moved) {
      if (Math.abs(x - current.startX) < DRAG_PX) return;
      current.moved = true;
      // Only now, as capturing any sooner would take the click from a bar.
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    setHighlight({
      left: Math.min(x, current.startX) - current.chartLeft,
      width: Math.abs(x - current.startX),
    });
  }

  function endDrag(e: PointerEvent<HTMLDivElement>, zoom: boolean) {
    const current = drag.current;
    if (!current || e.pointerId !== current.pointerId) return;
    drag.current = null;
    setHighlight(null);
    if (!current.moved) return;
    // What ends a drag isn't also a click on the bar it ended on.
    justDragged.current = true;
    const x = Math.min(Math.max(e.clientX, current.minX), current.maxX);
    if (!zoom || Math.abs(x - current.startX) < DRAG_PX) return;
    const along = (at: number) => (at - current.trackLeft) / current.trackWidth;
    onZoom(zoomRange(chart, along(current.startX), along(x)));
  }

  const eachTrack = { minWidth: chart.trackPx };
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
      <div
        className="relative flex w-fit min-w-full flex-col"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endDrag(e, true)}
        onPointerCancel={(e) => endDrag(e, false)}
        onPointerLeave={() => setTip(null)}
        onClickCapture={(e) => {
          if (!justDragged.current) return;
          justDragged.current = false;
          e.stopPropagation();
          e.preventDefault();
        }}
      >
        <div className="sticky top-0 z-20 flex h-7 border-b bg-background text-[10px] text-muted-foreground tabular-nums">
          <div
            className="sticky left-0 z-10 flex shrink-0 items-center border-r bg-background px-3 text-[11px] font-semibold tracking-wide uppercase"
            style={{ width: NAME_COLUMN }}
          >
            Pull request
          </div>
          <div className="flex-1 pr-2" style={eachTrack}>
            <div data-track className={cn("relative h-full", TRACK)}>
              {chart.ticks.map(({ at, position }) => (
                <span
                  key={at}
                  className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap"
                  style={{ left: percent(position) }}
                >
                  {tickLabel(at, chart.hourly)}
                </span>
              ))}
              {chart.nowPosition !== null && (
                <span className="absolute top-1/2 right-0 -translate-y-1/2 font-semibold text-info">
                  now
                </span>
              )}
            </div>
          </div>
        </div>
        {chart.prs.map((pr) => (
          <section key={pr.id} className="flex border-b">
            <Names pr={pr} now={now} />
            <div className="flex-1 pr-2 py-1" style={eachTrack}>
              <div data-track className={cn("relative", TRACK)}>
                <Lines chart={chart} />
                <PrBar pr={pr} now={now} />
                {pr.teams.map((team) => (
                  <TeamBar key={team.team} team={team} now={now} />
                ))}
              </div>
            </div>
          </section>
        ))}
        {highlight && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 z-[5] border-x border-info bg-info/15"
            style={highlight}
          />
        )}
      </div>
      {tip && <BarTip tip={tip} />}
    </div>
  );
}

/** Open PRs as bars, each with the teams that own what it changes underneath. */
export function Timeline({
  pullRequests,
  merged,
  emptyText,
  now,
}: {
  pullRequests: (PullRequest | ReviewRequest)[];
  /** What the Merged section has, for the tab that has one. */
  merged?: {
    pullRequests: MergedPr[];
    canLoadMore: boolean;
    /** The Merged section is on, without which they aren't fetched. */
    enabled: boolean;
  };
  emptyText: string;
  now: number;
}) {
  const platform = usePlatform();
  const [range, setRange] = useState<TimelineRange | null>(null);
  const [state, setState] = useState<TimelineState>("open");
  const [loadingMore, setLoadingMore] = useState(false);
  const showsMerged = state === "merged" && !!merged;
  const mergedRows = merged?.pullRequests;
  const chart = useMemo(
    () =>
      buildTimeline(
        showsMerged ? (mergedRows ?? []) : withState(pullRequests, state),
        now,
        range,
      ),
    [pullRequests, mergedRows, showsMerged, state, now, range],
  );
  // These are on screen, so a refresh should fetch them first, as with an open section.
  // Merged ones don't change, so there's nothing to refresh.
  useReportOpen(
    "timeline",
    !showsMerged,
    chart.prs.map((pr) => pr.id),
  );
  async function loadMore() {
    setLoadingMore(true);
    try {
      await platform.loadMoreMerged();
    } finally {
      setLoadingMore(false);
    }
  }
  const empty = (text: string) => (
    <p className="m-0 px-3 py-6 text-center text-muted-foreground">{text}</p>
  );
  if (
    pullRequests.length === 0 &&
    !merged?.pullRequests.length &&
    !merged?.canLoadMore
  ) {
    return empty(emptyText);
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-[33px] items-center gap-1 border-b px-3 py-2 text-[11px] text-muted-foreground tabular-nums">
        <Select
          value={state}
          onValueChange={(value) => setState(value as TimelineState)}
        >
          <SelectTrigger
            size="sm"
            className="px-2 text-[11px] data-[size=sm]:h-6"
            aria-label="Which pull requests to show"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATES.filter(({ id }) => id !== "merged" || merged).map(
              ({ id, label }) => (
                <SelectItem key={id} value={id} className="text-xs">
                  {label}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
        {showsMerged && merged.canLoadMore && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={loadingMore}
            onClick={loadMore}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        )}
        <span className="mr-1 ml-auto">{axisLabel(chart)}</span>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          aria-label="Zoom out"
          title="Zoom out"
          disabled={!chart.canZoomOut}
          onClick={() => setRange(zoomOut(chart))}
        >
          <ZoomOut />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          aria-label="Fit all pull requests"
          title="Fit all pull requests"
          disabled={!chart.canZoomOut}
          onClick={() => setRange(FIT_ALL)}
        >
          <Maximize2 />
        </Button>
        {range && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => setRange(null)}
          >
            7 days
          </Button>
        )}
      </div>
      <Legend />
      {chart.prs.length === 0 ? (
        empty(
          showsMerged && !merged.enabled
            ? "Turn on the Merged section in Settings to see merged pull requests here."
            : state === "all"
              ? emptyText
              : `No ${state} pull requests.`,
        )
      ) : (
        <Scroller chart={chart} now={now} range={range} onZoom={setRange} />
      )}
    </div>
  );
}
