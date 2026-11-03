import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Check, Circle, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { elapsed } from "../format";
import { useReportOpen } from "../hooks";
import { usePlatform } from "../platform";
import {
  buildTimeline,
  zoomRange,
  type Timeline as Chart,
  type TimelinePr,
  type TimelineRange,
  type TimelineTeam,
} from "../timeline";
import type { PullRequest, ReviewRequest } from "../types";

/** Width of the column of titles and team names. */
const NAME_COLUMN = 280;
const ROW = "h-[28px]";
/** Dragging across it zooms. On touch a sideways drag does that, and an upward one still scrolls. */
const TRACK = "cursor-crosshair touch-pan-y";

const WAITING = "bg-info/40";
const RESPONDED = "bg-muted-foreground/40";
const TEAM_APPROVED = "bg-success/60";
const DRAFT = "border border-dashed border-muted-foreground bg-muted";
/** How far a drag has to go to be a zoom, rather than a click with a shaky hand. */
const DRAG_PX = 4;

function percent(fraction: number): string {
  return `${fraction * 100}%`;
}

function teamName(team: string): string {
  return `@${team.split("/").pop()}`;
}

function describeTeam(team: TimelineTeam, now: number): string {
  const name = teamName(team.team);
  if (team.approvedAt) {
    return `${name}: approved ${elapsed(team.approvedAt, now)} ago by ${team.approvedBy}`;
  }
  if (team.pending) {
    return team.requestedAt
      ? `${name}: waiting ${elapsed(team.requestedAt, now)}`
      : `${name}: waiting`;
  }
  return team.respondedAt
    ? `${name}: last response ${elapsed(team.respondedAt, now)} ago`
    : `${name}: no longer requested`;
}

function PrBar({ pr, now }: { pr: TimelinePr; now: number }) {
  const platform = usePlatform();
  return (
    <div className={cn("relative", ROW)}>
      {pr.visible && (
      <button
        type="button"
        aria-label={`Open #${pr.number} ${pr.title}`}
        title={`${pr.repo}#${pr.number} ${pr.title} · ${pr.draft ? "draft" : "open"} ${elapsed(pr.openSince, now)}${pr.approved ? " · approved" : ""}`}
        onClick={() => platform.visit(pr.id, pr.url)}
        // Measured from the right, so the least width grows away from the edge.
        style={{ right: percent(1 - pr.end), width: percent(pr.end - pr.start) }}
        className={cn(
          "absolute inset-y-[6px] min-w-1.5 cursor-pointer rounded-[3px] border-0 p-0 hover:brightness-110",
          pr.draft ? DRAFT : pr.approved ? "bg-success" : "bg-info",
        )}
      />
      )}
    </div>
  );
}

function TeamBar({ team, now }: { team: TimelineTeam; now: number }) {
  return (
    <div className={cn("relative", ROW)}>
      {team.visible && (
      <span
        title={describeTeam(team, now)}
        style={{ right: percent(1 - team.end), width: percent(team.end - team.start) }}
        className={cn(
          "absolute inset-y-[9px] min-w-1 rounded-[2px]",
          team.approvedAt ? TEAM_APPROVED : team.pending ? WAITING : RESPONDED,
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
        <span aria-hidden="true" className="absolute inset-y-0 right-0 w-px bg-info" />
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
      strokeWidth={2.5}
    />
  );
}

/** A PR's title and its teams' names, in line with their bars. */
function Names({ pr, now }: { pr: TimelinePr; now: number }) {
  const platform = usePlatform();
  return (
    <div
      className="sticky left-0 z-10 shrink-0 border-r bg-background"
      style={{ width: NAME_COLUMN }}
    >
      <button
        type="button"
        title={`${pr.repo}#${pr.number} ${pr.title}`}
        onClick={() => platform.visit(pr.id, pr.url)}
        className={cn(
          "block w-full cursor-pointer truncate border-0 bg-transparent px-3 text-left text-xs leading-[28px] font-medium hover:underline",
          ROW,
        )}
      >
        {pr.approved && <Approved label="Approved" />}
        <span className="font-normal text-muted-foreground tabular-nums">#{pr.number}</span> {pr.title}
      </button>
      {pr.teams.map((team) => (
        <div
          key={team.team}
          title={`${team.team} · ${describeTeam(team, now)}`}
          className={cn("truncate pr-3 pl-6 text-[11px] leading-[28px] text-muted-foreground", ROW)}
        >
          {team.approvedAt ? <Approved label="Approved" /> : <NotApproved />}
          {teamName(team.team)}
        </div>
      ))}
    </div>
  );
}

function Legend({ children }: { children: ReactNode }) {
  const swatch = "inline-block h-2 w-4 rounded-[2px]";
  return (
    <p className="m-0 flex min-h-[33px] flex-wrap items-center gap-x-3 border-b px-3 py-1 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1">
        <span className={cn(swatch, "bg-info")} /> Open
      </span>
      <span className="flex items-center gap-1">
        <span className={cn(swatch, "bg-success")} /> Approved
      </span>
      <span className="flex items-center gap-1">
        <span className={cn(swatch, DRAFT)} /> Draft
      </span>
      <span className="flex items-center gap-1">
        <span className={cn(swatch, WAITING)} /> Waiting on team
      </span>
      <span className="flex items-center gap-1">
        <span className={cn(swatch, TEAM_APPROVED)} /> Team approved
      </span>
      <span className="flex items-center gap-1">
        <span className={cn(swatch, RESPONDED)} /> Team responded
      </span>
      {children}
    </p>
  );
}

/** Short enough for an axis label: a date, or a time when zoomed in that far. */
function tickLabel(ms: number, hourly: boolean): string {
  return hourly
    ? new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : shortDate(ms);
}

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
  const [highlight, setHighlight] = useState<{ left: number; width: number } | null>(null);
  // Starts at now, the end people look at. The window widening keeps it there.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [range]);

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
            <div className="flex-1 pr-2" style={eachTrack}>
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
    </div>
  );
}

/** Open PRs as bars, each with the teams that own what it changes underneath. */
export function Timeline({
  pullRequests,
  emptyText,
  now,
}: {
  pullRequests: (PullRequest | ReviewRequest)[];
  emptyText: string;
  now: number;
}) {
  const [range, setRange] = useState<TimelineRange | null>(null);
  const chart = useMemo(
    () => buildTimeline(pullRequests, now, range),
    [pullRequests, now, range],
  );
  // These are on screen, so a refresh should fetch them first, as with an open section.
  useReportOpen(
    "timeline",
    true,
    chart.prs.map((pr) => pr.id),
  );
  if (chart.prs.length === 0) {
    return <p className="m-0 px-3 py-6 text-center text-muted-foreground">{emptyText}</p>;
  }
  return (
    <div className="flex h-full flex-col">
      <Legend>
        {range ? (
          <span className="ml-auto flex items-center gap-1.5 tabular-nums">
            {chart.hourly
              ? `${shortDate(range.from)} ${tickLabel(range.from, true)} – ${tickLabel(range.to, true)}`
              : `${shortDate(range.from)} – ${shortDate(range.to)}`}
            <Button type="button" variant="outline" size="xs" onClick={() => setRange(null)}>
              <ZoomOut />
              Reset zoom
            </Button>
          </span>
        ) : (
          <span className="ml-auto">Drag across the bars to zoom</span>
        )}
      </Legend>
      <Scroller chart={chart} now={now} range={range} onZoom={setRange} />
    </div>
  );
}
