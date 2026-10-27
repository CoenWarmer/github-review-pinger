import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createGithub,
  couldBeReady,
  FetchError,
  type Queries,
  type RawPullRequest,
} from "./github.ts";

const queries: Queries = { search: "SEARCH", details: "DETAILS", mergeState: "MERGE" };

type Handler = (body: {
  query: string;
  variables: Record<string, unknown>;
}) => Response | Promise<Response>;

function reply(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify({ data }), { status: 200, ...init });
}

function github(handler: Handler, sleeps: number[] = []) {
  const fetch = async (_url: unknown, init?: RequestInit) =>
    handler(JSON.parse(String(init?.body)));
  return createGithub({
    token: "t",
    queries,
    fetch: fetch as typeof globalThis.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
}

const failure = (kind: string) => (e: unknown) => e instanceof FetchError && e.kind === kind;

describe("requests", () => {
  it("maps a rejected token", async () => {
    const gh = github(() => new Response("", { status: 401 }));
    await assert.rejects(gh.fetchDetails(["a"]), failure("unauthorized"));
  });

  it("retries a server error and then succeeds", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const gh = github(
      () => (++calls < 3 ? new Response("", { status: 502 }) : reply({ nodes: [{ id: "a" }] })),
      sleeps,
    );
    assert.deepEqual(await gh.fetchDetails(["a"]), [{ id: "a" }]);
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [2000, 4000]);
  });

  it("gives up on a server error after three attempts", async () => {
    let calls = 0;
    const gh = github(() => (calls++, new Response("", { status: 502 })));
    await assert.rejects(gh.fetchDetails(["a"]), failure("api"));
    assert.equal(calls, 3);
  });

  it("reports when a rate limit lifts", async () => {
    const gh = github(() => new Response("", { status: 403, headers: { "retry-after": "60" } }));
    await assert.rejects(gh.fetchDetails(["a"]), (e: unknown) => {
      assert.ok(e instanceof FetchError && e.kind === "rateLimited");
      const wait = Date.parse(e.resetAt ?? "") - Date.now();
      return wait > 50_000 && wait <= 60_000;
    });

    const exhausted = github(
      () =>
        new Response("", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000000" },
        }),
    );
    await assert.rejects(exhausted.fetchDetails(["a"]), (e: unknown) => {
      return (
        e instanceof FetchError &&
        e.kind === "rateLimited" &&
        e.resetAt === "2033-05-18T03:33:20.000Z"
      );
    });
  });

  it("treats a plain 403 as an API error, not a rate limit", async () => {
    const gh = github(() => new Response("", { status: 403 }));
    await assert.rejects(gh.fetchDetails(["a"]), failure("api"));
  });

  it("treats a rate-limit error inside the response as a rate limit", async () => {
    const gh = github(() =>
      Response.json({ errors: [{ type: "RATE_LIMITED", message: "slow down" }] }),
    );
    await assert.rejects(gh.fetchDetails(["a"]), failure("rateLimited"));
  });

  it("maps a network failure", async () => {
    const gh = createGithub({
      token: "t",
      queries,
      fetch: (async () => {
        throw new TypeError("Load failed");
      }) as typeof globalThis.fetch,
    });
    await assert.rejects(gh.fetchDetails(["a"]), (e: unknown) => {
      return e instanceof FetchError && e.kind === "network" && e.message === "Load failed";
    });
  });
});

/** A fake GitHub holding PRs, answering the three kinds of query. */
function fakeGithub(searches: Record<string, string[][]>, prs: Record<string, RawPullRequest>) {
  const pages = new Map<string, number>();
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const handler: Handler = ({ query, variables }) => {
    calls.push({ query, variables });
    if (query === "SEARCH") {
      const q = String(variables.q);
      // The most specific key wins, since "author:@me" is also inside "-author:@me".
      const key = Object.keys(searches)
        .sort((a, b) => b.length - a.length)
        .find((k) => q.includes(k))!;
      const page = pages.get(key) ?? 0;
      pages.set(key, page + 1);
      const ids = searches[key][page];
      return reply({
        viewer: { login: "me" },
        search: {
          pageInfo: { hasNextPage: page + 1 < searches[key].length, endCursor: `c${page}` },
          nodes: ids.map((id) => ({ id })),
        },
      });
    }
    const ids = variables.ids as string[];
    if (query === "DETAILS") return reply({ nodes: ids.map((id) => prs[id] ?? null) });
    return reply({ nodes: ids.map((id) => ({ id, mergeStateStatus: "CLEAN" })) });
  };
  return { handler, calls };
}

const approved = (id: string): RawPullRequest => ({
  id,
  reviewDecision: "APPROVED",
  mergeable: "MERGEABLE",
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
});

