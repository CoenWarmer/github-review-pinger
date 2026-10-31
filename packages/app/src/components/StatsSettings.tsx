import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Bar, BarChart, Cell, LabelList, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
import {
  ChartContainer,
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
import { RingsLoader } from "./RingsLoader";
import {
  STATS_DAYS,
  averageApproval,
  averageCodeOwners,
  averageReadyToMerged,
  averageReviewWait,
  change,
  duration,
  median,
  perMember,
  type Average,
  type Change,
  type Tone,
} from "../stats";
import type {
  CiStats,
  PullRequest,
  ReviewStatsData,
  StatsData,
} from "../types";
import { Credits } from "./Credits";

const TEAM_KEY = "reviewPinger.statsTeam";
const REPOS_KEY = "reviewPinger.statsRepos";
/** Each chosen repo is a search qualifier, and GitHub caps a search's length. */
const MAX_REPOS = 5;
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
/** The repos the statistics can be narrowed to: the same for any team. */
const reposCache: Cache<string[]> = new Map();
const reposInFlight = new Map<string, Promise<string[]>>();
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

function savedRepos(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(REPOS_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((repo): repo is string => typeof repo === "string")
      : [];
  } catch {
    return [];
  }
}

function saveRepos(repos: string[]) {
  try {
    if (repos.length > 0) localStorage.setItem(REPOS_KEY, JSON.stringify(repos));
    else localStorage.removeItem(REPOS_KEY);
  } catch {
    // A per-device convenience; losing it just means choosing again.
  }
}

type Loaded<T> =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; value: T };

/**
 * How a change is coloured: green for better, red for worse, muted for neither.
 * The arrow and the numbers carry the meaning without the colour.
 */
