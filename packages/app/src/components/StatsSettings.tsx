import { useEffect, useState } from "react";
import { Bar, BarChart, Cell, LabelList, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePlatform } from "../platform";
import {
  STATS_DAYS,
  averageCodeOwners,
  averageReviewWait,
  change,
  duration,
  median,
  perMember,
  type Average,
  type Change,
} from "../stats";
import type { CiStats, PullRequest, ReviewStatsData, StatsData } from "../types";

const TEAM_KEY = "reviewPinger.statsTeam";
/** Teams up to this size are counted member by member, which the median needs. */
const MEMBER_COUNT_CAP = 150;
const NO_TEAM = "none";

/**
 * Statistics are fetched only when Settings is opened, never on the polling
 * cycle, and a result is reused for a few minutes so going back and forth
 * doesn't ask GitHub again.
 */
const CACHE_MS = 10 * 60_000;
type Cache<T> = Map<string, { at: number; value: T }>;
const statsCache: Cache<StatsData> = new Map();
const reviewsCache: Cache<ReviewStatsData> = new Map();
/** The window before, loaded after the current one shows, only to compare with. */
const previousStatsCache: Cache<StatsData> = new Map();
const previousReviewsCache: Cache<ReviewStatsData> = new Map();
/** CI builds through the Buildkite CLI: the same for any team. */
const ciCache: Cache<CiStats> = new Map();
const previousCiCache: Cache<CiStats> = new Map();
let teamsCache: { at: number; teams: string[] } | null = null;
/** A request already under way is shared, so opening Settings twice in a row asks once. */
const statsInFlight = new Map<string, Promise<StatsData>>();
const reviewsInFlight = new Map<string, Promise<ReviewStatsData>>();
const previousStatsInFlight = new Map<string, Promise<StatsData>>();
const previousReviewsInFlight = new Map<string, Promise<ReviewStatsData>>();
const ciInFlight = new Map<string, Promise<CiStats>>();
const previousCiInFlight = new Map<string, Promise<CiStats>>();
let teamsInFlight: Promise<string[]> | null = null;

function shared<T>(
  inFlight: Promise<T> | undefined,
  start: () => Promise<T>,
  done: () => void,
) {
  if (inFlight) return inFlight;
  const request = start();
  request.then(done, done);
  return request;
}

function savedTeam(): string | null {
  try {
    return localStorage.getItem(TEAM_KEY);
  } catch {
    return null;
  }
}

function saveTeam(team: string | null) {
  try {
    if (team) localStorage.setItem(TEAM_KEY, team);
    else localStorage.removeItem(TEAM_KEY);
  } catch {
    // A per-device convenience; losing it just means choosing again.
  }
}

type Loaded<T> =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; value: T };

/** The per-member bars: the team's neutral, lighter, since they're derived from the team's bar. */
const PER_MEMBER_FILL =
  "color-mix(in oklab, var(--muted-foreground) 60%, transparent)";

/** Your bars in the accent colour, the team's in neutral: one measure, two entities. */
interface Bar {
  who: string;
  value: number;
  fill: string;
  /** How it moved since the 30 days before, once that's loaded. */
  change?: Change | null;
}

/**
 * The bars both charts share: you (all repos), you and the team in the
 * team's org so those compare, and the per-member average and median. A
 * `null` leaves that bar out.
 */
function teamBars(
  team: string | null,
  counts: {
    you: number;
    youInTeamOrg: number | null;
    teamTotal: number | null;
    /** Members the average is over. */
    members: number;
    /** What each member did, when counted member by member. */
    perMember: number[] | null;
  },
  /**
   * The same counts for the 30 days before, to show what changed. Left out
   * (`null`, or a field `null`) there's no change on that bar; the median never
   * has one, since that needs each member's earlier count.
   */
  before: {
    you: number;
    youInTeamOrg: number | null;
    teamTotal: number | null;
  } | null = null,
): Bar[] {
  const average = team ? perMember(counts.teamTotal, counts.members) : null;
  const averageBefore =
    team && before ? perMember(before.teamTotal, counts.members) : null;
  const middle = team && counts.perMember ? median(counts.perMember) : null;
  // One decimal, so the label, tooltip and table all say the same.
  const tenth = (n: number) => Math.round(n * 10) / 10;
  const moved = (now: number, was: number | null | undefined) =>
    was === null || was === undefined ? null : change(now, was);
  return [
    {
      who: "You (all repos)",
      value: counts.you,
      fill: "var(--info)",
      change: moved(counts.you, before?.you),
    },
    ...(team && counts.youInTeamOrg !== null
      ? [
          {
            who: "You (within team)",
            value: counts.youInTeamOrg,
            fill: "var(--info)",
            change: moved(counts.youInTeamOrg, before?.youInTeamOrg),
          },
        ]
      : []),
    ...(team && counts.teamTotal !== null
      ? [
          {
            who: team.split("/")[1] ?? team,
            value: counts.teamTotal,
            fill: "var(--muted-foreground)",
            change: moved(counts.teamTotal, before?.teamTotal),
          },
        ]
      : []),
    ...(average !== null
      ? [
          {
            who: "Avg per member",
            value: tenth(average),
            fill: PER_MEMBER_FILL,
            change:
              averageBefore === null
                ? null
                : change(tenth(average), tenth(averageBefore)),
          },
        ]
      : []),
    ...(middle !== null
      ? [
          {
            who: "Median per member",
            value: tenth(middle),
            fill: PER_MEMBER_FILL,
            change: null,
          },
        ]
      : []),
  ];
}