describe("fetching pull requests", () => {
  it("splits your PRs from the ones to review and flags the requested ones", async () => {
    const { handler, calls } = fakeGithub(
      {
        "author:@me": [["own1"], ["own2"]], // two pages
        "review-requested:@me": [["req1", "both"]],
        "reviewed-by:@me": [["both", "done1"]],
      },
      {
        own1: approved("own1"),
        own2: { id: "own2", reviewDecision: null },
        req1: { id: "req1" },
        both: { id: "both" },
        done1: { id: "done1" },
      },
    );
    const fetched = await github(handler).fetchOpenPullRequests("2026-09-01");

    assert.equal(fetched.viewer, "me");
    assert.deepEqual(fetched.pullRequests.map((pr) => pr.id).sort(), ["own1", "own2"]);
    const review = Object.fromEntries(
      fetched.reviewPullRequests.map((pr) => [pr.id, pr.reviewRequested]),
    );
    assert.deepEqual(review, { req1: true, both: true, done1: false });

    // The reviewed search is bounded by date; a PR in two searches is fetched once.
    const searchQueries = calls
      .filter((c) => c.query === "SEARCH")
      .map((c) => String(c.variables.q));
    assert.ok(
      searchQueries.some(
        (q) => q.includes("reviewed-by:@me") && q.endsWith("updated:>=2026-09-01"),
      ),
    );
    const detailIds = calls
      .filter((c) => c.query === "DETAILS")
      .flatMap((c) => c.variables.ids as string[]);
    assert.equal(detailIds.length, new Set(detailIds).size);

    // Only the approved, green PR of yours is asked for its merge state.
    const merged = calls
      .filter((c) => c.query === "MERGE")
      .flatMap((c) => c.variables.ids as string[]);
    assert.deepEqual(merged, ["own1"]);
    const own = Object.fromEntries(fetched.pullRequests.map((pr) => [pr.id, pr.mergeStateStatus]));
    assert.deepEqual(own, { own1: "CLEAN", own2: null });
  });

  it("fetches details in batches of ten", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `p${i}`);
    const { handler, calls } = fakeGithub({}, Object.fromEntries(ids.map((id) => [id, { id }])));
    const prs = await github(handler).fetchDetails(ids);
    assert.equal(prs.length, 25);
    assert.deepEqual(
      calls.map((c) => (c.variables.ids as string[]).length).sort((a, b) => b - a),
      [10, 10, 5],
    );
  });

  it("drops PRs GitHub returns as null", async () => {
    const { handler } = fakeGithub({}, { a: { id: "a" } });
    assert.deepEqual(await github(handler).fetchDetails(["a", "gone"]), [{ id: "a" }]);
  });
});

describe("the team directory", () => {
  it("looks up members, lowercased, following pages", async () => {
    const queriesSeen: string[] = [];
    const gh = github(({ query, variables }) => {
      queriesSeen.push(query);
      if (query.startsWith("query($org")) {
        assert.deepEqual(variables, { org: "elastic", slug: "core", after: "c1" });
        return reply({
          organization: {
            team: {
              members: {
                nodes: [{ login: "Cy" }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      }
      return reply({
        t0: {
          team: {
            members: {
              nodes: [{ login: "Ana" }, { login: "Bo" }],
              pageInfo: { hasNextPage: true, endCursor: "c1" },
            },
          },
        },
        t1: null,
      });
    });
    const found = await gh.fetchDirectory({
      teams: [
        ["elastic", "core"],
        ["elastic", "hidden"],
      ],
    });

    assert.deepEqual(found, { teams: { "elastic/core": ["ana", "bo", "cy"] }, denied: false });
    assert.match(queriesSeen[0], /t0: organization\(login: "elastic"\) \{ team\(slug: "core"\)/);
    assert.match(queriesSeen[0], /t1: organization\(login: "elastic"\) \{ team\(slug: "hidden"\)/);
  });

  it("says so when the token lacks read:org", async () => {
    const gh = github(() =>
      Response.json({
        data: { t0: null },
        errors: [
          {
            type: "INSUFFICIENT_SCOPES",
            message: "Your token has not been granted the required scopes: read:org",
          },
        ],
      }),
    );
    assert.deepEqual(await gh.fetchDirectory({ teams: [["elastic", "core"]] }), {
      teams: {},
      denied: true,
    });
  });

  it("asks nothing when there are no teams", async () => {
    const gh = github(() => assert.fail("no request expected"));
    assert.deepEqual(await gh.fetchDirectory({ teams: [] }), { teams: {}, denied: false });
  });
});

describe("couldBeReady", () => {
  const base = approved("p");
  it("is true for an approved, green, mergeable PR", () => assert.ok(couldBeReady(base)));
  it("accepts an opinionated approval when there is no review decision", () => {
    assert.ok(
      couldBeReady({
        ...base,
        reviewDecision: null,
        latestOpinionatedReviews: { nodes: [{ state: "APPROVED" }] },
      }),
    );
    assert.ok(!couldBeReady({ ...base, reviewDecision: null }));
  });
  it("is false for anything that rules out merging", () => {
    assert.ok(!couldBeReady({ ...base, reviewDecision: "CHANGES_REQUESTED" }));
    assert.ok(!couldBeReady({ ...base, isDraft: true }));
    assert.ok(!couldBeReady({ ...base, mergeable: "CONFLICTING" }));
    assert.ok(!couldBeReady({ ...base, autoMergeRequest: {} }));
    assert.ok(!couldBeReady({ ...base, mergeQueueEntry: {} }));
    assert.ok(
      !couldBeReady({
        ...base,
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
      }),
    );
  });
  it("counts a PR without checks as green", () =>
    assert.ok(couldBeReady({ ...base, commits: { nodes: [] } })));
});
