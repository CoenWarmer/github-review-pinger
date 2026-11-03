import { useLayoutEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { elapsed } from "../format";
import { usePlatform } from "../platform";
import { buildTimeline, type Timeline as Chart, type TimelineBar } from "../timeline";
import type { PullRequest } from "../types";

/** Width of the team column, which the bars' labels stay clear of when scrolled. */
const TEAM_COLUMN = 150;
/** A bar with less room than this has its label beside it rather than in it. */
const LABEL_INSIDE_PX = 140;

function percent(fraction: number): string {
  return `${fraction * 100}%`;
}

function Bar({ bar, chart, now }: { bar: TimelineBar; chart: Chart; now: number }) {
  const platform = usePlatform();
  const length = chart.nowPosition - bar.start;
  const inside = length * chart.trackPx >= LABEL_INSIDE_PX;
  const label = `#${bar.number} ${bar.title}`;
  return (
    <li className="relative h-[22px]">
      <button
        type="button"
        title={`${bar.repo}#${bar.number} ${bar.title} · ${bar.draft ? "draft" : "open"} ${elapsed(bar.openSince, now)}`}
        onClick={() => platform.visit(bar.id, bar.url)}
        style={{
          left: percent(bar.start),
          right: percent(1 - chart.nowPosition),
          // `clip`, as `hidden` would stop the label sticking while scrolled.
          overflow: inside ? "clip" : "visible",
        }}
        className={cn(
          "absolute inset-y-[2px] flex min-w-1.5 cursor-pointer items-center rounded-[3px] border-0 p-0 text-left text-[11px] hover:brightness-110",
          bar.draft
            ? "border border-dashed border-muted-foreground bg-muted text-muted-foreground"
            : "bg-info text-background",
        )}
      >
        {inside ? (
          <span
            className="sticky max-w-[420px] truncate px-1.5"
            style={{ left: TEAM_COLUMN }}
          >
            {label}
          </span>
        ) : (
          <span className="absolute right-full mr-1 max-w-[320px] truncate text-muted-foreground">
            {label}
          </span>
        )}
      </button>
    </li>
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
      <span
        aria-hidden="true"
        className="absolute inset-y-0 w-px bg-info"
        style={{ left: percent(chart.nowPosition) }}
      />
    </>
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
  const column = { width: TEAM_COLUMN };
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
      <div className="flex w-fit min-w-full flex-col">
        <div className="sticky top-0 z-20 flex h-7 border-b bg-background text-[10px] text-muted-foreground tabular-nums">
          <div
            className="sticky left-0 z-10 flex shrink-0 items-center border-r bg-background px-3 text-[11px] font-semibold tracking-wide uppercase"
            style={column}
          >
            Team
          </div>
          <div className="relative flex-1" style={track}>
            {chart.ticks.map(({ at, position }) => (
              <span
                key={at}
                className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap"
                style={{ left: percent(position) }}
              >
                {day(at)}
              </span>
            ))}
            <span
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 font-semibold text-info"
              style={{ left: percent(chart.nowPosition) }}
            >
              now
            </span>
          </div>
        </div>
        {chart.rows.map(({ team, bars }) => (
          <section key={team ?? "none"} className="flex border-b">
            <div className="sticky left-0 z-10 shrink-0 border-r bg-background" style={column}>
              {/* Stays beside the bars while a long team scrolls past. */}
              <h2
                title={team ?? undefined}
                className="sticky top-7 m-0 flex items-baseline gap-1 px-3 py-1 text-xs font-medium"
              >
                <span className="truncate">
                  {team === null ? "No team requested" : `@${team.split("/").pop()}`}
                </span>
                <span className="font-normal text-muted-foreground tabular-nums">{bars.length}</span>
              </h2>
            </div>
            <div className="relative flex-1" style={track}>
              <Lines chart={chart} />
              <ul className="relative m-0 list-none p-0">
                {bars.map((bar) => (
                  <Bar key={bar.id} bar={bar} chart={chart} now={now} />
                ))}
              </ul>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/** Your open PRs as bars, under each team requested on them. */
export function Timeline({ pullRequests, now }: { pullRequests: PullRequest[]; now: number }) {
  const chart = useMemo(
    () => buildTimeline(pullRequests, now),
    [pullRequests, now],
  );
  if (chart.rows.length === 0) {
    return (
      <p className="m-0 px-3 py-6 text-center text-muted-foreground">No open pull requests.</p>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <Scroller chart={chart} now={now} />
    </div>
  );
}
