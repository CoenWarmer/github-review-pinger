import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowDownWideNarrow,
  ChartColumn,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Settings,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { PrRow } from "./components/PrRow";
import { SearchResults, matchesQuery } from "./components/SearchResults";
import { ReviewRow } from "./components/ReviewRow";
import { RingsLoader } from "./components/RingsLoader";
import { UpdateBanner } from "./components/UpdateBanner";
import { SettingsPanel } from "./components/SettingsPanel";
import { RepoPicker } from "./components/RepoPicker";
import { StatsSettings } from "./components/StatsSettings";
import { Setup, problemMessage } from "./components/Setup";
import { elapsed } from "./format";
import { clearSavedLists } from "./cache";
import {
  RefreshingContext,
  ReportOpenProvider,
  useApplyTheme,
  useNow,
  useReportOpen,
  useReportViewState,
  useSnapshot,
} from "./hooks";
import { MergedRow } from "./components/MergedRow";
import { PlatformProvider, usePlatform, type Platform } from "./platform";
import { SECTION_TITLES } from "./sections";
import { SlackContext } from "./slack";
import {
  adoptLocalSorts,
  SectionSortsContext,
  SORT_OPTIONS,
  sortRows,
  useSectionSort,
  type SortKey,
} from "./sort";
import type { ReviewGroup, Section, Snapshot } from "./types";

/** Sections with little left to act on, so they start collapsed. */
/** Sections that start collapsed; every section can be toggled either way. */
const STARTS_COLLAPSED: ReadonlySet<Section> = new Set([
  "snoozed",
  "dormant",
  "draft",
  "merged",
]);

const REVIEW_SECTIONS: { group: ReviewGroup; title: string }[] = [
  { group: "needsReview", title: "Needs your review" },
  { group: "waitingOnAuthor", title: "Waiting on author" },
  { group: "snoozed", title: "Snoozed" },
  { group: "draft", title: "Drafts" },
];

type Tab = "mine" | "reviews" | "stats" | "settings";

const TABS: { id: Tab; label: string; icon?: ReactNode }[] = [
  { id: "mine", label: "My PRs" },
  { id: "reviews", label: "Review Requests" },
  { id: "stats", label: "Statistics", icon: <ChartColumn /> },
  { id: "settings", label: "Settings", icon: <Settings /> },
];

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 px-3 py-6 text-center text-muted-foreground">
      {children}
    </p>
  );
}


function Banner({ children }: { children: ReactNode }) {
  return <p className="m-0 border-t bg-warning/15 px-3 py-2">{children}</p>;
}

