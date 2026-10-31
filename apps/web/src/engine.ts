// The web app's counterpart of the desktop poller: it owns the snapshot the UI
// shows, polls GitHub, refreshes what you visited, looks up team members, and
// keeps what the Rust logic must remember in browser storage. Browser APIs are
// passed in, so it runs under Node for tests.

import type {
  MergedPr,
  Problem,
  PullRequest,
  ReviewRequest,
  SectionPref,
  Snapshot,
  SyncStatus,
  TeamChannel,
  Theme,
  View,
} from "@review-pinger/app";
import {
  FetchError,
  type Fetched,
  type Found,
  type FoundPullRequest,
  type ReviewStatsData,
  type StatsData,
  type Github,
  type Needs,
  type Plan,
  type Progress,
  type RawMergedPullRequest,
  type RawPullRequest,
} from "./github.ts";
import { applyProgress, emptyFetched } from "./progress.ts";

const TOKEN_KEY = "reviewPinger.token";
const STATE_KEY = "reviewPinger.state";

const POLL_INTERVAL_MS = 120_000;
const MAX_BACKOFF_MS = 600_000;
const SYNC_DELAY_MS = 1_000;
/// Gists are listed 100 at a time.
const MAX_GIST_PAGES = 5;
/// Fetched automatically with every poll, while the Merged section is on.
const MERGED_PAGE_SIZE = 30;
/// Fetched per "Load more" click.
const MERGED_LOAD_MORE = 5;
/// The six "My PRs" sections that come from the one open-PR fetch, as opposed
/// to "merged", which needs its own.
const OPEN_SECTIONS = new Set(["approved", "needsAction", "waiting", "snoozed", "dormant", "draft"]);

/** Whether fetching your open PRs, and your merged PRs, can be skipped. */
function sectionNeeds(sections: SectionPref[]): { open: boolean; merged: boolean; viewIds: string[] } {
  const builtinEnabled = (section: string) =>
    sections.some((pref) => pref.kind === "builtin" && pref.section === section && pref.enabled);
  return {
    open: sections.some(
      (pref) => pref.kind === "builtin" && OPEN_SECTIONS.has(pref.section) && pref.enabled,
    ),
    merged: builtinEnabled("merged"),
    viewIds: sections.flatMap((pref) => (pref.kind === "view" && pref.enabled ? [pref.id] : [])),
  };
}

/** The text to actually search: `is:pr`, then whatever the view asks for. */
function viewSearch(view: View): string {
  const query = view.query.trim();
  return query ? `is:pr ${query}` : "is:pr";
}

