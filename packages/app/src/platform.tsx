import { createContext, useContext, type ReactNode } from "react";
import type { Snapshot, TokenSource } from "./types";

/**
 * What the UI needs from whatever hosts it: the desktop app talks to its Rust
 * shell, the web app to the PR logic running in the browser.
 */
export interface Platform {
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
