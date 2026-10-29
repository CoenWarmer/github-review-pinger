// The last complete lists, kept in the browser's (or webview's) storage so the
// next start shows them at once while the real fetch runs. Only the lists:
// everything else in a snapshot (settings, sections, views, theme) the host
// knows fresh on start, and stays the authority.

import type {
  MergedPr,
  PullRequest,
  ReviewRequest,
  Snapshot,
  TeamChannel,
} from "./types";

const KEY = "reviewPinger.lists.v1";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface SavedLists {
  fetchedAt: string;
  viewer: string | null;
  pullRequests: PullRequest[];
  reviewRequests: ReviewRequest[];
  viewPullRequests: Record<string, PullRequest[]>;
  mergedPullRequests: MergedPr[];
  teamChannels: Record<string, TeamChannel>;
  slackOpensIn: Snapshot["slackOpensIn"];
}

/** Problems that need the user to act, so the setup screen has to show. */
const NEEDS_SETUP = new Set([
  "ghNotInstalled",
  "ghNotLoggedIn",
  "noSavedToken",
  "noToken",
  "tokenRejected",
]);

/**
 * Lists fetched before this time belong to whoever was signed in before an
 * account change, so they're never saved.
 */
let clearedAt = 0;
const clearedListeners = new Set<() => void>();

function defaultStore(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Storage can be unavailable (private windows, blocked site data).
    return null;
  }
}

/** The lists of a complete, successful fetch; `null` for anything less. */
export function listsOf(snapshot: Snapshot): SavedLists | null {
  if (snapshot.status.kind !== "ok" || snapshot.partial || !snapshot.fetchedAt) return null;
  return {
    fetchedAt: snapshot.fetchedAt,
    viewer: snapshot.viewer,
    pullRequests: snapshot.pullRequests,
    reviewRequests: snapshot.reviewRequests,
    viewPullRequests: snapshot.viewPullRequests,
    mergedPullRequests: snapshot.mergedPullRequests,
    teamChannels: snapshot.teamChannels,
    slackOpensIn: snapshot.slackOpensIn,
  };
}

/**
 * What to show for the host's snapshot, given the lists saved earlier.
 *
 * - Before the first fetch has anything (not even a partial one), the saved
 *   lists stand in, marked `stale`. That includes a failed first fetch such
 *   as being offline, but not a problem the setup screen is for.
 * - While only My PRs has arrived, the other tabs keep their saved lists
 *   rather than looking empty.
 * - Otherwise the host's own snapshot is shown as it is.
 */
export function withSavedLists(host: Snapshot, saved: SavedLists | null): Snapshot {
  if (!saved) return host;
  const channels = Object.keys(host.teamChannels).length > 0 ? host.teamChannels : saved.teamChannels;

  if (host.fetchedAt === null) {
    if (host.status.kind === "error" && NEEDS_SETUP.has(host.status.problem.code)) return host;
    return {
      ...host,
      stale: true,
      viewer: host.viewer ?? saved.viewer,
      fetchedAt: saved.fetchedAt,
      pullRequests: saved.pullRequests,
      reviewRequests: saved.reviewRequests,
      viewPullRequests: saved.viewPullRequests,
      mergedPullRequests: saved.mergedPullRequests,
      teamChannels: channels,
      slackOpensIn: saved.slackOpensIn,
    };
  }
  if (host.partial) {
    return {
      ...host,
      reviewRequests: saved.reviewRequests,
      viewPullRequests: saved.viewPullRequests,
      mergedPullRequests: saved.mergedPullRequests,
      teamChannels: channels,
    };
  }
  return host;
}

export function loadSavedLists(store: Store | null = defaultStore()): SavedLists | null {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedLists>;
    // Anything unexpected is dropped rather than shown.
    if (
      typeof parsed.fetchedAt !== "string" ||
      !Array.isArray(parsed.pullRequests) ||
      !Array.isArray(parsed.reviewRequests) ||
      !Array.isArray(parsed.mergedPullRequests) ||
      typeof parsed.viewPullRequests !== "object" ||
      parsed.viewPullRequests === null
    ) {
      return null;
    }
    return {
      fetchedAt: parsed.fetchedAt,
      viewer: parsed.viewer ?? null,
      pullRequests: parsed.pullRequests,
      reviewRequests: parsed.reviewRequests,
      viewPullRequests: parsed.viewPullRequests,
      mergedPullRequests: parsed.mergedPullRequests,
      teamChannels: parsed.teamChannels ?? {},
      slackOpensIn: parsed.slackOpensIn ?? "app",
    };
  } catch {
    return null;
  }
}

/** Keeps `lists` for the next start, unless they predate an account change. */
export function saveLists(lists: SavedLists, store: Store | null = defaultStore()) {
  if (Date.parse(lists.fetchedAt) < clearedAt) return;
  try {
    store?.setItem(KEY, JSON.stringify(lists));
  } catch {
    // Over quota or unavailable: the next start just shows the loading screen.
  }
}

/** Forgets the saved lists, for when the account changes. */
export function clearSavedLists(store: Store | null = defaultStore()) {
  clearedAt = Date.now();
  try {
    store?.removeItem(KEY);
  } catch {
    // Nothing more to do.
  }
  for (const listener of clearedListeners) listener();
}

/** Calls `listener` whenever the saved lists are cleared. Returns how to stop. */
export function onSavedListsCleared(listener: () => void): () => void {
  clearedListeners.add(listener);
  return () => {
    clearedListeners.delete(listener);
  };
}