/** What the engine needs to keep, like `localStorage`. */
export interface KeyValue {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** The part of the WebAssembly `Pinger` the engine uses. */
export interface PingerLike {
  state(): string;
  reviewedSince(now: string): string;
  poll(fetched: string, now: string, tzOffsetMinutes: number): string;
  derived(now: string): string | undefined | null;
  applyRefresh(fresh: string): void;
  setSnooze(id: string, days: number | undefined | null, now: string): void;
  directoryNeeds(now: string): string;
  mergeDirectory(asked: string, found: string, now: string): boolean;
  directoryDenied(): boolean;
  setTeamChannel(team: string, link: string, now: string): void;
  removeTeamChannel(team: string, now: string): void;
  myPrsSections(): string;
  setMyPrsSections(sections: string, now: string): void;
  buildkitePipeline(): string;
  setBuildkitePipeline(name: string, now: string): boolean;
  sectionSorts(): string;
  setSectionSort(id: string, key: string, now: string): boolean;
  mergedDerive(page: string, loadedMore: string, now: string): string;
  views(): string;
  addView(name: string, query: string, now: string): string;
  updateView(id: string, name: string, query: string, now: string): void;
  removeView(id: string, now: string): void;
  setNotificationsMuted(muted: boolean): void;
  notificationsMuted(): boolean;
  preview(fetched: string, now: string): string;
  setTheme(theme: string): void;
  theme(): string;
  syncEnabled(): boolean;
  setSyncEnabled(enabled: boolean): void;
  syncGist(): string | undefined | null;
  setSyncGist(id: string | undefined | null): void;
  syncGistUrl(): string | undefined | null;
  canSync(scopes: string | undefined | null): boolean;
  findSyncGist(list: string): string | undefined | null;
  syncReconcile(gist: string | undefined | null, now: string): string;
}

export interface EngineDeps {
  storage: KeyValue;
  /** Restores the Rust state from what `state()` returned on an earlier visit. */
  loadPinger(saved: string | null): Promise<PingerLike>;
  createGithub(token: string): Github;
  now?: () => Date;
  /** Local time east of UTC, in minutes. */
  tzOffsetMinutes?: () => number;
  /** How long a change waits to be shared with other devices, so several go out together. */
  syncDelayMs?: number;
}

interface Update {
  pullRequests: PullRequest[];
  reviewRequests: ReviewRequest[];
  teamChannels: Record<string, TeamChannel>;
  /** Each custom view's matching PRs, by view id. */
  views: Record<string, PullRequest[]>;
}

function problemOf(error: unknown): Problem {
  if (error instanceof FetchError) {
    switch (error.kind) {
      case "unauthorized":
        return { code: "tokenRejected", source: "pat" };
      case "rateLimited":
        return { code: "rateLimited", resetAt: error.resetAt };
      case "network":
        return { code: "network", message: error.message };
      case "api":
        return { code: "api", message: error.message };
    }
  }
  return { code: "api", message: error instanceof Error ? error.message : String(error) };
}

export class Engine {
  private pinger!: PingerLike;
  private github: Github | null = null;
  private token: string | null = null;
  private snapshot: Snapshot;
  private listeners = new Set<(snapshot: Snapshot) => void>();
  private visited = new Set<string>();
  /** What the page is showing; the next poll fetches that first. */
  private viewState = { reviewsTab: false, openIds: new Set<string>() };
  /** The last complete fetch, which a poll's phases are patched into for display. */
  private lastFetched: Fetched | null = null;
  /** Ids of the viewer's own PRs, which are the only ones that need a merge state. */
  private ownIds = new Set<string>();
  /** The Merged section's latest automatic fetch, and what "Load more" has
   * fetched this session; neither persisted, both reset on reload. */
  private mergedPage: RawMergedPullRequest[] = [];
  private mergedLoadedMore: RawMergedPullRequest[] = [];
  private mergedCursor: string | null = null;
  private mergedHasMore = false;
  private polling: Promise<void> | null = null;
  /** Syncs run one after another. */
  private syncQueue: Promise<unknown> = Promise.resolve();
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private visible = true;
  private started = false;
  private stopped = false;
  private deps: EngineDeps;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.snapshot = {
      status: { kind: "loading" },
      refreshing: false,
      viewer: null,
      tokenSource: "pat",
      authChoice: null,
      hasSavedToken: false,
      notificationsMuted: false,
      partial: false,
      theme: "system",
      soundOnMerge: false,
      teamLookupDenied: false,
      fetchedAt: null,
      ssoPartial: false,
      pullRequests: [],
      reviewRequests: [],
      teamChannels: {},
      slackOpensIn: "app",
      sync: { enabled: false, available: null, lastSyncedAt: null, gistUrl: null, error: null },
      myPrsSections: [],
      buildkitePipeline: "kibana-pull-request",
      sectionSorts: {},
      mergedPullRequests: [],
      mergedCanLoadMore: false,
      views: [],
      viewPullRequests: {},
    };
  }

  private now = () => (this.deps.now ?? (() => new Date()))();
  private nowIso = () => this.now().toISOString();

  getSnapshot(): Snapshot {
    return this.snapshot;
  }

