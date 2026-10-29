import { useEffect, useState } from "react";
import { Bar, BarChart, Cell, LabelList, XAxis, YAxis } from "recharts";
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
  duration,
  perMember,
  type Average,
} from "../stats";
import type { PullRequest, StatsData } from "../types";

const TEAM_KEY = "reviewPinger.statsTeam";
const NO_TEAM = "none";

/**
 * Statistics are fetched only when Settings is opened, never on the polling
 * cycle, and a result is reused for a few minutes so going back and forth
 * doesn't ask GitHub again.
 */
const CACHE_MS = 10 * 60_000;
const statsCache = new Map<string, { at: number; stats: StatsData }>();
let teamsCache: { at: number; teams: string[] } | null = null;
/** A request already under way is shared, so opening Settings twice in a row asks once. */
const statsInFlight = new Map<string, Promise<StatsData>>();
let teamsInFlight: Promise<string[]> | null = null;

function shared<T>(inFlight: Promise<T> | undefined, start: () => Promise<T>, done: () => void) {
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

/** Your bar in the accent colour, the team's in neutral: one measure, two entities. */
const chartConfig = {
  merged: { label: "PRs merged" },
} satisfies ChartConfig;

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
  const [stats, setStats] = useState<Loaded<StatsData>>({ kind: "loading" });

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

  // The merge counts and the merged-PR sample, for the chosen team.
  useEffect(() => {
    const key = team ?? NO_TEAM;
    const cached = statsCache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      setStats({ kind: "ready", value: cached.stats });
      return;
    }
    let stale = false;
    setStats({ kind: "loading" });
    const request = shared(
      statsInFlight.get(key),
      () => platform.loadStats(team, STATS_DAYS),
      () => statsInFlight.delete(key),
    );
    statsInFlight.set(key, request);
    request
      .then((loaded) => {
        statsCache.set(key, { at: Date.now(), stats: loaded });
        if (!stale) setStats({ kind: "ready", value: loaded });
      })
      .catch((e) => {
        if (!stale) setStats({ kind: "error", message: String(e) });
      });
    return () => {
      stale = true;
    };
  }, [platform, team]);

  function choose(value: string) {
    const next = value === NO_TEAM ? null : value;
    setTeam(next);
    saveTeam(next);
  }

  const data = stats.kind === "ready" ? stats.value : null;
  const perMemberAverage = data && team ? perMember(data.mergedByTeam, data.teamMemberCount) : null;
  const bars = data
    ? [
        { who: "You (all repos)", merged: data.mergedByMe, fill: "var(--info)" },
        // Counted in the team's org, like the team, so the two compare.
        ...(team && data.mergedByMeInTeamOrg !== null
          ? [
              {
                who: "You (compared to team)",
                merged: data.mergedByMeInTeamOrg,
                fill: "var(--info)",
              },
            ]
          : []),
        ...(data.mergedByTeam !== null && team
          ? [{ who: team.split("/")[1] ?? team, merged: data.mergedByTeam, fill: "var(--muted-foreground)" }]
          : []),
        ...(perMemberAverage !== null
          ? [
              {
                who: "Avg per member",
                // One decimal, so the label, tooltip and table all say the same.
                merged: Math.round(perMemberAverage * 10) / 10,
                // The same neutral, lighter: it's derived from the bar above.
                fill: "color-mix(in oklab, var(--muted-foreground) 60%, transparent)",
              },
            ]
          : []),
      ]
    : [];
  const teamList = teams.kind === "ready" ? teams.value : [];
  // A saved team you've since left is still shown, so the choice isn't silently lost.
  const options = team && !teamList.includes(team) ? [team, ...teamList] : teamList;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs text-muted-foreground">Compare with team</span>
        <Select value={team ?? NO_TEAM} onValueChange={choose} disabled={teams.kind === "loading"}>
          <SelectTrigger size="sm" className="h-7 min-w-0 flex-1 text-xs" aria-label="Team to compare with">
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
        <p className="m-0 -mt-2 text-xs text-muted-foreground">{teams.message}</p>
      )}

      <section aria-label={`PRs merged in the last ${STATS_DAYS} days`}>
        <h4 className="m-0 mb-1 text-xs font-medium">
          PRs merged, last {STATS_DAYS} days
        </h4>
        {stats.kind === "loading" && <Placeholder>Loading…</Placeholder>}
        {stats.kind === "error" && <Placeholder error>{stats.message}</Placeholder>}
        {data && (
          <>
            <ChartContainer
              config={chartConfig}
              className="aspect-auto w-full"
              style={{ height: 36 + bars.length * 32 }}
            >
              <BarChart
                data={bars}
                layout="vertical"
                margin={{ top: 0, right: 32, bottom: 0, left: 0 }}
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
                <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
                <Bar dataKey="merged" radius={[0, 4, 4, 0]}>
                  {bars.map((bar) => (
                    <Cell key={bar.who} fill={bar.fill} />
                  ))}
                  <LabelList
                    dataKey="merged"
                    position="right"
                    className="fill-foreground"
                    fontSize={11}
                  />
                </Bar>
              </BarChart>
            </ChartContainer>
            {/* The same numbers as text, for anyone who can't read the chart. */}
            <table className="sr-only">
              <caption>PRs merged in the last {STATS_DAYS} days</caption>
              <tbody>
                {bars.map((bar) => (
                  <tr key={bar.who}>
                    <th scope="row">{bar.who}</th>
                    <td>{bar.merged}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!team && (
              <p className="m-0 mt-1 text-xs text-muted-foreground">
                Choose a team to compare with its members' merges.
              </p>
            )}
            {team && (
              <p className="m-0 mt-1 text-xs text-muted-foreground">
                "You (compared to team)" and the team's bars count merges in {team.split("/")[0]}{" "}
                only.
              </p>
            )}
            {team && data.teamMembersCapped && (
              <p className="m-0 mt-1 text-xs text-muted-foreground">
                This team has more than 500 members. Only the first 500 are counted, so the
                number is short.
              </p>
            )}
          </>
        )}
      </section>

      <div className="grid grid-cols-2 gap-2">
        <Figure
          label="Review wait, merged"
          value={data ? averageReviewWait(data.sample, viewer) : null}
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
      </div>
      <p className="m-0 -mt-2 text-[11px] leading-snug text-muted-foreground">
        Review wait is the time from a merged PR's first review request to its first review by
        someone else, over your latest 100 merged PRs. Code owners are the pending requests
        GitHub made from CODEOWNERS, on open PRs that aren't drafts.
      </p>
    </div>
  );
}

function Placeholder({ children, error }: { children: string; error?: boolean }) {
  return (
    <p
      className={`m-0 py-3 text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}
    >
      {children}
    </p>
  );
}

/** One number with its label and how many PRs it's over. */
function Figure({
  label,
  value,
  format,
  basis,
  loading,
}: {
  label: string;
  value: Average | null;
  format: (n: number) => string;
  basis: string;
  loading?: boolean;
}) {
  return (
    <Card className="gap-1 rounded-lg py-2 shadow-none">
      <CardContent className="flex flex-col gap-0.5 px-2.5">
        <span className="text-[11px] leading-tight text-muted-foreground">{label}</span>
        <span className="text-lg leading-tight font-semibold">
          {loading || !value ? "…" : value.average === null ? "–" : format(value.average)}
        </span>
        <span className="text-[11px] leading-tight text-muted-foreground">
          {loading || !value
            ? " "
            : `${value.count} ${basis}${value.count === 1 ? "" : "s"}`}
        </span>
      </CardContent>
    </Card>
  );
}
