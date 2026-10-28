// Runs the engine against the real WebAssembly and a fake GitHub.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { initSync, Pinger } from "../../../packages/wasm/pkg/review_pinger_wasm.js";
import { Engine, type KeyValue } from "./engine.ts";
import {
  FetchError,
  type Fetched,
  type Found,
  type Github,
  type RawPullRequest,
} from "./github.ts";

initSync({
  module: readFileSync(
    new URL("../../../packages/wasm/pkg/review_pinger_wasm_bg.wasm", import.meta.url),
  ),
});

const NOW = "2026-10-02T10:00:00Z";

function pr(id: string, extra: Record<string, unknown> = {}): RawPullRequest {
  return {
    id,
    number: 1,
    title: "Fix it",
    url: "https://github.com/o/r/pull/1",
    isDraft: false,
    createdAt: "2026-10-01T09:00:00Z",
    reviewDecision: null,
    mergeable: "MERGEABLE",
    autoMergeRequest: null,
    repository: { nameWithOwner: "o/r" },
    commits: { nodes: [] },
    timelineItems: { nodes: [] },
    ...extra,
  };
}

function memory(initial: Record<string, string> = {}): KeyValue & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: (key) => data.get(key) ?? null,
    set: (key, value) => void data.set(key, value),
    remove: (key) => void data.delete(key),
  };
}

class FakeGithub implements Github {
  fetched: Fetched = {
    viewer: "me",
    pullRequests: [pr("mine")],
    reviewPullRequests: [],
    ssoPartial: false,
  };
  failure: Error | null = null;
  found: Found = { teams: {}, denied: false };
  polls = 0;
  detailCalls: string[][] = [];
  details: RawPullRequest[] = [];
  directoryCalls = 0;

  async fetchOpenPullRequests() {
    this.polls++;
    if (this.failure) throw this.failure;
    return structuredClone(this.fetched);
  }
  async fetchDetails(ids: string[]) {
    this.detailCalls.push(ids);
    return structuredClone(this.details);
  }
  async addMergeStates() {}
  async fetchDirectory() {
    this.directoryCalls++;
    return this.found;
  }
}

const engines: Engine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
});

function makeEngine(
  options: { storage?: KeyValue & { data: Map<string, string> }; github?: FakeGithub } = {},
) {
  const storage = options.storage ?? memory({ "reviewPinger.token": "ghp_x" });
  const github = options.github ?? new FakeGithub();
  const engine = new Engine({
    storage,
    loadPinger: async (saved) => new Pinger(saved ?? undefined),
    createGithub: () => github,
    now: () => new Date(NOW),
    tzOffsetMinutes: () => 0,
  });
  engines.push(engine);
  return { engine, github, storage };
}