  /** Calls `listener` with every new snapshot. Returns how to stop. */
  subscribe(listener: (snapshot: Snapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(change: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private publishSync(change: Partial<SyncStatus>) {
    this.publish({ sync: { ...this.snapshot.sync, ...change } });
  }

  private persist() {
    this.deps.storage.set(STATE_KEY, this.pinger.state());
  }

  private applyUpdate(update: Update) {
    this.publish({
      pullRequests: update.pullRequests,
      reviewRequests: update.reviewRequests,
      teamChannels: update.teamChannels,
      viewPullRequests: update.views,
      teamLookupDenied: this.pinger.directoryDenied(),
    });
  }

  /** Shows the lists again from the last fetch, after something changed. */
  private rederive() {
    const raw = this.pinger.derived(this.nowIso());
    if (raw) this.applyUpdate(JSON.parse(raw));
    // Not part of Update: the view definitions themselves (name, query),
    // as opposed to each view's matching PRs, which `applyUpdate` just set.
    this.publish({
      views: JSON.parse(this.pinger.views()) as View[],
      myPrsSections: JSON.parse(this.pinger.myPrsSections()) as SectionPref[],
      buildkitePipeline: this.pinger.buildkitePipeline(),
      sectionSorts: JSON.parse(this.pinger.sectionSorts()) as Record<string, string>,
    });
  }

  /** Loads what was kept, then starts polling if there's a token. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.pinger = await this.deps.loadPinger(this.deps.storage.get(STATE_KEY));
    this.token = this.deps.storage.get(TOKEN_KEY);
    this.github = this.token ? this.deps.createGithub(this.token) : null;
    this.publish({
      hasSavedToken: this.token !== null,
      notificationsMuted: this.pinger.notificationsMuted(),
      theme: this.pinger.theme() as Theme,
      sync: {
        ...this.snapshot.sync,
        enabled: this.pinger.syncEnabled(),
        gistUrl: this.pinger.syncGistUrl() ?? null,
      },
      myPrsSections: JSON.parse(this.pinger.myPrsSections()) as SectionPref[],
      views: JSON.parse(this.pinger.views()) as View[],
      buildkitePipeline: this.pinger.buildkitePipeline(),
      sectionSorts: JSON.parse(this.pinger.sectionSorts()) as Record<string, string>,
    });
    if (this.token) await this.poll();
    else this.publish({ status: { kind: "error", problem: { code: "noToken" } } });
  }

  /** Pauses polling while the page is hidden, and catches up when it's shown again. */
  setVisible(visible: boolean) {
    this.visible = visible;
    if (visible && this.started) void this.shown();
  }

  private schedule(delayMs: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.visible) void this.poll();
      else this.schedule(POLL_INTERVAL_MS);
    }, delayMs);
  }

  /** Refreshes the PRs you opened first, then the whole list. */
  private async shown() {
    if (!this.github || !this.pinger) return;
    const ids = [...this.visited];
    this.visited.clear();
    if (ids.length > 0) await this.refreshVisited(ids);
    await this.poll();
  }

  private async refreshVisited(ids: string[]) {
    const github = this.github;
    if (!github) return;
    try {
      const fresh = await github.fetchDetails(ids);
      const own = fresh.filter((pr) => this.ownIds.has(pr.id));
      await github.addRequiredChecks(own);
      await github.addMergeStates(own);
      this.pinger.applyRefresh(JSON.stringify(fresh));
      this.rederive();
      this.persist();
    } catch (e) {
      // Only the full refresh reports problems.
      console.warn("Could not refresh visited pull requests", e);
    }
  }

