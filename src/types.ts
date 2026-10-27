// Mirrors the serialized types in src-tauri/src/poller.rs and src-tauri/src/prs.rs.

export type TokenSource = "pat" | "gh";

export type Action =
  | "readyToMerge"
  | "changesRequested"
  | "newFeedback"
  | "conflicts"
  | "ciFailing";

export type Group = "approved" | "needsAction" | "waiting" | "snoozed" | "dormant" | "draft";

export type ReviewGroup = "needsReview" | "waitingOnAuthor" | "snoozed" | "draft";

export type ReviewerState = "changesRequested" | "approved" | "commented" | "pending";

export interface Reviewer {
  login: string;
  kind: "user" | "team" | "bot";
  state: ReviewerState;
  rerequested: boolean;
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
  | { code: "tokenRejected"; source: TokenSource }
  | { code: "rateLimited"; resetAt: string | null }
  | { code: "network"; message: string }
  | { code: "api"; message: string };

export type Status = { kind: "loading" } | { kind: "ok" } | { kind: "error"; problem: Problem };

export interface Snapshot {
  status: Status;
  refreshing: boolean;
  viewer: string | null;
  tokenSource: TokenSource | null;
  fetchedAt: string | null;
  ssoPartial: boolean;
  pullRequests: PullRequest[];
  reviewRequests: ReviewRequest[];
}