function SortMenu({
  value,
  onChange,
}: {
  value: SortKey;
  onChange: (key: SortKey) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Sort"
          title="Sort"
          className={cn(
            value !== "default" ? "text-info" : "text-muted-foreground",
          )}
        >
          <ArrowDownWideNarrow />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[150px] text-xs">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(key) => onChange(key as SortKey)}
        >
          {SORT_OPTIONS.map(({ key, label }) => (
            <DropdownMenuRadioItem key={key} value={key} className="text-xs">
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Section<
  T extends {
    id: string;
    repo: string;
    openSince: string;
    lastActivity: string;
  },
>({
  id,
  title,
  rows,
  defaultOpen,
  render,
}: {
  /** Names the section for remembering its sort, e.g. `mine:approved`. */
  id: string;
  title: string;
  rows: T[];
  /** Every section can be collapsed; this is just whether it starts that way. */
  defaultOpen: boolean;
  render: (row: T) => ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [sort, setSort] = useSectionSort(id);
  useReportOpen(
    id,
    open,
    rows.map((row) => row.id),
  );
  if (rows.length === 0) return null;

  const heading = (
    <>
      {title} <span className="font-normal">{rows.length}</span>
    </>
  );

  return (
    <Collapsible asChild open={open} onOpenChange={setOpen}>
      <section>
        <h2 className="sticky top-0 z-10 m-0 flex items-center justify-between border-b bg-background px-3 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-[inherit] tracking-[inherit] uppercase">
            {open ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
            {heading}
          </CollapsibleTrigger>
          <SortMenu value={sort} onChange={setSort} />
        </h2>
        <CollapsibleContent asChild>
          <ul className="m-0 list-none p-0">
            {sortRows(rows, sort).map(render)}
          </ul>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function MergedSection({
  rows,
  canLoadMore,
  now,
}: {
  rows: Snapshot["mergedPullRequests"];
  canLoadMore: boolean;
  now: number;
}) {
  const platform = usePlatform();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  if (rows.length === 0 && !canLoadMore) return null;

  async function loadMore() {
    setLoading(true);
    try {
      await platform.loadMoreMerged();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Collapsible asChild open={open} onOpenChange={setOpen}>
      <section>
        {/* As tall as the others, whose sort button sets their height. */}
        <h2 className="sticky top-0 z-10 m-0 flex min-h-[33px] items-center justify-between border-b bg-background px-3 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-[inherit] tracking-[inherit] uppercase">
            {open ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
            {SECTION_TITLES.merged}{" "}
            <span className="font-normal">{rows.length}</span>
          </CollapsibleTrigger>
        </h2>
        <CollapsibleContent asChild>
          <ul className="m-0 list-none p-0">
            {rows.map((pr) => (
              <MergedRow key={pr.id} pr={pr} now={now} />
            ))}
            {canLoadMore && (
              <li className="px-3 py-2">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={loading}
                  onClick={loadMore}
                >
                  {loading ? "Loading…" : "Load more"}
                </Button>
              </li>
            )}
          </ul>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function Footer({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const platform = usePlatform();
  return (
    <footer className="flex items-center justify-between gap-2 border-t px-3 py-1 text-xs text-muted-background">
      <span>
        {snapshot.refreshing ||
        (snapshot.stale && snapshot.status.kind !== "error")
          ? "Refreshing…"
          : snapshot.fetchedAt &&
            `Updated ${elapsed(snapshot.fetchedAt, now)} ago`}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Refresh"
        title="Refresh"
        disabled={snapshot.refreshing}
        onClick={() => platform.refresh()}
      >
        <RefreshCw className={cn(snapshot.refreshing && "animate-spin")} />
      </Button>
    </footer>
  );
}

function AppContent() {
  const platform = usePlatform();
  const snapshot = useSnapshot();
  const now = useNow();
  const [tab, setTab] = useState<Tab>("mine");
  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState<string[]>([]);
  const reportOpen = useReportViewState(tab);
  const refreshingIds = useMemo(
    () => new Set(snapshot?.refreshingIds ?? []),
    [snapshot?.refreshingIds],
  );
  useApplyTheme(snapshot?.theme);
  // Once a fetch has landed (so sync has had its say), hand over the sorts
  // this browser remembered before they were synced.
  const loaded = snapshot?.status.kind === "ok";
  useEffect(() => {
    if (loaded) adoptLocalSorts(snapshot?.sectionSorts ?? {}, platform.setSectionSort);
    // Only when it first loads: later changes come from the host.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  if (
    !snapshot ||
    (snapshot.status.kind === "loading" && !snapshot.fetchedAt)
  ) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <RingsLoader loading />
        <p className="m-0">Loading pull requests…</p>
      </div>
    );
  }
  if (snapshot.status.kind === "error" && !snapshot.fetchedAt) {
    return <Setup problem={snapshot.status.problem} />;
  }

  const allPrs = snapshot.pullRequests;
  const allReviews = snapshot.reviewRequests;
  // The repo filter narrows every list, but not the tab counts or the statistics.
  const inRepo = <T extends { repo: string }>(rows: T[]): T[] =>
    repos.length === 0 ? rows : rows.filter((row) => repos.includes(row.repo));
  const prs = inRepo(allPrs);
  const reviews = inRepo(allReviews);
  const merged = inRepo(snapshot.mergedPullRequests);
  const viewRows = (id: string) => inRepo(snapshot.viewPullRequests[id] ?? []);
  const repoOptions = [
    ...new Set(
      (tab === "reviews"
        ? allReviews
        : [
            ...allPrs,
            ...Object.values(snapshot.viewPullRequests).flat(),
            ...snapshot.mergedPullRequests,
          ]
      ).map((pr) => pr.repo),
    ),
  ].sort((a, b) => a.localeCompare(b));
  // A chosen repo stays pickable (to untick it) even once it has no PRs.
  const pickable = [
    ...repos.filter((name) => !repoOptions.includes(name)),
    ...repoOptions,
  ].sort((a, b) => a.localeCompare(b));
  const counts: Partial<Record<Tab, number>> = {
    mine: allPrs.filter(
      (pr) =>
        pr.actions.length > 0 && ["approved", "needsAction"].includes(pr.group),
    ).length,
    reviews: allReviews.filter((pr) => pr.group === "needsReview").length,
  };
  // Only the PR lists can be filtered.
  const filterable = tab === "mine" || tab === "reviews";
  const searching = filterable && query.trim() !== "";
  const searchRows = (): { ids: string[]; rows: ReactNode } => {
    if (tab === "reviews") {
      const found = reviews.filter((pr) =>
        matchesQuery(query, [
          pr.title,
          pr.repo,
          pr.number,
          pr.author,
          ...pr.reviewers.map((r) => r.login),
        ]),
      );
      return {
        ids: found.map((pr) => pr.id),
        rows: found.map((pr) => <ReviewRow key={pr.id} pr={pr} now={now} />),
      };
    }
    // A PR in a custom view may also be one of yours: list it once.
    const open = [
      ...prs,
      ...inRepo(Object.values(snapshot.viewPullRequests).flat()),
    ].filter(
      (pr, i, all) => all.findIndex((other) => other.id === pr.id) === i,
    );
    const foundOpen = open.filter((pr) =>
      matchesQuery(query, [
        pr.title,
        pr.repo,
        pr.number,
        ...pr.reviewers.map((r) => r.login),
      ]),
    );
    const foundMerged = merged.filter((pr) =>
      matchesQuery(query, [pr.title, pr.repo, pr.number]),
    );
    return {
      ids: [...foundOpen, ...foundMerged].map((pr) => pr.id),
      rows: [
        ...foundOpen.map((pr) => <PrRow key={pr.id} pr={pr} now={now} />),
        ...foundMerged.map((pr) => <MergedRow key={pr.id} pr={pr} now={now} />),
      ],
    };
  };
  const search = searching ? searchRows() : null;

  return (
    <SlackContext.Provider
      value={{
        channels: snapshot.teamChannels,
        opensIn: snapshot.slackOpensIn,
      }}
    >
      <ReportOpenProvider value={reportOpen}>
      <RefreshingContext.Provider value={refreshingIds}>
      <SectionSortsContext.Provider value={snapshot.sectionSorts ?? {}}>
        <main className="flex h-full flex-col">
          <Tabs
            value={tab}
            onValueChange={(value) => {
              setTab(value as Tab);
              // Each tab has its own repos.
              setRepos([]);
            }}
            className="gap-0 py-1"
          >
            <TabsList
              variant="line"
              className="h-auto w-full rounded-none border-b p-0"
            >
              {TABS.map(({ id, label, icon }) => (
                <TabsTrigger
                  key={id}
                  value={id}
                  aria-label={icon ? label : undefined}
                  title={icon ? label : undefined}
                  className={cn(
                    "h-9 rounded-none after:bottom-0 after:h-0.5 after:bg-info text-[12px]",
                    icon && "flex-none px-4",
                  )}
                >
                  {icon ?? label}
                  {!!counts[id] && (
                    <span className="rounded-full bg-muted px-1.5 text-[11px] leading-[18px] tabular-nums">
                      {counts[id]}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {filterable && (
            <div className="flex items-center gap-2 border-b px-3 py-3">
              <Input
                type="search"
                aria-label="Filter pull requests"
                placeholder="Filter pull requests…"
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                className="h-7 min-w-0 flex-1 text-xs md:text-xs"
              />
              {(pickable.length > 1 || repos.length > 0) && (
                <RepoPicker
                  options={pickable}
                  chosen={repos}
                  onChange={setRepos}
                  ariaLabel="Filter by repository"
                  className="w-32 shrink-0"
                />
              )}
            </div>
          )}
          {/* Pinned over the list, so a notice appearing doesn't push the rows down. */}
          <div className="relative min-h-0 flex-1">
            <ScrollArea className="h-full">
              {search ? (
                <SearchResults
                  key={`${tab}:${repos.join(",")}:${query.trim()}`}
                  query={query}
                  repos={repos}
                  shownIds={search.ids}
                  rows={search.rows}
                  now={now}
                />
              ) : tab === "stats" ? (
                // Only here, once this tab is opened, are the statistics fetched:
                // never on the polling cycle, to spare the API quota.
                <div className="px-3 py-3">
                  <StatsSettings
                    pullRequests={allPrs}
                    viewer={snapshot.viewer}
                    buildkitePipeline={snapshot.buildkitePipeline}
                  />
                </div>
              ) : tab === "settings" ? (
                <SettingsPanel
                  account={snapshot.viewer}
                  authSource={
                    snapshot.authChoice ?? (snapshot.hasSavedToken ? "pat" : "gh")
                  }
                  hasSavedToken={snapshot.hasSavedToken}
                  theme={snapshot.theme}
                  notificationsMuted={snapshot.notificationsMuted}
                  soundOnMerge={snapshot.soundOnMerge}
                  teamLookupDenied={snapshot.teamLookupDenied}
                  channels={snapshot.teamChannels}
                  sync={snapshot.sync}
                  myPrsSections={snapshot.myPrsSections}
                  views={snapshot.views}
                />
              ) : tab === "mine" ? (
                prs.length === 0 &&
                merged.length === 0 &&
                Object.values(snapshot.viewPullRequests).every(
                  (rows) => inRepo(rows).length === 0,
                ) ? (
                  <Empty>No open pull requests.</Empty>
                ) : (
                  snapshot.myPrsSections
                    .filter((pref) => pref.enabled)
                    .map((pref) => {
                      if (pref.kind === "view") {
                        const view = snapshot.views.find((v) => v.id === pref.id);
                        if (!view) return null;
                        return (
                          <Section
                            key={`view:${pref.id}`}
                            id={`mine:view:${pref.id}`}
                            title={view.name}
                            rows={viewRows(pref.id)}
                            defaultOpen={false}
                            render={(pr) => (
                              <PrRow key={pr.id} pr={pr} now={now} />
                            )}
                          />
                        );
                      }
                      if (pref.section === "merged") {
                        return (
                          <MergedSection
                            key="merged"
                            rows={merged}
                            canLoadMore={snapshot.mergedCanLoadMore}
                            now={now}
                          />
                        );
                      }
                      return (
                        <Section
                          key={pref.section}
                          id={`mine:${pref.section}`}
                          title={SECTION_TITLES[pref.section]}
                          rows={prs.filter((pr) => pr.group === pref.section)}
                          defaultOpen={!STARTS_COLLAPSED.has(pref.section)}
                          render={(pr) => <PrRow key={pr.id} pr={pr} now={now} />}
                        />
                      );
                    })
                )
              ) : snapshot.partial && reviews.length === 0 ? (
                // My PRs came first; this is still on its way, so empty isn't known.
                snapshot.status.kind === "error" ? (
                  <Empty>Couldn't load review requests.</Empty>
                ) : (
                  <div className="flex flex-col items-center gap-3 px-3 py-10 text-muted-foreground">
                    <RingsLoader loading />
                    <p className="m-0">Loading review requests…</p>
                  </div>
                )
              ) : reviews.length === 0 ? (
                <Empty>No pull requests are waiting on your review.</Empty>
              ) : (
                REVIEW_SECTIONS.map(({ group, title }) => (
                  <Section
                    key={group}
                    id={`reviews:${group}`}
                    title={title}
                    rows={reviews.filter((pr) => pr.group === group)}
                    defaultOpen={group !== "snoozed" && group !== "draft"}
                    render={(pr) => <ReviewRow key={pr.id} pr={pr} now={now} />}
                  />
                ))
              )}
            </ScrollArea>
            <div className="absolute inset-x-0 bottom-0 z-10 bg-background">
              {snapshot.status.kind === "error" && (
                <Banner>
                  {problemMessage(
                    snapshot.status.problem,
                    platform.features.githubCli,
                  )}
                </Banner>
              )}
              <UpdateBanner />
              {snapshot.ssoPartial && (
                <Banner>
                  Some organizations are hidden because this token isn't
                  authorized for their SSO.
                </Banner>
              )}
            </div>
          </div>
          <Footer snapshot={snapshot} now={now} />
        </main>
      </SectionSortsContext.Provider>
      </RefreshingContext.Provider>
      </ReportOpenProvider>
    </SlackContext.Provider>
  );
}

/** The whole popover UI, for a host that supplies what it can do. */
export function App({ platform }: { platform: Platform }) {
  // Lists saved for one account mustn't show for another, so anything that
  // changes who's signed in forgets them first.
  const guarded = useMemo<Platform>(
    () => ({
      ...platform,
      saveToken: (token, sync) => {
        clearSavedLists();
        return platform.saveToken(token, sync);
      },
      clearToken: () => {
        clearSavedLists();
        return platform.clearToken();
      },
      setAuthSource: (source) => {
        clearSavedLists();
        platform.setAuthSource(source);
      },
    }),
    [platform],
  );
  return (
    <PlatformProvider platform={guarded}>
      <AppContent />
    </PlatformProvider>
  );
}
