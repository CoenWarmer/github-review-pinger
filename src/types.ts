// Mirrors the serialized types in src-tauri/src/poller.rs and src-tauri/src/prs.rs.

export type TokenSource = "pat" | "gh";

export type Action = "changesRequested" | "conflicts" | "ciFailing" | "readyToMerge";

export type Group = "needsAction" | "waiting" | "dormant" | "draft";

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
}