describe("the web engine", () => {
  it("asks for a token before it has one, without fetching", async () => {
    const { engine, github } = makeEngine({ storage: memory() });
    await engine.start();
    assert.deepEqual(engine.getSnapshot().status, { kind: "error", problem: { code: "noToken" } });
    assert.equal(engine.getSnapshot().hasSavedToken, false);
    assert.equal(github.polls, 0);
  });

  it("loads the lists on start and keeps its state for the next visit", async () => {
    const { engine, storage } = makeEngine();
    await engine.start();

    const snapshot = engine.getSnapshot();
    assert.deepEqual(snapshot.status, { kind: "ok" });
    assert.equal(snapshot.viewer, "me");
    assert.equal(Date.parse(snapshot.fetchedAt!), Date.parse(NOW));
    assert.equal(snapshot.pullRequests.length, 1);
    assert.equal(snapshot.hasSavedToken, true);
    assert.ok(JSON.parse(storage.data.get("reviewPinger.state")!).memory.pullRequests.mine);
  });

  it("keeps showing the last data when a refresh fails, and says why", async () => {
    const { engine, github } = makeEngine();
    await engine.start();
    github.failure = new FetchError("unauthorized", "no");
    await engine.refresh();

    const snapshot = engine.getSnapshot();
    assert.deepEqual(snapshot.status, {
      kind: "error",
      problem: { code: "tokenRejected", source: "pat" },
    });
    assert.equal(snapshot.pullRequests.length, 1);
    assert.equal(snapshot.refreshing, false);

    github.failure = new FetchError("rateLimited", "slow", "2026-10-02T10:05:00.000Z");
    await engine.refresh();
    assert.deepEqual(engine.getSnapshot().status, {
      kind: "error",
      problem: { code: "rateLimited", resetAt: "2026-10-02T10:05:00.000Z" },
    });
  });

  it("snoozes without fetching, and remembers it", async () => {
    const { engine, github, storage } = makeEngine();
    await engine.start();
    engine.snooze("mine", 3);

    assert.equal(engine.getSnapshot().pullRequests[0].group, "snoozed");
    assert.equal(github.polls, 1);

    // A new visit still sees the snooze.
    const next = makeEngine({ storage }).engine;
    await next.start();
    assert.equal(next.getSnapshot().pullRequests[0].group, "snoozed");

    engine.snooze("mine", undefined);
    assert.notEqual(engine.getSnapshot().pullRequests[0].group, "snoozed");
  });

  it("looks up team members once and flags a refused lookup", async () => {
    const team = { __typename: "Team", slug: "core", combinedSlug: "o/core" };
    const github = new FakeGithub();
    github.fetched.pullRequests = [
      pr("mine", { reviewRequests: { nodes: [{ requestedReviewer: team }] } }),
    ];
    github.found = { teams: {}, denied: true };
    const { engine } = makeEngine({ github });
    await engine.start();

    assert.equal(github.directoryCalls, 1);
    assert.equal(engine.getSnapshot().teamLookupDenied, true);

    // Refused lookups aren't repeated straight away.
    await engine.refresh();
    assert.equal(github.directoryCalls, 1);
  });

  it("refreshes the PRs you opened when the page is shown again", async () => {
    const { engine, github } = makeEngine();
    await engine.start();
    engine.markVisited("mine");
    github.details = [pr("mine", { title: "Renamed" })];
    github.fetched.pullRequests = [pr("mine", { title: "Renamed" })];
    engine.setVisible(true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(github.detailCalls, [["mine"]]);
    assert.equal(engine.getSnapshot().pullRequests[0].title, "Renamed");
    // Then the whole list, however fresh it is.
    assert.equal(github.polls, 2);
  });

  it("saves a token and fetches with it, and forgets it again", async () => {
    const { engine, github, storage } = makeEngine({ storage: memory() });
    await engine.start();
    await assert.rejects(engine.saveToken("  "), /Token is empty/);

    await engine.saveToken(" ghp_new ");
    assert.equal(storage.data.get("reviewPinger.token"), "ghp_new");
    assert.equal(github.polls, 1);
    assert.equal(engine.getSnapshot().pullRequests.length, 1);

    engine.clearToken();
    assert.equal(storage.data.has("reviewPinger.token"), false);
    assert.deepEqual(engine.getSnapshot().pullRequests, []);
    assert.deepEqual(engine.getSnapshot().status, { kind: "error", problem: { code: "noToken" } });
  });

  it("saves Slack channels and rejects other links", async () => {
    const { engine } = makeEngine();
    await engine.start();
    assert.throws(
      () => engine.setTeamChannel("o/core", "https://example.com"),
      /Slack channel link/,
    );
    engine.setTeamChannel("O/Core", "https://app.slack.com/client/T1/C1");
    assert.equal(engine.getSnapshot().teamChannels["o/core"].source, "saved");
    engine.removeTeamChannel("o/core");
    assert.deepEqual(engine.getSnapshot().teamChannels, {});
  });

  it("tells listeners about every change", async () => {
    const { engine } = makeEngine();
    const seen: string[] = [];
    engine.subscribe((snapshot) =>
      seen.push(snapshot.status.kind + (snapshot.refreshing ? "+refreshing" : "")),
    );
    await engine.start();
    assert.deepEqual(seen.slice(0, 2), ["loading", "loading+refreshing"]);
    assert.equal(seen.at(-1), "ok");
  });
});