  /** Stops polling for good, including a poll that's still in flight. */
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
  }

  /** Remembers what the page is showing, for the next poll to fetch first. */
  setViewState(state: { reviewsTab: boolean; openIds: string[] }) {
    this.viewState = { reviewsTab: state.reviewsTab, openIds: new Set(state.openIds) };
  }

  /** Asks the next poll to refresh a PR first, and remembers it for the next visit. */
  markVisited(id: string) {
    this.visited.add(id);
  }

  /** Fetches everything and updates the lists. */
  refresh(): Promise<void> {
    return this.poll();
  }

  private poll(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async pollOnce() {
    const github = this.github;
    if (!github) {
      this.publish({ status: { kind: "error", problem: { code: "noToken" } } });
      return;
    }
    this.publish({ refreshing: true });
    let delay = POLL_INTERVAL_MS;
    try {
      const now = this.nowIso();
      // The decision uses sections and views as they stood before this poll's
      // sync, if any; a change synced in just now takes one more poll.
      const needs = sectionNeeds(JSON.parse(this.pinger.myPrsSections()) as SectionPref[]);
      const allViews = JSON.parse(this.pinger.views()) as View[];
      const views: [string, string][] = needs.viewIds.flatMap((id) => {
        const view = allViews.find((v) => v.id === id);
        return view ? [[id, viewSearch(view)] as [string, string]] : [];
      });
      // Synced alongside, so the lists are derived with the snoozes of other devices.
      // Each phase of the fetch (the PRs on screen, the rest of the open
      // tab, the other tab) is shown as it lands, patched into the last fetch.
      const firstLoad = this.snapshot.fetchedAt === null;
      let shown = this.lastFetched ?? emptyFetched();
      const showProgress = (progress: Progress) => {
        shown = applyProgress(shown, progress);
        this.showProgress(shown, now, firstLoad);
      };
      const plan = this.plan();
      const [fetched, mergedPage] = await Promise.all([
        github.fetchOpenPullRequests(
          this.pinger.reviewedSince(now),
          needs.open,
          views,
          plan,
          showProgress,
        ),
        needs.merged ? github.fetchMergedPage(null, MERGED_PAGE_SIZE) : Promise.resolve(null),
        this.sync(),
      ]);
      this.ownIds = new Set(fetched.pullRequests.map((pr) => pr.id));
      this.lastFetched = fetched;
      const tz = this.deps.tzOffsetMinutes?.() ?? -new Date().getTimezoneOffset();
      const update: Update = JSON.parse(this.pinger.poll(JSON.stringify(fetched), now, tz));
      if (mergedPage) {
        this.mergedPage = mergedPage.items;
        this.mergedCursor = mergedPage.endCursor;
        this.mergedHasMore = mergedPage.hasNextPage;
      }
      const mergedPullRequests: MergedPr[] = JSON.parse(
        this.pinger.mergedDerive(
          JSON.stringify(this.mergedPage),
          JSON.stringify(this.mergedLoadedMore),
          now,
        ),
      );
      this.failures = 0;
      this.persist();
      this.publish({
        refreshing: false,
        partial: false,
        status: { kind: "ok" },
        viewer: fetched.viewer,
        fetchedAt: now,
        ssoPartial: fetched.ssoPartial,
        // Re-read, so a section or view change synced in just now shows right away.
        myPrsSections: JSON.parse(this.pinger.myPrsSections()) as SectionPref[],
        views: JSON.parse(this.pinger.views()) as View[],
        sectionSorts: JSON.parse(this.pinger.sectionSorts()) as Record<string, string>,
        mergedPullRequests,
        mergedCanLoadMore: this.mergedHasMore,
      });
      this.applyUpdate(update);
      await this.refreshDirectory(github);
    } catch (e) {
      const problem = problemOf(e);
      console.warn("Refresh failed", e);
      this.failures++;
      delay =
        e instanceof FetchError && e.kind === "rateLimited" && e.resetAt
          ? Math.min(Math.max(Date.parse(e.resetAt) - this.now().getTime(), 60_000), 3_600_000)
          : Math.min(30_000 * 2 ** (this.failures - 1), MAX_BACKOFF_MS);
      // Keep showing the last good data alongside the problem.
      this.publish({ refreshing: false, status: { kind: "error", problem } });
    }
    this.schedule(delay);
  }

  /**
   * The PRs in open sections, which are refetched without waiting for the
   * searches. Only ones the last fetch knows can be, so none on a first load.
   */
  private plan(): Plan {
    const last = this.lastFetched;
    const known = new Set(
      last
        ? [
            ...last.pullRequests,
            ...last.reviewPullRequests,
            ...Object.values(last.viewPullRequests).flat(),
          ].map((pr) => pr.id)
        : [],
    );
    const first = [...this.viewState.openIds].filter((id) => known.has(id));
    return { first, own: first.filter((id) => this.ownIds.has(id)), reviewsTab: this.viewState.reviewsTab };
  }

  /**
   * Shows what a refresh has fetched so far. Display only: notifications and
   * what's remembered wait for the complete fetch. On a first load, what's
   * still empty isn't known to be, so it's marked partial.
   */
  private showProgress(shown: Fetched, now: string, firstLoad: boolean) {
    const update: Update = JSON.parse(this.pinger.preview(JSON.stringify(shown), now));
    this.publish({
      ...(firstLoad && {
        partial: true,
        status: { kind: "ok" as const },
        viewer: shown.viewer,
        fetchedAt: now,
        ssoPartial: shown.ssoPartial,
      }),
      pullRequests: update.pullRequests,
      reviewRequests: update.reviewRequests,
      viewPullRequests: update.views,
    });
  }

  /** Looks up the team members the hover cards still need, and redraws if any arrived. */
  private async refreshDirectory(github: Github) {
    try {
      const needs: Needs = JSON.parse(this.pinger.directoryNeeds(this.nowIso()));
      if (needs.teams.length === 0) return;
      const found: Found = await github.fetchDirectory(needs);
      const changed = this.pinger.mergeDirectory(
        JSON.stringify(needs),
        JSON.stringify(found),
        this.nowIso(),
      );
      if (changed) {
        this.rederive();
        this.persist();
      }
    } catch (e) {
      // The cards then show what they can, and the next poll tries again.
      console.warn("Could not look up teams", e);
    }
  }

  snooze(id: string, days: number | undefined) {
    this.pinger.setSnooze(id, days, this.nowIso());
    this.persist();
    this.rederive();
    this.syncSoon();
  }

  setTeamChannel(team: string, link: string) {
    this.pinger.setTeamChannel(team, link, this.nowIso());
    this.persist();
    this.rederive();
    this.syncSoon();
  }

  removeTeamChannel(team: string) {
    this.pinger.removeTeamChannel(team, this.nowIso());
    this.persist();
    this.rederive();
    this.syncSoon();
  }

  /** Saves the order and visibility of "My PRs" sections, and refreshes
   * right away in case a section just turned on needs fetching. */
  setMyPrsSections(sections: SectionPref[]) {
    this.pinger.setMyPrsSections(JSON.stringify(sections), this.nowIso());
    this.persist();
    this.publish({ myPrsSections: JSON.parse(this.pinger.myPrsSections()) as SectionPref[] });
    this.syncSoon();
    void this.refresh();
  }

  /**
   * Chooses the Buildkite pipeline the CI statistics count builds in, and
   * shares it. Rejects with a message to show when it isn't a pipeline name.
   * Nothing in the browser shows it, but a device that does reads it from
   * the same gist.
   */
  setBuildkitePipeline(name: string) {
    if (!this.pinger.setBuildkitePipeline(name, this.nowIso())) {
      throw "A pipeline name is letters, digits, dashes, underscores and dots.";
    }
    this.persist();
    this.publish({ buildkitePipeline: this.pinger.buildkitePipeline() });
    this.syncSoon();
  }

  /** Sorts a section's PRs, or puts it back with `default`, and shares the choice. */
  setSectionSort(id: string, key: string) {
    if (!this.pinger.setSectionSort(id, key, this.nowIso())) return;
    this.persist();
    this.publish({
      sectionSorts: JSON.parse(this.pinger.sectionSorts()) as Record<string, string>,
    });
    this.syncSoon();
  }

  /** Adds a view and refreshes right away, so it shows without waiting for
   * the next poll. */
  addView(name: string, query: string) {
    this.pinger.addView(name, query, this.nowIso());
    this.persist();
    this.publish({
      views: JSON.parse(this.pinger.views()) as View[],
      myPrsSections: JSON.parse(this.pinger.myPrsSections()) as SectionPref[],
    });
    this.syncSoon();
    void this.refresh();
  }

  updateView(id: string, name: string, query: string) {
    this.pinger.updateView(id, name, query, this.nowIso());
    this.persist();
    this.publish({ views: JSON.parse(this.pinger.views()) as View[] });
    this.syncSoon();
    void this.refresh();
  }

  removeView(id: string) {
    this.pinger.removeView(id, this.nowIso());
    this.persist();
    const viewPullRequests = { ...this.snapshot.viewPullRequests };
    delete viewPullRequests[id];
    this.publish({
      views: JSON.parse(this.pinger.views()) as View[],
      myPrsSections: JSON.parse(this.pinger.myPrsSections()) as SectionPref[],
      viewPullRequests,
    });
    this.syncSoon();
  }

  /** Fetches further merged PRs, older than what's already shown. Errors are
   * only logged: the button stays put, so trying again costs a click. */
  async loadMoreMerged(): Promise<void> {
    const github = this.github;
    if (!github || !this.mergedHasMore) return;
    try {
      const page = await github.fetchMergedPage(this.mergedCursor, MERGED_LOAD_MORE);
      this.mergedLoadedMore = [...this.mergedLoadedMore, ...page.items];
      this.mergedCursor = page.endCursor;
      this.mergedHasMore = page.hasNextPage;
      const mergedPullRequests: MergedPr[] = JSON.parse(
        this.pinger.mergedDerive(
          JSON.stringify(this.mergedPage),
          JSON.stringify(this.mergedLoadedMore),
          this.nowIso(),
        ),
      );
      this.publish({ mergedPullRequests, mergedCanLoadMore: this.mergedHasMore });
    } catch (e) {
      console.warn("Could not load more merged PRs", e);
    }
  }

  /** Searches GitHub for the search box. Rejects with a message to show. */
  async searchPullRequests(text: string): Promise<FoundPullRequest[]> {
    if (!this.github) throw "There's no token to search with.";
    try {
      return await this.github.searchPullRequests(text);
    } catch (e) {
      throw e instanceof Error ? e.message : String(e);
    }
  }

  /** The teams you belong to, for the statistics. Rejects with a message to show. */
  async listTeams(): Promise<string[]> {
    if (!this.github) throw "There's no token to look teams up with.";
    try {
      return await this.github.fetchMyTeams();
    } catch (e) {
      throw e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * The statistics for the last `days`, or with `previous` for the same
   * number of days before those, which is only compared with. Rejects with a
   * message to show.
   */
  async loadStats(team: string | null, days: number, previous = false): Promise<StatsData> {
    if (!this.github) throw "There's no token to load statistics with.";
    const day = (back: number) =>
      new Date(this.now().getTime() - back * 86_400_000).toISOString().slice(0, 10);
    // The earlier window is the same length and ends the day before this one starts.
    const range = previous ? `${day(2 * days)}..${day(days + 1)}` : `>=${day(days)}`;
    try {
      return await this.github.fetchStats(team, range, !previous);
    } catch (e) {
      throw e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * The reviews submitted in the last `days`, or with `previous` in the same
   * number of days before those. Rejects with a message to show.
   */
  async loadReviewStats(
    team: string | null,
    days: number,
    previous = false,
  ): Promise<ReviewStatsData> {
    if (!this.github) throw "There's no token to load statistics with.";
    // The earlier window is the same length and ends where this one starts.
    const to = new Date(this.now().getTime() - (previous ? days * 86_400_000 : 0));
    const from = new Date(to.getTime() - days * 86_400_000);
    try {
      return await this.github.fetchReviewStats(team, from.toISOString(), to.toISOString(), !previous);
    } catch (e) {
      throw e instanceof Error ? e.message : String(e);
    }
  }

  /** Whether a token that isn't saved yet could sync, for the sign-in form. */
  async canSync(token: string): Promise<boolean> {
    try {
      const scopes = await this.deps.createGithub(token.trim()).scopes();
      return this.pinger.canSync(scopes);
    } catch {
      return false;
    }
  }

  setSync(enabled: boolean) {
    if (enabled && this.snapshot.sync.available === false) return;
    this.pinger.setSyncEnabled(enabled);
    this.persist();
    this.publishSync({ enabled, error: null });
    if (enabled) this.syncSoon(0);
  }

  /** Shares a change, after a moment so several go out together. */
  private syncSoon(delayMs = this.deps.syncDelayMs ?? SYNC_DELAY_MS) {
    if (this.stopped || !this.pinger.syncEnabled()) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.sync().then((changed) => {
        if (changed) this.rederive();
      });
    }, delayMs);
  }

  /**
   * Merges the snoozes and channels with the sync gist, if syncing is on and
   * the token can use gists. Returns whether anything here changed. Problems
   * are shown in the settings and never thrown.
   */
  private sync(): Promise<boolean> {
    const run = this.syncQueue.then(() => this.syncOnce());
    this.syncQueue = run;
    return run;
  }

  private async syncOnce(): Promise<boolean> {
    const github = this.github;
    if (!github) return false;
    try {
      if (this.snapshot.sync.available === null) {
        this.publishSync({ available: this.pinger.canSync(await github.scopes()) });
      }
      if (this.snapshot.sync.available !== true || !this.pinger.syncEnabled()) return false;

      let id = this.pinger.syncGist() ?? null;
      for (let page = 1; !id && page <= MAX_GIST_PAGES; page++) {
        const list = await github.gists(page);
        id = this.pinger.findSyncGist(list) ?? null;
        if ((JSON.parse(list) as unknown[]).length < 100) break;
      }
      let remote = id ? await github.gist(id) : null;
      // Deleted, so a new one is made from what's here.
      if (id && remote === null) id = null;

      const now = this.nowIso();
      const result: { changed: boolean; createBody: string | null; updateBody: string | null } =
        JSON.parse(this.pinger.syncReconcile(remote, now));
      this.pinger.setSyncGist(id);
      if (result.updateBody !== null && result.createBody !== null) {
        if (id) {
          await github.updateGist(id, result.updateBody);
        } else {
          id = await github.createGist(result.createBody);
          this.pinger.setSyncGist(id);
        }
      }
      this.persist();
      this.publishSync({
        lastSyncedAt: now,
        gistUrl: this.pinger.syncGistUrl() ?? null,
        error: null,
      });
      return result.changed;
    } catch (e) {
      console.warn("Could not sync", e);
      this.publishSync({ error: e instanceof Error ? e.message : String(e) });
      // Whatever was merged before the failure still needs saving and showing.
      this.persist();
      return false;
    }
  }

  setTheme(theme: Theme) {
    this.pinger.setTheme(theme);
    this.persist();
    this.publish({ theme });
  }

  setNotificationsMuted(muted: boolean) {
    this.pinger.setNotificationsMuted(muted);
    this.persist();
    this.publish({ notificationsMuted: muted });
  }

  async saveToken(token: string, sync = false) {
    const trimmed = token.trim();
    if (!trimmed) throw new Error("Token is empty");
    this.deps.storage.set(TOKEN_KEY, trimmed);
    this.token = trimmed;
    this.github = this.deps.createGithub(trimmed);
    this.failures = 0;
    if (sync) {
      this.pinger.setSyncEnabled(true);
      this.persist();
    }
    this.publish({ hasSavedToken: true });
    // Another token may have other scopes.
    this.publishSync({ enabled: this.pinger.syncEnabled(), available: null, error: null });
    await this.poll();
  }

  /** Forgets the token and what was loaded with it. */
  clearToken() {
    this.deps.storage.remove(TOKEN_KEY);
    this.token = null;
    this.github = null;
    this.lastFetched = null;
    this.ownIds = new Set();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    this.publishSync({ available: null, error: null });
    this.publish({
      hasSavedToken: false,
      viewer: null,
      fetchedAt: null,
      pullRequests: [],
      reviewRequests: [],
      status: { kind: "error", problem: { code: "noToken" } },
    });
  }
}

export type { RawPullRequest };
