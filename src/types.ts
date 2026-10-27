// Mirrors the serialized types in src-tauri/src/poller.rs and src-tauri/src/prs.rs.

export type TokenSource = "pat" | "gh";

export type Action =
  "readyToMerge" | "changesRequested" | "newFeedback" | "conflicts" | "ciFailing";

export type Group = "approved" | "needsAction" | "waiting" | "snoozed" | "dormant" | "draft";

export type ReviewGroup = "needsReview" | "waitingOnAuthor" | "snoozed" | "draft";

export type ReviewerState = "changesRequested" | "approved" | "commented" | "pending";

export interface Reviewer {
  login: string;
  kind: "user" | "team" | "bot";
  state: ReviewerState;
  rerequested: boolean;
  /** For team requests, the lowercase `org/slug` Slack channels are keyed by. */
  team: string | null;
}

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  repo: string;
  group: Group;
  actions: Action[];
  openSince: string;
  quietSince: string;
  lastActivity: string;
  snoozedUntil: string | null;
  approved: boolean;
  checks: "passing" | "pending" | "failing" | "none";
  /** When the running checks started; only while they're running. */
  checksStarted: string | null;
  /** How long checks usually take in this repo, if known. */
  checksEstimateSecs: number | null;
  autoMerge: boolean;
  queued: boolean;
  mergeQueuePosition: number | null;
  mergeEta: string | null;
  /** When it entered the merge queue. */
  mergeEnqueuedAt: string | null;
  reviewers: Reviewer[];
}

export interface ReviewRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string;
  group: ReviewGroup;
  openSince: string;
  /** When it became your turn; only for requested PRs. */
  waitingSince: string | null;
  rerequested: boolean;
  myState: ReviewerState | null;
  reviewedAt: string | null;
  lastActivity: string;
  snoozedUntil: string | null;
  reviewers: Reviewer[];
}

export type Problem =
  | { code: "ghNotInstalled" }
  | { code: "ghNotLoggedIn" }
  | { code: "noSavedToken" }
  | { code: "tokenRejected"; source: TokenSource }
  | { code: "rateLimited"; resetAt: string | null }
  | { code: "network"; message: string }
  | { code: "api"; message: string };

export type Status = { kind: "loading" } | { kind: "ok" } | { kind: "error"; problem: Problem };

/** A notification card on screen. */
export interface CardNotification {
  /** Numbers the card, so dismissing one can't dismiss its successor. */
  seq: number;
  accent: "danger" | "info" | "warning" | "success";
  label: string;
  /** The PR title, or the summary text of a summary card. */
  title: string;
  meta: string | null;
  detail: string | null;
  prId: string | null;
  url: string | null;
}

export interface TeamChannel {
  link: string;
  /** Pasted into the popover, or configured in settings.json. */
  source: "saved" | "settings";
}

export interface Snapshot {
  status: Status;
  refreshing: boolean;
  viewer: string | null;
  tokenSource: TokenSource | null;
  /** The source the user picked; null until they do. */
  authChoice: TokenSource | null;
  /** A token is in the keychain, used or not. */
  hasSavedToken: boolean;
  /** Notification cards are muted. */
  notificationsMuted: boolean;
  fetchedAt: string | null;
  ssoPartial: boolean;
  pullRequests: PullRequest[];
  reviewRequests: ReviewRequest[];
  /** Slack channels by lowercase `org/team-slug`. */
  teamChannels: Record<string, TeamChannel>;
  slackOpensIn: "app" | "browser";
}
