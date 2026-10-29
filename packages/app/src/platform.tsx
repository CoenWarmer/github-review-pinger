import { createContext, useContext, type ReactNode } from "react";
import type {
  CiStats,
  FoundPr,
  ReviewStatsData,
  SectionPref,
  Snapshot,
  StatsData,
  Theme,
  TokenSource,
} from "./types";

/**
 * What the UI needs from whatever hosts it: the desktop app talks to its Rust
 * shell, the web app to the PR logic running in the browser.
 */
export interface Platform {
  /** The app's version, to show in Settings. */
  version: string;

  /** What this host can do, so the UI leaves out controls that wouldn't work. */
  features: {
    /** The token can come from the GitHub CLI as well as a pasted one. */
    githubCli: boolean;
    /** The app can be set to start at login. */
    autostart: boolean;
    /** Notification cards can be shown, muted, and tried out. */
    notifications: boolean;
    /** A sound can be played for events, such as one of your PRs merging. */
    sound: boolean;
    /** CI build statistics can be loaded, through the Buildkite CLI. */
    buildkite: boolean;
  };

  getSnapshot(): Promise<Snapshot>;
  /** Calls `callback` with every new snapshot. Returns how to stop listening. */
  onSnapshot(callback: (snapshot: Snapshot) => void): () => void;
  refresh(): void;

  /** Opens a pull request, comment or review, and has the PR refreshed first next time. */
  visit(id: string, url: string): void;
  /** Opens a link outside the app. */
  openUrl(url: string): void;
  snooze(id: string, days: number): void;
  unsnooze(id: string): void;

  /** Rejects with a message to show when the link isn't a Slack link. */
  setTeamChannel(team: string, link: string): Promise<void>;
  removeTeamChannel(team: string): void;

  /** Saves the order and visibility of "My PRs" sections. */
  setMyPrsSections(sections: SectionPref[]): void;
  /** Fetches further merged PRs, older than what's already shown. */
  loadMoreMerged(): Promise<void>;

  /**
   * Searches GitHub for PRs, in any state, matching the text (which may hold
   * search qualifiers). Rejects with a message to show.
   */
  searchPullRequests(text: string): Promise<FoundPr[]>;

  /** The teams you belong to (`org/slug`). Rejects with a message to show. */
  listTeams(): Promise<string[]>;
  /**
   * Your merged PRs over the last `days`, and a team's (`org/slug`) when one
   * is given. Rejects with a message to show.
   */
  loadStats(team: string | null, days: number, previous?: boolean): Promise<StatsData>;
  /**
   * The reviews submitted over the last `days`: yours, and each member's of
   * a team (`org/slug`) when one is given and it's small enough. Rejects with
   * a message to show.
   */
  loadReviewStats(team: string | null, days: number, previous?: boolean): Promise<ReviewStatsData>;

  /**
   * Builds you created in the last `days` (or with `previous` in the same
   * number of days before), counted and timed by the Buildkite CLI. Only where
   * `features.buildkite`. Always answers: no CLI or login is part of it.
   */
  loadCiStats(days: number, previous?: boolean): Promise<CiStats>;
  /**
   * Chooses the Buildkite pipeline the CI statistics count builds in. It's
   * saved and synced with your other devices. Rejects with a message to show
   * when what was typed isn't a pipeline name.
   */
  setBuildkitePipeline(name: string): Promise<void>;
  /** Sorts a section (`mine:approved`), or `default` to put it back. Saved and synced. */
  setSectionSort(id: string, key: string): void;

  /** Adds a custom view and shows it right away. */
  addView(name: string, query: string): void;
  updateView(id: string, name: string, query: string): void;
  removeView(id: string): void;

  /**
   * Rejects with a message to show when the token can't be saved. `sync`
   * turns on syncing with it.
   */
  saveToken(token: string, sync: boolean): Promise<void>;
  /** Whether a token that isn't saved yet could sync, which needs the gist scope. */
  canSync(token: string): Promise<boolean>;
  /** Shares snoozes and Slack channels with other devices, or stops. */
  setSync(enabled: boolean): void;
  clearToken(): Promise<void>;
  setAuthSource(source: TokenSource): void;

  getAutostart(): Promise<boolean>;
  setAutostart(enabled: boolean): Promise<void>;
  /** Saves the appearance on this device. */
  setTheme(theme: Theme): void;
  setNotificationsMuted(muted: boolean): void;
  sendTestNotification(): void;
  setSoundOnMerge(enabled: boolean): void;
}

const PlatformContext = createContext<Platform | null>(null);

export function PlatformProvider({
  platform,
  children,
}: {
  platform: Platform;
  children: ReactNode;
}) {
  return <PlatformContext.Provider value={platform}>{children}</PlatformContext.Provider>;
}

export function usePlatform(): Platform {
  const platform = useContext(PlatformContext);
  if (!platform) throw new Error("usePlatform needs a PlatformProvider above it");
  return platform;
}
