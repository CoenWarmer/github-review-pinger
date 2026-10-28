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
  type RawMergedPullRequest,
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

/** A GitHub account's gists, which every device signed in to it shares. */
class FakeGists {
  gist: { id: string; files: Record<string, { content: string }> } | null = null;
  calls: string[] = [];
}

class FakeGithub implements Github {
  scopeHeader: string | null = "repo, read:org, gist";
  gists_ = new FakeGists();
  fetched: Fetched = {
    viewer: "me",
    pullRequests: [pr("mine")],
    reviewPullRequests: [],
    viewPullRequests: {},
    ssoPartial: false,
  };
  failure: Error | null = null;
  found: Found = { teams: {}, denied: false };
  polls = 0;
  detailCalls: string[][] = [];
  details: RawPullRequest[] = [];
  directoryCalls = 0;

  includeAuthoredCalls: boolean[] = [];
  mergedPages: { items: RawMergedPullRequest[]; hasNextPage: boolean; endCursor: string | null }[] = [
    { items: [], hasNextPage: false, endCursor: null },
  ];
  mergedCalls: (string | null)[] = [];

  viewCalls: [string, string][][] = [];

  async fetchOpenPullRequests(
    _reviewedSince: string,
    includeAuthored: boolean,
    views: [string, string][],
  ) {
    this.polls++;
    this.includeAuthoredCalls.push(includeAuthored);
    this.viewCalls.push(views);
    if (this.failure) throw this.failure;
    return structuredClone(this.fetched);
  }
  async fetchMergedPage(cursor: string | null) {
    this.mergedCalls.push(cursor);
    return this.mergedPages[this.mergedCalls.length - 1] ?? this.mergedPages.at(-1)!;
  }
  async fetchDetails(ids: string[]) {
    this.detailCalls.push(ids);
    return structuredClone(this.details);
  }
  async searchPullRequests() {
    return [];
  }
  async addMergeStates() {}
  async fetchDirectory() {
    this.directoryCalls++;
    return this.found;
  }

  async scopes() {
    return this.scopeHeader;
  }
  async gists() {
    this.gists_.calls.push("list");
    const gist = this.gists_.gist;
    return JSON.stringify(gist ? [{ id: gist.id, files: { [Object.keys(gist.files)[0]]: {} } }] : []);
  }
  async gist(id: string) {
    this.gists_.calls.push("read");
    const gist = this.gists_.gist;
    return gist && gist.id === id ? JSON.stringify(gist) : null;
  }
  async createGist(body: string) {
    this.gists_.calls.push("create");
    const created = JSON.parse(body);
    assert.equal(created.public, false, "the gist must be secret");
    this.gists_.gist = { id: "g1", files: created.files };
    return "g1";
  }
  async updateGist(_id: string, body: string) {
    this.gists_.calls.push("update");
    this.gists_.gist = { ...this.gists_.gist!, files: JSON.parse(body).files };
  }
}

const engines: Engine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
});

