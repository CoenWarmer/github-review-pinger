// The web app's counterpart of the desktop poller: it owns the snapshot the UI
// shows, polls GitHub, refreshes what you visited, looks up team members, and
// keeps what the Rust logic must remember in browser storage. Browser APIs are
// passed in, so it runs under Node for tests.

import type {
  Problem,
  PullRequest,
  ReviewRequest,
  Snapshot,
  TeamChannel,
} from "@review-pinger/app";
import { FetchError, type Found, type Github, type Needs, type RawPullRequest } from "./github.ts";

const TOKEN_KEY = "reviewPinger.token";
const STATE_KEY = "reviewPinger.state";

const POLL_INTERVAL_MS = 120_000;
const MAX_BACKOFF_MS = 600_000;

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
  setTeamChannel(team: string, link: string): void;
  removeTeamChannel(team: string): void;
  setNotificationsMuted(muted: boolean): void;
  notificationsMuted(): boolean;
}

export interface EngineDeps {
  storage: KeyValue;
  /** Restores the Rust state from what `state()` returned on an earlier visit. */
  loadPinger(saved: string | null): Promise<PingerLike>;
  createGithub(token: string): Github;
  now?: () => Date;
  /** Local time east of UTC, in minutes. */
  tzOffsetMinutes?: () => number;
}

interface Update {
  pullRequests: PullRequest[];
  reviewRequests: ReviewRequest[];
  teamChannels: Record<string, TeamChannel>;
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
  /** Ids of the viewer's own PRs, which are the only ones that need a merge state. */
  private ownIds = new Set<string>();
  private polling: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private visible = true;
  private started = false;
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
      teamLookupDenied: false,
      fetchedAt: null,
      ssoPartial: false,
      pullRequests: [],
      reviewRequests: [],
      teamChannels: {},
      slackOpensIn: "app",
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

  private persist() {
    this.deps.storage.set(STATE_KEY, this.pinger.state());
  }

  private applyUpdate(update: Update) {
    this.publish({
      pullRequests: update.pullRequests,
      reviewRequests: update.reviewRequests,
      teamChannels: update.teamChannels,
      teamLookupDenied: this.pinger.directoryDenied(),
    });
  }

  /** Shows the lists again from the last fetch, after something changed. */
  private rederive() {
    const raw = this.pinger.derived(this.nowIso());
    if (raw) this.applyUpdate(JSON.parse(raw));
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
      await github.addMergeStates(fresh.filter((pr) => this.ownIds.has(pr.id)));
      this.pinger.applyRefresh(JSON.stringify(fresh));
      this.rederive();
      this.persist();
    } catch (e) {
      // Only the full refresh reports problems.
      console.warn("Could not refresh visited pull requests", e);
    }
  }

  /** Stops polling. */
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
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
      const fetched = await github.fetchOpenPullRequests(this.pinger.reviewedSince(now));
      this.ownIds = new Set(fetched.pullRequests.map((pr) => pr.id));
      const tz = this.deps.tzOffsetMinutes?.() ?? -new Date().getTimezoneOffset();
      const update: Update = JSON.parse(this.pinger.poll(JSON.stringify(fetched), now, tz));
      this.failures = 0;
      this.persist();
      this.publish({
        refreshing: false,
        status: { kind: "ok" },
        viewer: fetched.viewer,
        fetchedAt: now,
        ssoPartial: fetched.ssoPartial,
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
  }

  setTeamChannel(team: string, link: string) {
    this.pinger.setTeamChannel(team, link);
    this.persist();
    this.rederive();
  }

  removeTeamChannel(team: string) {
    this.pinger.removeTeamChannel(team);
    this.persist();
    this.rederive();
  }

  setNotificationsMuted(muted: boolean) {
    this.pinger.setNotificationsMuted(muted);
    this.persist();
    this.publish({ notificationsMuted: muted });
  }

  async saveToken(token: string) {
    const trimmed = token.trim();
    if (!trimmed) throw new Error("Token is empty");
    this.deps.storage.set(TOKEN_KEY, trimmed);
    this.token = trimmed;
    this.github = this.deps.createGithub(trimmed);
    this.failures = 0;
    this.publish({ hasSavedToken: true });
    await this.poll();
  }

  /** Forgets the token and what was loaded with it. */
  clearToken() {
    this.deps.storage.remove(TOKEN_KEY);
    this.token = null;
    this.github = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
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
