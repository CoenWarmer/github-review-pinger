import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createGithub,
  mergedBySearches,
  couldBeReady,
  FetchError,
  needsRequiredChecks,
  requiredChecksQuery,
  type Queries,
  type RawPullRequest,
} from "./github.ts";

const queries: Queries = { search: "SEARCH", details: "DETAILS", mergeState: "MERGE", mergedSearch: "MERGED", prSearch: "PRSEARCH", statsMerged: "STATS" };

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
    const fetched = await github(handler).fetchOpenPullRequests("2026-09-01", true, []);

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

  it("skips the authored search entirely when nothing needs it", async () => {
    const { handler, calls } = fakeGithub(
      {
        "author:@me": [["own1"]],
        "review-requested:@me": [["req1"]],
        "reviewed-by:@me": [[]],
      },
      { own1: { id: "own1" }, req1: { id: "req1" } },
    );
    const fetched = await github(handler).fetchOpenPullRequests("2026-09-01", false, []);

    assert.equal(fetched.viewer, "me");
    assert.deepEqual(fetched.pullRequests, []);
    assert.deepEqual(
      fetched.reviewPullRequests.map((pr) => pr.id),
      ["req1"],
    );
    const searched = calls.filter((c) => c.query === "SEARCH").map((c) => String(c.variables.q));
    assert.ok(!searched.some((q) => q.includes("author:@me") && !q.includes("-author:@me")));
  });

  it("hands over your own PRs first when asked, and still returns the same result", async () => {
    const searches = {
      "author:@me": [["own1", "own2"]],
      "review-requested:@me": [["req1", "own1"]],
      "reviewed-by:@me": [["done1"]],
    };
    const prs = {
      own1: approved("own1"),
      own2: { id: "own2", reviewDecision: null },
      req1: { id: "req1" },
      done1: { id: "done1" },
    };
    const normal = fakeGithub(searches, prs);
    const expected = await github(normal.handler).fetchOpenPullRequests("2026-09-01", true, []);

    const staged = fakeGithub(searches, prs);
    const partials: { own: string[]; review: number; atCall: number }[] = [];
    const fetched = await github(staged.handler).fetchOpenPullRequests(
      "2026-09-01",
      true,
      [],
      (partial) =>
        partials.push({
          own: partial.pullRequests.map((pr) => pr.id).sort(),
          review: partial.reviewPullRequests.length,
          atCall: staged.calls.length,
        }),
    );

    // Your own PRs only, handed over once, before any merge state was asked for.
    assert.deepEqual(partials.map((p) => [p.own, p.review]), [[["own1", "own2"], 0]]);
    assert.ok(
      !staged.calls.slice(0, partials[0].atCall).some((c) => c.query === "MERGE"),
    );
    assert.deepEqual(fetched, expected);
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

describe("fetching merged pull requests", () => {
  it("pages through merged PRs by cursor", async () => {
    const pages = [
      {
        pageInfo: { hasNextPage: true, endCursor: "c1" },
        nodes: [{ id: "a", number: 1, title: "A", url: "u", mergedAt: "2026-10-27T00:00:00Z", repository: { nameWithOwner: "o/r" } }],
      },
      {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ id: "b", number: 2, title: "B", url: "u", mergedAt: "2026-10-20T00:00:00Z", repository: { nameWithOwner: "o/r" } }],
      },
    ];
    const calls: Record<string, unknown>[] = [];
    const handler: Handler = ({ variables }) => {
      calls.push(variables);
      return reply({ search: pages[variables.cursor ? 1 : 0] });
    };
    const client = github(handler);

    const first = await client.fetchMergedPage(null, 10);
    assert.deepEqual(first.items.map((i) => i.id), ["a"]);
    assert.equal(first.hasNextPage, true);
    assert.equal(first.endCursor, "c1");

    const second = await client.fetchMergedPage(first.endCursor, 5);
    assert.deepEqual(second.items.map((i) => i.id), ["b"]);
    assert.equal(second.hasNextPage, false);

    assert.deepEqual(calls[0].cursor, null);
    assert.equal(calls[1].cursor, "c1");
    assert.equal(calls[1].count, 5);
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

describe("statistics", () => {
  it("splits team members across searches that fit, each login in exactly one", () => {
    assert.deepEqual(mergedBySearches(">=2026-10-01", "o", []), []);
    assert.deepEqual(mergedBySearches(">=2026-10-01", "o", ["ana", "bo"]), [
      "is:pr is:merged merged:>=2026-10-01 org:o author:ana author:bo",
    ]);
    const many = Array.from({ length: 120 }, (_, i) => `member-number-${i}`);
    const searches = mergedBySearches(">=2026-10-01", "o", many);
    assert.ok(searches.length > 1);
    assert.ok(searches.every((s) => s.length <= 250));
    assert.equal(searches.join(" ").split(" author:").length - 1, many.length);
  });

  it("counts your merged PRs and a team's, and samples when reviews came", async () => {
    const seen: string[] = [];
    const gh = github(({ query, variables }) => {
      if (query === "STATS") {
        seen.push(String(variables.q));
        return reply({
          search: {
            issueCount: 60,
            nodes: [
              {
                createdAt: "2026-09-30T08:00:00Z",
                mergedAt: "2026-10-02T08:00:00Z",
                // Opened as a draft, then marked ready; events arrive in any order.
                draftEvents: {
                  nodes: [
                    { __typename: "ConvertToDraftEvent", createdAt: "2026-10-01T09:00:00Z" },
                    { __typename: "ReadyForReviewEvent", createdAt: "2026-09-30T12:00:00Z" },
                    { __typename: "SomethingElse", createdAt: "2026-09-30T13:00:00Z" },
                  ],
                },
                timelineItems: { nodes: [{ createdAt: "2026-10-01T10:00:00Z" }] },
                reviews: { nodes: [{ submittedAt: "2026-10-01T12:00:00Z", author: { login: "ana" } }, { submittedAt: null, author: null }] },
                // Each reviewer's latest opinion: only the approvals are kept.
                approvals: {
                  nodes: [
                    { state: "APPROVED", submittedAt: "2026-10-01T14:00:00Z", author: { login: "ana" } },
                    { state: "CHANGES_REQUESTED", submittedAt: "2026-10-01T13:00:00Z", author: { login: "bo" } },
                    { state: "APPROVED", submittedAt: null, author: { login: "cy" } },
                  ],
                },
              },
              null,
              // Not merged, so nothing to time.
              { createdAt: "2026-10-01T00:00:00Z", mergedAt: null, draftEvents: { nodes: [] }, timelineItems: { nodes: [] }, reviews: { nodes: [] }, approvals: { nodes: [] } },
              {
                createdAt: "2026-10-03T08:00:00Z",
                mergedAt: "2026-10-03T09:00:00Z",
                draftEvents: { nodes: [] },
                timelineItems: { nodes: [] },
                reviews: { nodes: [] },
                approvals: { nodes: [] },
              },
            ],
          },
        });
      }
      // The team lookup, then the aliased counts.
      if (query.includes("members(first: 100")) {
        return reply({ t0: { team: { members: { nodes: [{ login: "ana" }, { login: "bo" }], pageInfo: { hasNextPage: false, endCursor: null } } } } });
      }
      seen.push(query);
      if (query.includes("me: search(")) return reply({ me: { issueCount: 14 } });
      // A small team is counted member by member: ana 30, bo 11.
      return reply({ m0: { issueCount: 30 }, m1: { issueCount: 11 } });
    });
    const stats = await gh.fetchStats("o/core", ">=2026-09-29");
    assert.equal(stats.mergedByMe, 60);
    // In the team's org only, the scope the team's count is in.
    assert.equal(stats.mergedByMeInTeamOrg, 14);
    assert.equal(stats.mergedByTeam, 41);
    assert.equal(stats.teamMembersCapped, false);
    assert.equal(stats.teamMemberCount, 2);
    assert.deepEqual(stats.teamMemberMerged, [30, 11]);
    assert.deepEqual(stats.sample, [
      {
        createdAt: "2026-09-30T08:00:00Z",
        mergedAt: "2026-10-02T08:00:00Z",
        // Oldest first, and only the kinds that matter.
        draftEvents: [
          { kind: "ready", at: "2026-09-30T12:00:00Z" },
          { kind: "draft", at: "2026-10-01T09:00:00Z" },
        ],
        requestedAt: "2026-10-01T10:00:00Z",
        reviews: [{ by: "ana", at: "2026-10-01T12:00:00Z" }],
        approvals: [{ by: "ana", at: "2026-10-01T14:00:00Z" }],
      },
      {
        createdAt: "2026-10-03T08:00:00Z",
        mergedAt: "2026-10-03T09:00:00Z",
        draftEvents: [],
        requestedAt: null,
        reviews: [],
        approvals: [],
      },
    ]);
    assert.ok(seen[0].startsWith("is:pr is:merged author:@me merged:>=2026-09-29"));
    assert.ok(seen.some((q) => q.includes("org:o author:ana")));
    assert.ok(seen.some((q) => q.includes("org:o author:bo")));
    assert.ok(seen.some((q) => q.includes("author:@me merged:>=2026-09-29 org:o")));
  });

  it("counts a team over the cap together instead, with no per-member numbers", async () => {
    const logins = Array.from({ length: 151 }, (_, i) => `member-${String(i).padStart(3, "0")}`);
    const page = (nodes: string[], more: boolean) => ({
      nodes: nodes.map((login) => ({ login })),
      pageInfo: { hasNextPage: more, endCursor: more ? "next" : null },
    });
    const seen: string[] = [];
    const gh = github(({ query, variables }) => {
      if (query === "STATS") return reply({ search: { issueCount: 5, nodes: [] } });
      if (query.includes("members(first: 100")) {
        return variables.after
          ? reply({ organization: { team: { members: page(logins.slice(100), false) } } })
          : reply({ t0: { team: { members: page(logins.slice(0, 100), true) } } });
      }
      seen.push(query);
      if (query.includes("me: search(")) return reply({ me: { issueCount: 2 } });
      return reply(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`s${i}`, { issueCount: 10 }])));
    });
    const stats = await gh.fetchStats("o/big", ">=2026-09-29");
    assert.equal(stats.teamMemberCount, 151);
    assert.equal(stats.teamMemberMerged, null);
    // The aliased searches each took several authors, not one.
    assert.ok(seen.some((q) => q.includes("s0:") && q.includes("author:member-000 author:member-001")));
    assert.ok(!seen.some((q) => q.includes("m0:")));
    assert.ok((stats.mergedByTeam ?? 0) > 0);
  });

  it("counts an earlier window in total, not member by member", async () => {
    const seen: string[] = [];
    const gh = github(({ query, variables }) => {
      if (query === "STATS") {
        seen.push(String(variables.q));
        return reply({ search: { issueCount: 4, nodes: [] } });
      }
      if (query.includes("members(first: 100")) {
        return reply({ t0: { team: { members: { nodes: [{ login: "ana" }, { login: "bo" }], pageInfo: { hasNextPage: false, endCursor: null } } } } });
      }
      seen.push(query);
      if (query.includes("me: search(")) return reply({ me: { issueCount: 2 } });
      return reply({ s0: { issueCount: 33 } });
    });
    const stats = await gh.fetchStats("o/core", "2026-08-30..2026-09-28", false);
    assert.equal(stats.mergedByMe, 4);
    assert.equal(stats.mergedByMeInTeamOrg, 2);
    assert.equal(stats.mergedByTeam, 33);
    assert.equal(stats.teamMemberCount, 2);
    assert.equal(stats.teamMemberMerged, null);
    // The earlier dates go to every search, and no member got a search of their own.
    assert.ok(seen.every((q) => q.includes("merged:2026-08-30..2026-09-28")));
    assert.ok(!seen.some((q) => q.includes("m0:")));
  });

  it("skips the team count without a team, and says what a missing scope blocks", async () => {
    const gh = github(({ query }) =>
      query === "STATS"
        ? reply({ search: { issueCount: 3, nodes: [] } })
        : new Response(JSON.stringify({ data: { viewer: { login: "me", organizations: { nodes: [] } } }, errors: [{ type: "INSUFFICIENT_SCOPES", message: "needs read:org" }] }), { status: 200 }),
    );
    const stats = await gh.fetchStats(null, ">=2026-09-29");
    assert.deepEqual(stats, { mergedByMe: 3, mergedByMeInTeamOrg: null, mergedByTeam: null, teamMembersCapped: false, teamMemberCount: 0, teamMemberMerged: null, sample: [] });
    await assert.rejects(gh.fetchMyTeams(), /read:org/);
  });

  it("lists your teams across organizations as org/slug", async () => {
    const gh = github(({ query }) =>
      query.includes("organizations(first")
        ? reply({ viewer: { login: "me", organizations: { nodes: [{ login: "Elastic" }, { login: "other" }] } } })
        : reply({
            o0: { login: "Elastic", teams: { nodes: [{ slug: "Kibana-Core" }, { slug: "ops" }] } },
            o1: { login: "other", teams: { nodes: [] } },
          }),
    );
    assert.deepEqual(await gh.fetchMyTeams(), ["elastic/kibana-core", "elastic/ops"]);
  });
});

describe("review statistics", () => {
  const WINDOW = ["2026-09-29T00:00:00.000Z", "2026-10-29T00:00:00.000Z"] as const;

  /** A fake GitHub for a team of `logins`; `members` answers the per-member lookups. */
  function reviewGithub(
    logins: string[],
    members: (batch: string) => Record<string, unknown>,
    seen: { query: string; variables: Record<string, unknown> }[] = [],
  ) {
    const page = (nodes: string[], more: boolean) => ({
      nodes: nodes.map((login) => ({ login })),
      pageInfo: { hasNextPage: more, endCursor: more ? "next" : null },
    });
    return github(({ query, variables }) => {
      seen.push({ query, variables });
      if (query.includes("organization(login: $org) { id }")) return reply({ organization: { id: "ORG1" } });
      if (query.includes("members(first: 100")) {
        const big = logins.length > 100;
        return variables.after
          ? reply({ organization: { team: { members: page(logins.slice(100), false) } } })
          : reply({ t0: { team: { members: page(logins.slice(0, 100), big) } } });
      }
      if (query.includes("u0:")) return reply(members(query));
      // Your own count, in all repos or in the org.
      return reply({
        viewer: { contributionsCollection: { totalPullRequestReviewContributions: variables.org ? 30 : 37 } },
      });
    });
  }

  it("counts your reviews, in all repos and in the team's org, and each member's", async () => {
    const seen: { query: string; variables: Record<string, unknown> }[] = [];
    const gh = reviewGithub(
      ["ana", "bo"],
      () => ({ u0: { c: { totalPullRequestReviewContributions: 5 } }, u1: { c: { totalPullRequestReviewContributions: 9 } } }),
      seen,
    );
    const stats = await gh.fetchReviewStats("o/core", ...WINDOW);
    assert.deepEqual(stats, {
      reviewsByMe: 37,
      reviewsByMeInTeamOrg: 30,
      teamMemberCount: 2,
      teamMemberReviews: [5, 9],
    });
    // The window and the org id go to GitHub as variables.
    const own = seen.filter((s) => s.query.includes("viewer {"));
    assert.ok(own.some((s) => s.variables.org === null && s.variables.from === WINDOW[0] && s.variables.to === WINDOW[1]));
    assert.ok(own.some((s) => s.variables.org === "ORG1"));
    assert.ok(seen.some((s) => s.query.includes('user(login: "ana")') && s.query.includes('user(login: "bo")')));
  });

  it("leaves a login GitHub doesn't know out, rather than counting it as zero", async () => {
    const gh = reviewGithub(["ana", "gone"], () => ({
      u0: { c: { totalPullRequestReviewContributions: 4 } },
      u1: null,
    }));
    const stats = await gh.fetchReviewStats("o/core", ...WINDOW);
    assert.deepEqual(stats.teamMemberReviews, [4]);
    assert.equal(stats.teamMemberCount, 2);
  });

  it("is just your own count without a team", async () => {
    const seen: { query: string; variables: Record<string, unknown> }[] = [];
    const gh = reviewGithub([], () => ({}), seen);
    assert.deepEqual(await gh.fetchReviewStats(null, ...WINDOW), {
      reviewsByMe: 37,
      reviewsByMeInTeamOrg: null,
      teamMemberCount: 0,
      teamMemberReviews: null,
    });
    assert.equal(seen.length, 1);
  });

  it("counts no member for a team over the cap, as GitHub counts these per person", async () => {
    const logins = Array.from({ length: 151 }, (_, i) => `member-${String(i).padStart(3, "0")}`);
    const seen: { query: string; variables: Record<string, unknown> }[] = [];
    const gh = reviewGithub(logins, () => ({}), seen);
    const stats = await gh.fetchReviewStats("o/big", ...WINDOW);
    assert.equal(stats.teamMemberCount, 151);
    assert.equal(stats.teamMemberReviews, null);
    assert.equal(stats.reviewsByMeInTeamOrg, 30);
    assert.ok(!seen.some((s) => s.query.includes("u0:")));
  });

  it("counts an earlier window for you alone, without looking the team up", async () => {
    const seen: { query: string; variables: Record<string, unknown> }[] = [];
    const gh = reviewGithub(["ana", "bo"], () => ({}), seen);
    const stats = await gh.fetchReviewStats("o/core", ...WINDOW, false);
    assert.deepEqual(stats, {
      reviewsByMe: 37,
      reviewsByMeInTeamOrg: 30,
      teamMemberCount: 0,
      teamMemberReviews: null,
    });
    assert.ok(!seen.some((s) => s.query.includes("members(first: 100") || s.query.includes("u0:")));
  });

  it("says what a missing scope blocks", async () => {
    const gh = github(({ query }) =>
      query.includes("members(first: 100")
        ? new Response(JSON.stringify({ data: {}, errors: [{ type: "INSUFFICIENT_SCOPES", message: "needs read:org" }] }), { status: 200 })
        : query.includes("organization(login: $org) { id }")
          ? reply({ organization: { id: "ORG1" } })
          : reply({ viewer: { contributionsCollection: { totalPullRequestReviewContributions: 1 } } }),
    );
    await assert.rejects(gh.fetchReviewStats("o/core", ...WINDOW), /read:org/);
  });
});

describe("required checks", () => {
  const failing = (id: string): RawPullRequest =>
    ({
      id,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
    }) as RawPullRequest;
  const passing = (id: string): RawPullRequest =>
    ({
      id,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    }) as RawPullRequest;

  it("is only asked for PRs whose checks fail", () => {
    assert.ok(needsRequiredChecks(failing("a")));
    assert.ok(!needsRequiredChecks(passing("a")));
    assert.ok(!needsRequiredChecks({ id: "a" } as RawPullRequest));
  });

  it("asks about each PR by its own id, quoted", () => {
    const query = requiredChecksQuery(["PR_a", 'PR"b']);
    assert.ok(query.includes('r0: node(id: "PR_a")'));
    assert.ok(query.includes('isRequired(pullRequestId: "PR_a")'));
    assert.ok(query.includes('r1: node(id: "PR\\"b")'));
  });

  it("records the required checks of failing PRs and leaves the rest alone", async () => {
    const asked: string[] = [];
    const gh = github(({ query }) => {
      asked.push(query);
      return reply({
        r0: {
          id: "a",
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        { __typename: "CheckRun", name: "build", isRequired: true },
                        { __typename: "CheckRun", name: "docs", isRequired: false },
                        { __typename: "StatusContext", context: "kibana-ci", isRequired: true },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      });
    });
    const prs = [failing("a"), passing("b")];

    await gh.addRequiredChecks(prs);

    assert.equal(asked.length, 1);
    assert.ok(!asked[0].includes('"b"'));
    assert.deepEqual(prs[0].requiredChecks, ["build", "kibana-ci"]);
    assert.equal(prs[1].requiredChecks, undefined);
  });

  it("leaves them unset, without failing, when GitHub can't say", async () => {
    const gh = github(() => new Response("", { status: 502 }));
    const prs = [failing("a")];
    await gh.addRequiredChecks(prs);
    assert.equal(prs[0].requiredChecks, undefined);
  });
});
