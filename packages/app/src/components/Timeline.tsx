import { useLayoutEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { elapsed } from "../format";
import { useReportOpen } from "../hooks";
import { usePlatform } from "../platform";
import { buildTimeline, type Timeline as Chart, type TimelinePr, type TimelineTeam } from "../timeline";
import type { PullRequest, ReviewRequest } from "../types";

/** Width of the column of titles and team names. */
const NAME_COLUMN = 280;
const ROW = "h-[22px]";

const WAITING = "bg-info/40";
const RESPONDED = "bg-muted-foreground/40";
const DRAFT = "border border-dashed border-muted-foreground bg-muted";

function percent(fraction: number): string {
  return `${fraction * 100}%`;
}

function teamName(team: string): string {
  return `@${team.split("/").pop()}`;
}

function describeTeam(team: TimelineTeam, now: number): string {
  const name = teamName(team.team);
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
      <button
        type="button"
        aria-label={`Open #${pr.number} ${pr.title}`}
        title={`${pr.repo}#${pr.number} ${pr.title} · ${pr.draft ? "draft" : "open"} ${elapsed(pr.openSince, now)}`}
        onClick={() => platform.visit(pr.id, pr.url)}
        // Measured from the right, so the least width grows away from the edge.
        style={{ right: 0, width: percent(1 - pr.start) }}
        className={cn(
          "absolute inset-y-[3px] min-w-1.5 cursor-pointer rounded-[3px] border-0 p-0 hover:brightness-110",
          pr.draft ? DRAFT : "bg-info",
        )}
      />
    </div>
  );
}

function TeamBar({ team, now }: { team: TimelineTeam; now: number }) {
  return (
    <div className={cn("relative", ROW)}>
      <span
        title={describeTeam(team, now)}
        style={{ right: percent(1 - team.end), width: percent(team.end - team.start) }}
        className={cn(
          "absolute inset-y-[6px] min-w-1 rounded-[2px]",
          team.pending ? WAITING : RESPONDED,
        )}
      />
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
      <span aria-hidden="true" className="absolute inset-y-0 right-0 w-px bg-info" />
    </>
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
          "block w-full cursor-pointer truncate border-0 bg-transparent px-3 text-left text-xs leading-[22px] font-medium hover:underline",
          ROW,
        )}
      >
        <span className="font-normal text-muted-foreground tabular-nums">#{pr.number}</span> {pr.title}
      </button>
      {pr.teams.map((team) => (
        <div
          key={team.team}
          title={`${team.team} · ${describeTeam(team, now)}`}
          className={cn("truncate pr-3 pl-6 text-[11px] leading-[22px] text-muted-foreground", ROW)}
        >
          {teamName(team.team)}
        </div>
      ))}
    </div>
  );
}

function Legend() {
  const swatch = "inline-block h-2 w-4 rounded-[2px]";
  return (
    <p className="m-0 flex gap-3 border-b px-3 py-1 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1">
        <span className={cn(swatch, "bg-info")} /> Open
      </span>
      <span className="flex items-center gap-1">
        <span className={cn(swatch, DRAFT)} /> Draft
      </span>
      <span className="flex items-center gap-1">
        <span className={cn(swatch, WAITING)} /> Waiting on team
      </span>
      <span className="flex items-center gap-1">
        <span className={cn(swatch, RESPONDED)} /> Team responded
      </span>
    </p>
  );
}

function Scroller({ chart, now }: { chart: Chart; now: number }) {
  const scroller = useRef<HTMLDivElement>(null);
  // Starts at now, the end people look at. The window widening keeps it there.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);
  const day = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const track = { minWidth: chart.trackPx };
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
      <div className="flex w-fit min-w-full flex-col">
        <div className="sticky top-0 z-20 flex h-7 border-b bg-background text-[10px] text-muted-foreground tabular-nums">
          <div
            className="sticky left-0 z-10 flex shrink-0 items-center border-r bg-background px-3 text-[11px] font-semibold tracking-wide uppercase"
            style={{ width: NAME_COLUMN }}
          >
            Pull request
          </div>
          <div className="flex-1 pr-2" style={track}>
            <div className="relative h-full">
            {chart.ticks.map(({ at, position }) => (
              <span
                key={at}
                className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap"
                style={{ left: percent(position) }}
              >
                {day(at)}
              </span>
            ))}
            <span className="absolute top-1/2 right-0 -translate-y-1/2 font-semibold text-info">
              now
            </span>
            </div>
          </div>
        </div>
        {chart.prs.map((pr) => (
          <section key={pr.id} className="flex border-b">
            <Names pr={pr} now={now} />
            <div className="flex-1 pr-2" style={track}>
              <div className="relative">
              <Lines chart={chart} />
              <PrBar pr={pr} now={now} />
              {pr.teams.map((team) => (
                <TeamBar key={team.team} team={team} now={now} />
              ))}
              </div>
            </div>
          </section>
        ))}
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
  const chart = useMemo(() => buildTimeline(pullRequests, now), [pullRequests, now]);
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
      <Legend />
      <Scroller chart={chart} now={now} />
    </div>
  );
}