/**
 * Loads once per key, reusing a recent result and sharing a request already
 * under way. Called with a new key (a different team) it loads again.
 */
function useLoaded<T>(
  key: string,
  cache: Cache<T>,
  inFlight: Map<string, Promise<T>>,
  load: () => Promise<T>,
  /** Waits (still "loading") until true, so one load can follow another. */
  enabled = true,
): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ kind: "loading" });
  useEffect(() => {
    if (!enabled) return;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      setState({ kind: "ready", value: cached.value });
      return;
    }
    let stale = false;
    setState({ kind: "loading" });
    const request = shared(inFlight.get(key), load, () => inFlight.delete(key));
    inFlight.set(key, request);
    request
      .then((value) => {
        cache.set(key, { at: Date.now(), value });
        if (!stale) setState({ kind: "ready", value });
      })
      .catch((e) => {
        if (!stale) setState({ kind: "error", message: String(e) });
      });
    return () => {
      stale = true;
    };
    // `load` only depends on the key, so it isn't a reason to load again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return state;
}

/** One horizontal bar chart with its numbers as a hidden table for screen readers. */
function BarsChart({
  bars,
  unit,
  title,
}: {
  bars: Bar[];
  unit: string;
  title: string;
}) {
  const config = { value: { label: unit } } satisfies ChartConfig;
  return (
    <>
      <ChartContainer
        config={config}
        className="aspect-auto w-full"
        style={{ height: 36 + bars.length * 32 }}
      >
        <BarChart
          data={bars}
          layout="vertical"
          // Room beside the longest bar for its value and, once loaded, its change.
          margin={{
            top: 0,
            right: bars.some((bar) => bar.change) ? 110 : 32,
            bottom: 0,
            left: 0,
          }}
          barSize={20}
        >
          <XAxis type="number" hide domain={[0, "dataMax"]} />
          <YAxis
            type="category"
            dataKey="who"
            tickLine={false}
            axisLine={false}
            width={140}
            tick={{ fontSize: 11 }}
            interval={0}
          />
          <ChartTooltip
            cursor={false}
            content={<ChartTooltipContent hideLabel />}
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]}>
            {bars.map((bar) => (
              <Cell key={bar.who} fill={bar.fill} />
            ))}
            <LabelList
              dataKey="value"
              position="right"
              content={(props) => <ValueLabel {...props} bars={bars} />}
            />
          </Bar>
        </BarChart>
      </ChartContainer>
      {/* The same numbers as text, for anyone who can't read the chart. */}
      <table className="sr-only">
        <caption>{title}</caption>
        <tbody>
          {bars.map((bar) => (
            <tr key={bar.who}>
              <th scope="row">{bar.who}</th>
              <td>
                {bar.value}
                {bar.change && `, ${bar.change.text}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** A bar's value at its end, with how it moved since the 30 days before in muted text. */
function ValueLabel({
  x,
  y,
  width,
  height,
  index,
  bars,
}: {
  x?: number | string;
  y?: number | string;
  width?: number | string;
  height?: number | string;
  index?: number;
  bars: Bar[];
}) {
  const bar = bars[index ?? 0];
  if (!bar) return null;
  return (
    <text
      x={Number(x) + Number(width) + 6}
      y={Number(y) + Number(height) / 2}
      dominantBaseline="central"
      fontSize={11}
    >
      <tspan className="fill-foreground">{bar.value}</tspan>
      {bar.change && (
        <tspan dx={6} className="fill-muted-foreground" fontSize={10}>
          {bar.change.text}
        </tspan>
      )}
    </text>
  );
}

export function StatsSettings({
  pullRequests,
  viewer,
}: {
  /** Your open PRs, already loaded: the open-PR numbers come from these. */
  pullRequests: PullRequest[];
  viewer: string | null;
}) {
  const platform = usePlatform();
  const [team, setTeam] = useState<string | null>(savedTeam);
  const [teams, setTeams] = useState<Loaded<string[]>>(
    teamsCache && Date.now() - teamsCache.at < CACHE_MS
      ? { kind: "ready", value: teamsCache.teams }
      : { kind: "loading" },
  );
  const key = team ?? NO_TEAM;
  const stats = useLoaded(key, statsCache, statsInFlight, () =>
    platform.loadStats(team, STATS_DAYS),
  );
  const reviews = useLoaded(key, reviewsCache, reviewsInFlight, () =>
    platform.loadReviewStats(team, STATS_DAYS),
  );
  // The 30 days before, only to show what changed, loaded once these are showing.
  const previousStats = useLoaded(
    key,
    previousStatsCache,
    previousStatsInFlight,
    () => platform.loadStats(team, STATS_DAYS, true),
    stats.kind === "ready",
  );
  const previousReviews = useLoaded(
    key,
    previousReviewsCache,
    previousReviewsInFlight,
    () => platform.loadReviewStats(team, STATS_DAYS, true),
    reviews.kind === "ready",
  );
  // CI builds come from the Buildkite CLI, so only where the app can run it.
  const hasCi = platform.features.buildkite;
  const ci = useLoaded(
    "ci",
    ciCache,
    ciInFlight,
    () => platform.loadCiStats(STATS_DAYS),
    hasCi,
  );
  const ciNow = ci.kind === "ready" ? ci.value : null;
  const previousCi = useLoaded(
    "ci",
    previousCiCache,
    previousCiInFlight,
    () => platform.loadCiStats(STATS_DAYS, true),
    hasCi && ciNow?.kind === "ok",
  );
  const ciBefore =
    previousCi.kind === "ready" && previousCi.value.kind === "ok"
      ? previousCi.value
      : null;

  // The teams you could pick from, once per visit to Settings.
  useEffect(() => {
    if (teamsCache && Date.now() - teamsCache.at < CACHE_MS) return;
    let stale = false;
    teamsInFlight = shared(
      teamsInFlight ?? undefined,
      () => platform.listTeams(),
      () => {
        teamsInFlight = null;
      },
    );
    teamsInFlight
      .then((list) => {
        teamsCache = { at: Date.now(), teams: list };
        if (!stale) setTeams({ kind: "ready", value: list });
      })
      .catch((e) => {
        if (!stale) setTeams({ kind: "error", message: String(e) });
      });
    return () => {
      stale = true;
    };
  }, [platform]);

  function choose(value: string) {
    const next = value === NO_TEAM ? null : value;
    setTeam(next);
    saveTeam(next);
  }

  const data = stats.kind === "ready" ? stats.value : null;
  // Failing to load the earlier window just means no changes are shown.
  const before = previousStats.kind === "ready" ? previousStats.value : null;
  const mergedBars = data
    ? teamBars(
        team,
        {
          you: data.mergedByMe,
          youInTeamOrg: data.mergedByMeInTeamOrg,
          teamTotal: data.mergedByTeam,
          members: data.teamMemberCount,
          perMember: data.teamMemberMerged,
        },
        before && {
          you: before.mergedByMe,
          youInTeamOrg: before.mergedByMeInTeamOrg,
          teamTotal: before.mergedByTeam,
        },
      )
    : [];
  const reviewData = reviews.kind === "ready" ? reviews.value : null;
  const reviewCounts = reviewData?.teamMemberReviews ?? null;
  const reviewsBefore =
    previousReviews.kind === "ready" ? previousReviews.value : null;
  const reviewBars = reviewData
    ? teamBars(
        team,
        {
          you: reviewData.reviewsByMe,
          youInTeamOrg: reviewData.reviewsByMeInTeamOrg,
          teamTotal: reviewCounts
            ? reviewCounts.reduce((sum, n) => sum + n, 0)
            : null,
          members: reviewCounts?.length ?? 0,
          perMember: reviewCounts,
        },
        // The team's earlier reviews would need every member looked up again,
        // so only your own bars have a change.
        reviewsBefore && {
          you: reviewsBefore.reviewsByMe,
          youInTeamOrg: reviewsBefore.reviewsByMeInTeamOrg,
          teamTotal: null,
        },
      )
    : [];
  const teamList = teams.kind === "ready" ? teams.value : [];
  // A saved team you've since left is still shown, so the choice isn't silently lost.
  const options =
    team && !teamList.includes(team) ? [team, ...teamList] : teamList;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs text-muted-foreground">
          Compare with team
        </span>
        <Select
          value={team ?? NO_TEAM}
          onValueChange={choose}
          disabled={teams.kind === "loading"}
        >
          <SelectTrigger
            size="sm"
            className="h-7 min-w-0 flex-1 text-xs"
            aria-label="Team to compare with"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_TEAM} className="text-xs">
              No team
            </SelectItem>
            {options.map((option) => (
              <SelectItem key={option} value={option} className="text-xs">
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {teams.kind === "error" && (
        <p className="m-0 -mt-2 text-xs text-muted-foreground">
          {teams.message}
        </p>
      )}

      <section aria-label={`PRs merged in the last ${STATS_DAYS} days`}>
        <h4 className="m-0 mb-1 text-xs font-medium">
          PRs merged, last {STATS_DAYS} days
        </h4>
        {stats.kind === "loading" && <Placeholder>Loading…</Placeholder>}
        {stats.kind === "error" && (
          <Placeholder error>{stats.message}</Placeholder>
        )}
        {data && (
          <>
            <BarsChart
              bars={mergedBars}
              unit="PRs merged"
              title={`PRs merged in the last ${STATS_DAYS} days`}
            />
            {!team && (
              <Note>Choose a team to compare with its members' merges.</Note>
            )}
            {team && (
              <Note>
                "You (within team)" and the team's bars count merges in{" "}
                {team.split("/")[0]} only.
                {data.teamMemberMerged !== null &&
                  " The average and median include members who merged nothing."}
                {data.teamMemberMerged === null &&
                  data.teamMemberCount > MEMBER_COUNT_CAP &&
                  ` The median is shown for teams of up to ${MEMBER_COUNT_CAP} members.`}
                {before &&
                  ` Changes compare with the ${STATS_DAYS} days before; the median has none.`}
              </Note>
            )}
            {team && data.teamMembersCapped && (
              <Note>
                This team has more than 500 members. Only the first 500 are
                counted, so the number is short.
              </Note>
            )}
          </>
        )}
      </section>

      <section aria-label={`Reviews done in the last ${STATS_DAYS} days`}>
        <h4 className="m-0 mb-1 text-xs font-medium">
          Reviews done, last {STATS_DAYS} days
        </h4>
        {reviews.kind === "loading" && <Placeholder>Loading…</Placeholder>}
        {reviews.kind === "error" && (
          <Placeholder error>{reviews.message}</Placeholder>
        )}
        {reviewData && (
          <>
            <BarsChart
              bars={reviewBars}
              unit="Reviews"
              title={`Reviews done in the last ${STATS_DAYS} days`}
            />
            {!team && (
              <Note>Choose a team to compare with its members' reviews.</Note>
            )}
            {team && (
              <Note>
                Reviews GitHub counts for each person in {team.split("/")[0]},
                from repos your token can see.
                {reviewCounts !== null &&
                  " The average and median include members who reviewed nothing."}
                {reviewCounts === null &&
                  reviewData.teamMemberCount > MEMBER_COUNT_CAP &&
                  ` Team bars are shown for teams of up to ${MEMBER_COUNT_CAP} members.`}
                {reviewsBefore &&
                  ` Changes compare with the ${STATS_DAYS} days before, for your bars only.`}
              </Note>
            )}
          </>
        )}
      </section>

      <div className="grid grid-cols-2 gap-2">
        <Figure
          label="Review wait, merged"
          value={data ? averageReviewWait(data.sample, viewer) : null}
          previous={before ? averageReviewWait(before.sample, viewer) : null}
          format={duration}
          basis="merged PR"
          loading={stats.kind === "loading"}
        />
        <Figure
          label="Code owners per PR"
          value={averageCodeOwners(pullRequests)}
          format={(n) => (Math.round(n * 10) / 10).toString()}
          basis="open PR"
        />
        {hasCi && (
          <>
            <Tile
              label="CI builds"
              value={ciValue(ciNow, ci.kind === "loading", (c) => String(c.builds))}
              detail={ciNow?.kind === "ok" ? `created by you` : " "}
              moved={
                ciNow?.kind === "ok" && ciBefore
                  ? change(ciNow.builds, ciBefore.builds)
                  : null
              }
            />
            <Tile
              label="Avg build duration"
              value={ciValue(ciNow, ci.kind === "loading", (c) =>
                c.avgDurationSecs === null ? "–" : duration(c.avgDurationSecs * 1000),
              )}
              detail={
                ciNow?.kind === "ok"
                  ? `${ciNow.durationSample} finished build${ciNow.durationSample === 1 ? "" : "s"}`
                  : " "
              }
              moved={
                ciNow?.kind === "ok" &&
                ciBefore &&
                ciNow.avgDurationSecs !== null &&
                ciBefore.avgDurationSecs !== null
                  ? change(
                      ciNow.avgDurationSecs * 1000,
                      ciBefore.avgDurationSecs * 1000,
                      duration,
                      60_000,
                    )
                  : null
              }
            />
          </>
        )}
      </div>
      {hasCi && ciNow && ciNow.kind !== "ok" && <CiHelp stats={ciNow} />}
      <p className="m-0 -mt-2 text-[11px] leading-snug text-muted-foreground">
        Review wait is the time from a merged PR's first review request to its
        first review by someone else, over your latest 100 merged PRs. Code
        owners are the pending requests GitHub made from CODEOWNERS, on open PRs
        that aren't drafts.
        {hasCi &&
          ciNow?.kind === "ok" &&
          ` CI builds are those Buildkite lists as created by you, in the last ${STATS_DAYS} days; the duration is start to finish of the ones that finished.`}
      </p>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="m-0 mt-1 text-xs text-muted-foreground">{children}</p>;
}

function Placeholder({
  children,
  error,
}: {
  children: string;
  error?: boolean;
}) {
  return (
    <p
      className={`m-0 py-3 text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}
    >
      {children}
    </p>
  );
}

/** A tile: a label, one number, a line under it, and optionally how it moved. */
function Tile({
  label,
  value,
  detail,
  moved,
}: {
  label: string;
  value: string;
  detail: string;
  moved: Change | null;
}) {
  return (
    <Card className="gap-1 rounded-lg py-2 shadow-none">
      <CardContent className="flex flex-col gap-0.5 px-2.5">
        <span className="text-[11px] leading-tight text-muted-foreground">{label}</span>
        <span className="text-lg leading-tight font-semibold">{value}</span>
        <span className="text-[11px] leading-tight text-muted-foreground">{detail}</span>
        {moved && (
          <span className="text-[11px] leading-tight text-muted-foreground">{moved.text}</span>
        )}
      </CardContent>
    </Card>
  );
}

/** A CI tile's number: "…" while loading, "–" when there's no answer to show. */
function ciValue(
  stats: CiStats | null,
  loading: boolean,
  of: (ok: Extract<CiStats, { kind: "ok" }>) => string,
): string {
  if (loading || !stats) return "…";
  return stats.kind === "ok" ? of(stats) : "–";
}

/** Why the CI tiles are empty, and what to do about it. */
function CiHelp({ stats }: { stats: Exclude<CiStats, { kind: "ok" }> }) {
  const platform = usePlatform();
  const code = "rounded bg-muted px-1 py-0.5 font-mono text-[11px]";
  if (stats.kind === "error") {
    return <p className="m-0 -mt-2 text-xs text-destructive">{stats.message}</p>;
  }
  return (
    <p className="m-0 -mt-2 text-xs leading-snug text-muted-foreground">
      {stats.kind === "notInstalled" ? (
        <>
          CI build stats come from the Buildkite CLI, which isn't installed. Install it
          with <code className={code}>brew install buildkite/buildkite/bk@3</code>, then
          log in with <code className={code}>bk auth login</code>.{" "}
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto p-0"
            onClick={() => platform.openUrl("https://buildkite.com/docs/platform/cli")}
          >
            Installation guide
          </Button>
        </>
      ) : (
        <>
          The Buildkite CLI isn't logged in. Run <code className={code}>bk auth login</code>{" "}
          in a terminal, then reopen Settings.
        </>
      )}
    </p>
  );
}

function Figure({
  label,
  value,
  previous,
  format,
  basis,
  loading,
}: {
  label: string;
  value: Average | null;
  /** The same over the 30 days before, to show what changed. */
  previous?: Average | null;
  format: (n: number) => string;
  basis: string;
  loading?: boolean;
}) {
  // Under a minute isn't a change worth showing for a duration.
  const moved =
    value?.average != null && previous?.average != null
      ? change(
          value.average,
          previous.average,
          format,
          format === duration ? 60_000 : 0.05,
        )
      : null;
  return (
    <Tile
      label={label}
      value={
        loading || !value ? "…" : value.average === null ? "–" : format(value.average)
      }
      detail={
        loading || !value ? " " : `${value.count} ${basis}${value.count === 1 ? "" : "s"}`
      }
      moved={moved}
    />
  );
}