const SVG_TONE: Record<Tone, string> = {
  good: "fill-success",
  bad: "fill-destructive",
  neutral: "fill-muted-foreground",
};
const TEXT_TONE: Record<Tone, string> = {
  good: "text-success",
  bad: "text-destructive",
  neutral: "text-muted-foreground",
};
/** What a screen reader is told, since it can't see the colour. */
const TONE_WORDS: Record<Tone, string> = {
  good: ", better",
  bad: ", worse",
  neutral: "",
};

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
  /** Your bar's name, which says so when repos are chosen. */
  youLabel = "You (all repos)",
): Bar[] {
  const average = team ? perMember(counts.teamTotal, counts.members) : null;
  const averageBefore =
    team && before ? perMember(before.teamTotal, counts.members) : null;
  const middle = team && counts.perMember ? median(counts.perMember) : null;
  // One decimal, so the label, tooltip and table all say the same.
  const tenth = (n: number) => Math.round(n * 10) / 10;
  // More merged PRs, and more reviews, are better.
  const moved = (now: number, was: number | null | undefined) =>
    was === null || was === undefined
      ? null
      : change(now, was, { better: "up" });
  return [
    {
      who: youLabel,
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
                : change(tenth(average), tenth(averageBefore), {
                    better: "up",
                  }),
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
  // Starts from a recent result, so reopening doesn't flash "Loading…" first.
  const [state, setState] = useState<Loaded<T>>(() => {
    const cached = cache.get(key);
    return enabled && cached && Date.now() - cached.at < CACHE_MS
      ? { kind: "ready", value: cached.value }
      : { kind: "loading" };
  });
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

/**
 * One horizontal bar chart with its numbers as a hidden table for screen
 * readers. Memoized, and `bars` has to stay the same array until its numbers
 * change: a new one each render makes the chart library rebuild the value
 * labels, which flickers them.
 */
const BarsChart = memo(function BarsChart({
  bars,
  unit,
  title,
  reserveChangeSpace,
}: {
  bars: Bar[];
  unit: string;
  title: string;
  /** Leave room beside the bars for each one's change, which loads after them. */
  reserveChangeSpace: boolean;
}) {
  const config = useMemo(
    () => ({ value: { label: unit } }) satisfies ChartConfig,
    [unit],
  );
  // Room beside the longest bar for its value and, once loaded, its change.
  // Held while the change is still loading, so it doesn't shift the bars when it arrives.
  const margin = useMemo(
    () => ({
      top: 0,
      right: reserveChangeSpace ? 110 : 32,
      bottom: 0,
      left: 0,
    }),
    [reserveChangeSpace],
  );
  const label = useCallback(
    (props: Omit<Parameters<typeof ValueLabel>[0], "bars">) => (
      <ValueLabel {...props} bars={bars} />
    ),
    [bars],
  );
  return (
    <>
      <ChartContainer
        config={config}
        className="aspect-auto w-full"
        style={{ height: 36 + bars.length * 32 }}
      >
        <BarChart data={bars} layout="vertical" margin={margin} barSize={20}>
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
          <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {bars.map((bar) => (
              <Cell key={bar.who} fill={bar.fill} />
            ))}
            <LabelList dataKey="value" position="right" content={label} />
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
                {bar.change &&
                  `, ${bar.change.text}${TONE_WORDS[bar.change.tone]}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
});

/**
 * A bar's value at its end. How it moved since the 30 days before shows,
 * coloured, only while its row is hovered or focused, so the chart stays quiet.
 * The row is a transparent strip behind the label, so hovering the bar, its
 * name or its number all count; every change is also in the hidden table.
 */
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
  const top = Number(y);
  return (
    <g
      className="group outline-none"
      // Focusable, so a keyboard or a tap can reveal the change where there's no hover.
      tabIndex={bar.change ? 0 : undefined}
      aria-label={`${bar.who}: ${bar.value}${bar.change ? `, ${bar.change.text}${TONE_WORDS[bar.change.tone]}` : ""}`}
    >
      <rect
        x={0}
        y={top - 6}
        width={10000}
        height={Number(height) + 12}
        fill="transparent"
      />
      <text
        x={Number(x) + Number(width) + 6}
        y={top + Number(height) / 2}
        // The baseline sits 0.36em under the bar's centre, which puts the digits
        // (no descenders, so not the whole text box) in the middle of the bar.
        // `dominant-baseline` centres the box and leaves them about 4px high,
        // and isn't the same in every browser, where `dy` is.
        dy="0.36em"
        fontSize={11}
      >
        <tspan className="fill-foreground">{bar.value}</tspan>
        {bar.change && (
          <tspan
            dx={6}
            fontSize={10}
            className={cn(
              SVG_TONE[bar.change.tone],
              "opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100",
            )}
          >
            {bar.change.text}
          </tspan>
        )}
      </text>
    </g>
  );
}

export function StatsSettings({
  pullRequests,
  viewer,
  buildkitePipeline,
}: {
  /** Your open PRs, already loaded: the open-PR numbers come from these. */
  pullRequests: PullRequest[];
  viewer: string | null;
  /** The Buildkite pipeline the CI tiles count builds in. */
  buildkitePipeline: string;
}) {
  const platform = usePlatform();
  const [team, setTeam] = useState<string | null>(savedTeam);
  const [teams, setTeams] = useState<Loaded<string[]>>(
    teamsCache && Date.now() - teamsCache.at < CACHE_MS
      ? { kind: "ready", value: teamsCache.teams }
      : { kind: "loading" },
  );
  const [repos, setRepos] = useState<string[]>(savedRepos);
  const repoList = useLoaded(
    "repos",
    reposCache,
    reposInFlight,
    () => platform.listStatsRepos(STATS_DAYS * 2),
  );
  const key = `${team ?? NO_TEAM}|${repos.join(",")}`;
  const stats = useLoaded(key, statsCache, statsInFlight, () =>
    platform.loadStats(team, STATS_DAYS, false, repos),
  );
  const reviews = useLoaded(key, reviewsCache, reviewsInFlight, () =>
    platform.loadReviewStats(team, STATS_DAYS, false, repos),
  );
  // The 30 days before, only to show what changed, loaded once these are showing.
  const previousStats = useLoaded(
    key,
    previousStatsCache,
    previousStatsInFlight,
    () => platform.loadStats(team, STATS_DAYS, true, repos),
    stats.kind === "ready",
  );
  const previousReviews = useLoaded(
    key,
    previousReviewsCache,
    previousReviewsInFlight,
    () => platform.loadReviewStats(team, STATS_DAYS, true, repos),
    reviews.kind === "ready",
  );
  // CI builds come from the Buildkite CLI, so only where the app can run it.
  const hasCi = platform.features.buildkite;
  const ci = useLoaded(
    `ci:${buildkitePipeline}`,
    ciCache,
    ciInFlight,
    () => platform.loadCiStats(STATS_DAYS),
    hasCi,
  );
  const ciNow = ci.kind === "ready" ? ci.value : null;
  const previousCi = useLoaded(
    `ci:${buildkitePipeline}`,
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

  function chooseRepos(next: string[]) {
    const sorted = [...next].sort();
    setRepos(sorted);
    saveRepos(sorted);
  }

  const youLabel = repos.length > 0 ? "You (chosen repos)" : "You (all repos)";
  const repoNames = repoList.kind === "ready" ? repoList.value : [];
  // A saved repo with no recent activity is still shown, so the choice isn't silently lost.
  const repoOptions = [
    ...repos.filter((repo) => !repoNames.includes(repo)),
    ...repoNames,
  ].sort();
  // Open PRs aren't counted by a search, so the ones in the chosen repos are picked out.
  const openInRepos = useMemo(
    () =>
      repos.length > 0
        ? pullRequests.filter((pr) => repos.includes(pr.repo.toLowerCase()))
        : pullRequests,
    [pullRequests, repos],
  );
  const data = stats.kind === "ready" ? stats.value : null;
  // Failing to load the earlier window just means no changes are shown.
  const before = previousStats.kind === "ready" ? previousStats.value : null;
  // The same array until a number changes (see BarsChart), so a re-render
  // from somewhere else, such as a poll, leaves the chart alone.
  const mergedBars = useMemo(
    () =>
      data
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
            youLabel,
          )
        : [],
    [team, data, before, youLabel],
  );
  const reviewData = reviews.kind === "ready" ? reviews.value : null;
  const reviewCounts = reviewData?.teamMemberReviews ?? null;
  const reviewsBefore =
    previousReviews.kind === "ready" ? previousReviews.value : null;
  const reviewBars = useMemo(
    () =>
      reviewData
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
            youLabel,
          )
        : [],
    [team, reviewData, reviewCounts, reviewsBefore, youLabel],
  );
  const teamList = teams.kind === "ready" ? teams.value : [];
  // A saved team you've since left is still shown, so the choice isn't silently lost.
  const options =
    team && !teamList.includes(team) ? [team, ...teamList] : teamList;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs text-muted-foreground">Repos</span>
        <RepoPicker
          options={repoOptions}
          chosen={repos}
          onChange={chooseRepos}
          loading={repoList.kind === "loading"}
        />
      </div>
      {repoList.kind === "error" && (
        <p className="m-0 -mt-2 text-xs text-muted-foreground">
          {repoList.message}
        </p>
      )}
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

      <section
        aria-label={`PRs merged in the last ${STATS_DAYS} days`}
        className="mb-2"
      >
        <h4 className="m-0 mb-1 text-xs font-medium">
          PRs merged, last {STATS_DAYS} days
        </h4>
        {stats.kind === "loading" && <ChartLoading bars={team ? 5 : 1} />}
        {stats.kind === "error" && (
          <Placeholder error>{stats.message}</Placeholder>
        )}
        {data && (
          <>
            <BarsChart
              bars={mergedBars}
              reserveChangeSpace={previousStats.kind !== "error"}
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

      <section
        aria-label={`Reviews done in the last ${STATS_DAYS} days`}
        className="mb-2"
      >
        <h4 className="m-0 mb-1 text-xs font-medium">
          Reviews done, last {STATS_DAYS} days
        </h4>
        {reviews.kind === "loading" && <ChartLoading bars={team ? 5 : 1} />}
        {reviews.kind === "error" && (
          <Placeholder error>{reviews.message}</Placeholder>
        )}
        {reviewData && (
          <>
            <BarsChart
              bars={reviewBars}
              reserveChangeSpace={previousReviews.kind !== "error"}
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
                  ` Hover a bar to see how it changed since the ${STATS_DAYS} days before (green is better, red worse), for your bars only.`}
              </Note>
            )}
          </>
        )}
      </section>

      <div className="grid grid-cols-2 gap-2">
        <Figure
          label="Avg time to first review"
          value={data ? averageReviewWait(data.sample, viewer) : null}
          previous={before ? averageReviewWait(before.sample, viewer) : null}
          format={duration}
          better="down"
          hint="request to first review"
          basis="merged PR"
          loading={stats.kind === "loading"}
        />
        <Figure
          label="Avg time to get approval"
          value={data ? averageApproval(data.sample, viewer) : null}
          previous={before ? averageApproval(before.sample, viewer) : null}
          format={duration}
          better="down"
          hint="from first review request to last review approval"
          basis="merged PR"
          loading={stats.kind === "loading"}
        />
        <Figure
          label="Avg time to deliver PR"
          value={data ? averageReadyToMerged(data.sample) : null}
          previous={before ? averageReadyToMerged(before.sample) : null}
          format={duration}
          better="down"
          hint="from ready for review to merged"
          basis="merged PR"
          loading={stats.kind === "loading"}
        />
        <Figure
          label="Code owners per PR"
          value={averageCodeOwners(openInRepos)}
          format={(n) => (Math.round(n * 10) / 10).toString()}
          basis="open PR"
        />
        {hasCi && (
          <>
            <Tile
              label="CI builds"
              value={ciValue(ciNow, ci.kind === "loading", (c) =>
                String(c.builds),
              )}
              detail={
                ciNow?.kind === "ok"
                  ? `on your PRs in ${buildkitePipeline}`
                  : " "
              }
              moved={
                ciNow?.kind === "ok" && ciBefore
                  ? change(ciNow.builds, ciBefore.builds)
                  : null
              }
            />
          </>
        )}
      </div>
      {hasCi && <PipelineSetting value={buildkitePipeline} />}
      {hasCi && ciNow && ciNow.kind !== "ok" && <CiHelp stats={ciNow} />}
      {/* The end of the tab, in every app, not only where the CI tiles are. */}
      <div className="mt-5 mb-2 border-t p-2">
        <Credits platform={platform} />
      </div>
    </div>
  );
}

/**
 * A multi-select of the repos to narrow the statistics to, which stays open
 * while you tick more. No repo ticked means all of them.
 */
function RepoPicker({
  options,
  chosen,
  onChange,
  loading,
}: {
  options: string[];
  chosen: string[];
  onChange: (repos: string[]) => void;
  loading: boolean;
}) {
  const summary =
    chosen.length === 0
      ? "All repos"
      : chosen.length === 1
        ? chosen[0]
        : `${chosen.length} repos`;
  const full = chosen.length >= MAX_REPOS;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 min-w-0 flex-1 justify-between px-3 text-xs font-normal"
          aria-label="Repos to show statistics for"
        >
          <span className="truncate">{loading ? "Loading repos…" : summary}</span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-72 w-(--radix-dropdown-menu-trigger-width) overflow-y-auto"
      >
        <DropdownMenuCheckboxItem
          checked={chosen.length === 0}
          onSelect={(e) => {
            e.preventDefault();
            onChange([]);
          }}
          className="text-xs"
        >
          All repos
        </DropdownMenuCheckboxItem>
        {options.length > 0 && <DropdownMenuSeparator />}
        {options.map((repo) => {
          const checked = chosen.includes(repo);
          return (
            <DropdownMenuCheckboxItem
              key={repo}
              checked={checked}
              disabled={!checked && full}
              onSelect={(e) => {
                e.preventDefault();
                onChange(
                  checked
                    ? chosen.filter((r) => r !== repo)
                    : [...chosen, repo],
                );
              }}
              className="text-xs"
            >
              {repo}
            </DropdownMenuCheckboxItem>
          );
        })}
        {full && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
              Up to {MAX_REPOS} repos
            </DropdownMenuLabel>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="m-0 mt-1 text-xs text-muted-foreground">{children}</p>;
}

/**
 * The rings with "Fetching data…" under them, centred where the chart will be,
 * with about the height it will have (a bar is 32 px, plus the margins; a team
 * has up to five bars, no team just yours, and never less than the loader
 * needs) so the page doesn't jump much when the numbers arrive.
 */
function ChartLoading({ bars }: { bars: number }) {
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center gap-1"
      style={{ height: Math.max(36 + bars * 32, 132) }}
    >
      <RingsLoader size={120} />
      <span className="text-xs text-muted-foreground">Fetching data…</span>
    </div>
  );
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

/** What a pipeline is until another is chosen. The same as the app's own default. */
const DEFAULT_PIPELINE = "kibana-pull-request";

/**
 * Which Buildkite pipeline the CI tiles count builds in. Saved when you leave
 * the field or press Enter, and synced with your other devices.
 */
function PipelineSetting({ value }: { value: string }) {
  const platform = usePlatform();
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  // A change that arrives from another device, or a reset, shows here too.
  useEffect(() => setDraft(value), [value]);

  function save(next: string) {
    setError(null);
    if (next.trim().toLowerCase() === value) return;
    platform.setBuildkitePipeline(next).catch((e) => {
      setError(String(e));
      setDraft(value);
    });
  }

  return (
    <div className="-mt-1 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <label
          htmlFor="buildkite-pipeline"
          className="shrink-0 text-xs text-muted-foreground"
        >
          Buildkite pipeline
        </label>
        <Input
          id="buildkite-pipeline"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          className="h-7 min-w-0 flex-1 text-xs md:text-xs"
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={() => save(draft)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        {value !== DEFAULT_PIPELINE && (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto shrink-0 p-0"
            onClick={() => save(DEFAULT_PIPELINE)}
          >
            Reset
          </Button>
        )}
      </div>
      <p className="m-0 text-[11px] leading-snug text-muted-foreground">
        CI builds are counted in this pipeline only.
      </p>
      {error && <p className="m-0 text-xs text-destructive">{error}</p>}
    </div>
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
      <CardContent className="flex flex-col gap-1 px-2.5">
        <span className="text-[11px] font-semibold leading-tight text-muted-foreground mb-1">
          {label}
        </span>
        <span className="text-lg leading-none font-semibold">{value}</span>
        <span className="text-[11px] leading-tight whitespace-pre-line text-muted-foreground mb-1">
          {detail}
        </span>
        {moved && (
          <span
            className={cn("text-[11px] leading-tight", TEXT_TONE[moved.tone])}
          >
            {moved.text}
          </span>
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
    return (
      <p className="m-0 -mt-2 text-xs text-destructive">{stats.message}</p>
    );
  }
  return (
    <p className="m-0 -mt-2 text-xs leading-snug text-muted-foreground">
      {stats.kind === "notInstalled" ? (
        <>
          CI build stats come from the Buildkite CLI, which isn't installed.
          Install it with{" "}
          <code className={code}>brew install buildkite/buildkite/bk@3</code>,
          then log in with <code className={code}>bk auth login</code>.{" "}
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto p-0"
            onClick={() =>
              platform.openUrl("https://buildkite.com/docs/platform/cli")
            }
          >
            Installation guide
          </Button>
        </>
      ) : (
        <>
          The Buildkite CLI isn't logged in. Run{" "}
          <code className={code}>bk auth login</code> in a terminal, then reopen
          Settings.
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
  better,
  basis,
  hint,
  loading,
}: {
  label: string;
  value: Average | null;
  /** The same over the 30 days before, to show what changed. */
  previous?: Average | null;
  format: (n: number) => string;
  /** Which way is for the better, so a change can be green or red. A shorter
   * wait is, so the timing tiles say "down". */
  better?: "up" | "down";
  basis: string;
  /** What the number runs from and to, shown before the count. */
  hint?: string;
  loading?: boolean;
}) {
  // Under a minute isn't a change worth showing for a duration.
  const moved =
    value?.average != null && previous?.average != null
      ? change(value.average, previous.average, {
          format,
          tiny: format === duration ? 60_000 : 0.05,
          better,
        })
      : null;
  return (
    <Tile
      label={label}
      value={
        loading || !value
          ? "…"
          : value.average === null
            ? "–"
            : format(value.average)
      }
      detail={
        loading || !value
          ? " "
          : [`${value.count} ${basis}${value.count === 1 ? "" : "s"}`, hint]
              .filter(Boolean)
              .join("\n\n")
      }
      moved={moved}
    />
  );
}
