import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Snapshot } from "@review-pinger/app";
import {
  clearSavedLists,
  listsOf,
  loadSavedLists,
  onSavedListsCleared,
  saveLists,
  withSavedLists,
  type SavedLists,
} from "../../../packages/app/src/cache.ts";

const row = (id: string) => ({ id }) as never;

function fakeStore() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

const saved: SavedLists = {
  fetchedAt: "2026-10-01T09:00:00.000Z",
  viewer: "me",
  pullRequests: [row("old-mine")],
  reviewRequests: [row("old-review")],
  viewPullRequests: { v1: [row("old-view")] },
  mergedPullRequests: [row("old-merged")],
  teamChannels: { "o/core": { link: "https://slack.example/c", source: "saved" } },
  slackOpensIn: "browser",
};

/** What the host shows right after a start, before any fetch has landed. */
function starting(over: Partial<Snapshot> = {}): Snapshot {
  return {
    status: { kind: "loading" },
    refreshing: false,
    refreshingIds: [],
    partial: false,
    viewer: null,
    fetchedAt: null,
    pullRequests: [],
    reviewRequests: [],
    viewPullRequests: {},
    mergedPullRequests: [],
    mergedCanLoadMore: false,
    teamChannels: {},
    slackOpensIn: "app",
    theme: "dark",
    myPrsSections: [{ kind: "builtin", section: "approved", enabled: true }],
    ...over,
  } as Snapshot;
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("showing the saved lists", () => {
  it("stands in for the lists until the first fetch has something, and keeps the host's settings", () => {
    const shown = withSavedLists(starting(), saved);
    assert.equal(shown.stale, true);
    assert.deepEqual(ids(shown.pullRequests), ["old-mine"]);
    assert.deepEqual(ids(shown.reviewRequests), ["old-review"]);
    assert.deepEqual(ids(shown.viewPullRequests.v1), ["old-view"]);
    assert.deepEqual(ids(shown.mergedPullRequests), ["old-merged"]);
    assert.equal(shown.fetchedAt, saved.fetchedAt);
    assert.equal(shown.viewer, "me");
    // Everything but the lists is the host's.
    assert.equal(shown.theme, "dark");
    assert.equal(shown.myPrsSections.length, 1);
  });

  it("does nothing without saved lists", () => {
    const host = starting();
    assert.equal(withSavedLists(host, null), host);
  });

  it("still shows them when the first fetch fails for lack of a network", () => {
    const host = starting({ status: { kind: "error", problem: { code: "network", message: "offline" } } });
    const shown = withSavedLists(host, saved);
    assert.equal(shown.stale, true);
    assert.equal(shown.status.kind, "error");
    assert.deepEqual(ids(shown.pullRequests), ["old-mine"]);
  });

  it("leaves the setup screen to problems the user has to fix", () => {
    for (const code of ["ghNotInstalled", "ghNotLoggedIn", "noSavedToken", "noToken"] as const) {
      const host = starting({ status: { kind: "error", problem: { code } } });
      assert.equal(withSavedLists(host, saved), host, code);
    }
    const rejected = starting({
      status: { kind: "error", problem: { code: "tokenRejected", source: "pat" } },
    });
    assert.equal(withSavedLists(rejected, saved), rejected);
  });

  it("keeps the other tabs' saved lists while only My PRs has arrived", () => {
    const host = starting({
      status: { kind: "ok" },
      partial: true,
      fetchedAt: "2026-10-02T09:00:00.000Z",
      pullRequests: [row("fresh-mine")],
    });
    const shown = withSavedLists(host, saved);
    assert.deepEqual(ids(shown.pullRequests), ["fresh-mine"]);
    assert.deepEqual(ids(shown.reviewRequests), ["old-review"]);
    assert.notEqual(shown.stale, true);
    assert.equal(shown.fetchedAt, "2026-10-02T09:00:00.000Z");
  });

  it("shows a complete fetch as it is", () => {
    const host = starting({
      status: { kind: "ok" },
      fetchedAt: "2026-10-02T09:00:00.000Z",
      pullRequests: [row("fresh-mine")],
      reviewRequests: [],
    });
    assert.equal(withSavedLists(host, saved), host);
  });
});

describe("what gets saved", () => {
  it("is only a complete, successful fetch", () => {
    const complete = starting({
      status: { kind: "ok" },
      fetchedAt: "2026-10-02T09:00:00.000Z",
      viewer: "me",
      pullRequests: [row("a")],
    });
    assert.deepEqual(ids(listsOf(complete)!.pullRequests), ["a"]);
    assert.equal(listsOf({ ...complete, partial: true }), null);
    assert.equal(listsOf({ ...complete, status: { kind: "loading" } }), null);
    assert.equal(listsOf({ ...complete, fetchedAt: null }), null);
  });

  it("reads back what was saved", () => {
    const store = fakeStore();
    saveLists(saved, store);
    assert.deepEqual(loadSavedLists(store), saved);
  });

  it("drops anything unreadable", () => {
    const store = fakeStore();
    assert.equal(loadSavedLists(store), null);
    store.data.set("reviewPinger.lists.v1", "not json");
    assert.equal(loadSavedLists(store), null);
    store.data.set("reviewPinger.lists.v1", JSON.stringify({ fetchedAt: "x", pullRequests: 3 }));
    assert.equal(loadSavedLists(store), null);
  });

  it("copes with storage that fails", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    assert.equal(loadSavedLists(broken), null);
    saveLists(saved, broken);
    clearSavedLists(broken);
  });

  it("forgets everything when the account changes, including a fetch still in flight", () => {
    const store = fakeStore();
    saveLists(saved, store);
    let told = 0;
    const stop = onSavedListsCleared(() => told++);

    clearSavedLists(store);
    assert.equal(loadSavedLists(store), null);
    assert.equal(told, 1);

    // A fetch that began before the change belongs to the old account.
    saveLists(saved, store);
    assert.equal(loadSavedLists(store), null);

    // One that began after it is the new account's.
    saveLists({ ...saved, fetchedAt: new Date(Date.now() + 1000).toISOString() }, store);
    assert.notEqual(loadSavedLists(store), null);
    stop();
  });
});