function makeEngine(
  options: {
    storage?: KeyValue & { data: Map<string, string> };
    github?: FakeGithub;
    now?: () => Date;
  } = {},
) {
  const storage = options.storage ?? memory({ "reviewPinger.token": "ghp_x" });
  const github = options.github ?? new FakeGithub();
  const engine = new Engine({
    storage,
    loadPinger: async (saved) => new Pinger(saved ?? undefined),
    createGithub: () => github,
    now: options.now ?? (() => new Date(NOW)),
    tzOffsetMinutes: () => 0,
    syncDelayMs: 0,
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

  it("follows the system theme until one is chosen, then remembers it", async () => {
    const { engine, storage } = makeEngine();
    await engine.start();
    assert.equal(engine.getSnapshot().theme, "system");

    engine.setTheme("dark");
    assert.equal(engine.getSnapshot().theme, "dark");

    const { engine: next } = makeEngine({ storage });
    await next.start();
    assert.equal(next.getSnapshot().theme, "dark");
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

/** Lets the timers and promises of a sync finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("syncing snoozes and channels", () => {
  /** Two devices of one account, which share the gists. */
  function twoDevices() {
    // Later changes win, so time has to pass between them.
    const clock = { ms: Date.parse(NOW) };
    const now = () => new Date(clock.ms);
    const later = () => void (clock.ms += 60_000);
    const phone = makeEngine({ storage: memory({ "reviewPinger.token": "ghp_x" }), now });
    const laptop = makeEngine({ storage: memory({ "reviewPinger.token": "ghp_y" }), now });
    laptop.github.gists_ = phone.github.gists_;
    return { phone, laptop, later };
  }

  it("stays off, and away from gists, until it's turned on", async () => {
    const { engine, github } = makeEngine();
    await engine.start();
    engine.snooze("mine", 3);
    await settle();

    assert.equal(engine.getSnapshot().sync.enabled, false);
    assert.deepEqual(github.gists_.calls, []);
  });

  it("can be turned on once the token is known to have the gist scope", async () => {
    const { engine } = makeEngine();
    await engine.start();
    assert.equal(engine.getSnapshot().sync.available, true);

    engine.setSync(true);
    await settle();

    const { sync } = engine.getSnapshot();
    assert.equal(sync.enabled, true);
    assert.equal(sync.error, null);
    assert.equal(Date.parse(sync.lastSyncedAt!), Date.parse(NOW));
    assert.equal(sync.gistUrl, "https://gist.github.com/g1");
  });

  it("can't be turned on with a token that lacks the scope", async () => {
    const github = new FakeGithub();
    github.scopeHeader = "repo, read:org";
    const { engine } = makeEngine({ github });
    await engine.start();
    assert.equal(engine.getSnapshot().sync.available, false);

    engine.setSync(true);
    await settle();

    assert.equal(engine.getSnapshot().sync.enabled, false);
    assert.deepEqual(github.gists_.calls, []);
  });

  it("treats tokens without scopes, like fine-grained ones, as unable to sync", async () => {
    const github = new FakeGithub();
    github.scopeHeader = null;
    const { engine } = makeEngine({ github });
    await engine.start();
    assert.equal(engine.getSnapshot().sync.available, false);
    assert.equal(await engine.canSync("github_pat_x"), false);
  });

  it("tells the sign-in form whether a typed token could sync", async () => {
    const { engine, github } = makeEngine({ storage: memory() });
    await engine.start();
    assert.equal(await engine.canSync(" ghp_x "), true);
    github.scopeHeader = "repo";
    assert.equal(await engine.canSync("ghp_x"), false);
  });

  it("turns on with the token when the sign-in form asked for it", async () => {
    const { engine } = makeEngine({ storage: memory() });
    await engine.start();

    await engine.saveToken("ghp_x", true);
    await settle();

    assert.equal(engine.getSnapshot().sync.enabled, true);
    assert.ok(engine.getSnapshot().sync.lastSyncedAt);
  });

  it("brings a snooze from one device to another", async () => {
    const { phone, laptop } = twoDevices();
    await laptop.engine.start();
    laptop.engine.setSync(true);
    laptop.engine.snooze("mine", 3);
    await settle();
    assert.equal(laptop.github.gists_.gist?.id, "g1");

    // The phone starts later, with sync on, and has never seen the snooze.
    phone.storage.data.set(
      "reviewPinger.state",
      JSON.stringify({ memory: { sync: { enabled: true } }, directory: {} }),
    );
    await phone.engine.start();

    assert.equal(phone.engine.getSnapshot().pullRequests[0].group, "snoozed");
  });

  it("brings the end of a snooze to the other device on its next refresh", async () => {
    const { phone, laptop, later } = twoDevices();
    await laptop.engine.start();
    laptop.engine.setSync(true);
    laptop.engine.snooze("mine", 3);
    await settle();
    await phone.engine.start();
    phone.engine.setSync(true);
    await settle();
    await phone.engine.refresh();
    assert.equal(phone.engine.getSnapshot().pullRequests[0].group, "snoozed");

    later();
    laptop.engine.snooze("mine", undefined);
    await settle();
    await phone.engine.refresh();

    assert.notEqual(phone.engine.getSnapshot().pullRequests[0].group, "snoozed");
  });

  it("shares Slack channels, and their removal", async () => {
    const { phone, laptop, later } = twoDevices();
    await laptop.engine.start();
    laptop.engine.setSync(true);
    laptop.engine.setTeamChannel("o/core", "https://app.slack.com/client/T1/C1");
    await settle();
    await phone.engine.start();
    phone.engine.setSync(true);
    await settle();
    assert.equal(phone.engine.getSnapshot().teamChannels["o/core"].source, "saved");

    // Removed later, which has to win over the copy the phone still has.
    later();
    laptop.engine.removeTeamChannel("o/core");
    await settle();
    await phone.engine.refresh();

    assert.deepEqual(phone.engine.getSnapshot().teamChannels, {});
  });

  it("reports a failed sync without breaking the refresh", async () => {
    const github = new FakeGithub();
    github.createGist = async () => {
      throw new FetchError("api", "GitHub wouldn't let this token use gists.");
    };
    const { engine } = makeEngine({ github });
    await engine.start();
    engine.setSync(true);
    await settle();

    const snapshot = engine.getSnapshot();
    assert.match(snapshot.sync.error!, /gists/);
    assert.deepEqual(snapshot.status, { kind: "ok" });
  });

  it("makes a new gist when the old one was deleted", async () => {
    const { engine, github } = makeEngine({
      storage: memory({
        "reviewPinger.token": "ghp_x",
        "reviewPinger.state": JSON.stringify({
          memory: { sync: { enabled: true, gistId: "gone" } },
          directory: {},
        }),
      }),
    });
    await engine.start();
    engine.snooze("mine", 3);
    await settle();

    assert.equal(github.gists_.gist?.id, "g1");
  });
});

describe("custom views", () => {
  it("doesn't ask for anything until a view is added and enabled", async () => {
    const { engine, github } = makeEngine();
    await engine.start();
    assert.deepEqual(github.viewCalls.at(-1), []);
    assert.equal(engine.getSnapshot().views.length, 0);
  });

  it("adding a view shows it right away and asks for it on the next poll", async () => {
    const { engine, github } = makeEngine();
    await engine.start();
    github.fetched.viewPullRequests = { placeholder: [] };

    engine.addView("P1 bugs", "label:p1");
    await settle();

    const view = engine.getSnapshot().views[0];
    assert.equal(view.name, "P1 bugs");
    assert.equal(view.query, "label:p1");
    assert.deepEqual(github.viewCalls.at(-1), [[view.id, "is:pr label:p1"]]);
  });

  it("a view's PRs show under its id, separate from your own and review PRs", async () => {
    const { engine, github } = makeEngine();
    await engine.start();
    engine.addView("Backend", "label:backend");
    await settle();
    const id = engine.getSnapshot().views[0].id;
    github.fetched.viewPullRequests = { [id]: [pr("matched")] };

    await engine.refresh();

    assert.deepEqual(
      engine.getSnapshot().viewPullRequests[id]?.map((p) => p.id),
      ["matched"],
    );
  });

  it("renaming a view keeps its place and query", async () => {
    const { engine } = makeEngine();
    await engine.start();
    engine.addView("P1", "label:p1");
    await settle();
    const id = engine.getSnapshot().views[0].id;

    engine.updateView(id, "P1 bugs", "label:p1 is:open");

    const view = engine.getSnapshot().views[0];
    assert.equal(view.name, "P1 bugs");
    assert.equal(view.query, "label:p1 is:open");
  });

  it("removing a view drops it from the list, the order, and its PRs", async () => {
    const { engine } = makeEngine();
    await engine.start();
    engine.addView("P1", "label:p1");
    await settle();
    const id = engine.getSnapshot().views[0].id;

    engine.removeView(id);

    const snapshot = engine.getSnapshot();
    assert.equal(snapshot.views.length, 0);
    assert.equal(snapshot.viewPullRequests[id], undefined);
    assert.ok(!snapshot.myPrsSections.some((pref) => pref.kind === "view"));
  });

  it("disabling a view's section stops asking for it", async () => {
    const { engine, github } = makeEngine();
    await engine.start();
    engine.addView("P1", "label:p1");
    await settle();
    const sections = engine.getSnapshot().myPrsSections;
    const viewPref = sections.find((pref) => pref.kind === "view")!;

    engine.setMyPrsSections(
      sections.map((pref) => (pref === viewPref ? { ...pref, enabled: false } : pref)),
    );
    await settle();

    assert.deepEqual(github.viewCalls.at(-1), []);
  });
});
