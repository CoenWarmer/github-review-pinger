// Fetches pull requests from GitHub's GraphQL API, the way the desktop app's
// Rust code does: list the ids of the open PRs, fetch their details in
// concurrent batches, then fetch the expensive merge state only for the
// viewer's own PRs that could be ready to merge.

const ENDPOINT = "https://api.github.com/graphql";
const REST = "https://api.github.com";
const MAX_SEARCH_PAGES = 10;
/** Small enough that each request finishes well inside GitHub's ~10 s GraphQL timeout. */
const BATCH_SIZE = 10;
const MAX_CONCURRENT = 8;
const MAX_ATTEMPTS = 3;
/** Aliases per directory query, which keeps each query light. */
// Measured against a real account: 8 teams per query and 10 queries at once
// looked up 75 teams in about 3.5 s, where 15 per query and 2 at once took
// about 10 s.
const DIRECTORY_BATCH = 8;
const DIRECTORY_CONCURRENT = 10;
/** Members are read 100 at a time, so this reads teams of up to 500. */
const MAX_MEMBER_PAGES = 5;

const AUTHORED = "is:pr is:open author:@me archived:false";
const REVIEW_REQUESTED = "is:pr is:open review-requested:@me -author:@me archived:false";
/** Always this text, so "Load more" can keep paging through the same cursor sequence. */
const MERGED_SEARCH = "is:pr is:merged author:@me archived:false sort:updated-desc";

const MEMBERS_QUERY =
  "query($org: String!, $slug: String!, $after: String) { organization(login: $org) { team(slug: $slug) { members(first: 100, after: $after) { nodes { login } pageInfo { hasNextPage endCursor } } } } }";

/** The GraphQL documents, which the Rust code shares through the core crate. */
export interface Queries {
  search: string;
  /** The details query followed by the pull request fragment it uses. */
  details: string;
  mergeState: string;
  mergedSearch: string;
  prSearch: string;
  statsMerged: string;
}

export type FailureKind = "unauthorized" | "rateLimited" | "network" | "api";

export class FetchError extends Error {
  readonly kind: FailureKind;
  /** When a rate limit lifts, if GitHub said. */
  readonly resetAt: string | null;

  constructor(kind: FailureKind, message: string, resetAt: string | null = null) {
    super(message);
    this.kind = kind;
    this.resetAt = resetAt;
  }
}

/** A pull request as GraphQL returns it, with the fields this code looks at. */
export interface RawPullRequest {
  id: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  mergeable?: string;
  autoMergeRequest?: unknown;
  mergeQueueEntry?: unknown;
  latestOpinionatedReviews?: { nodes: ({ state: string } | null)[] } | null;
  commits?: { nodes: ({ commit: { statusCheckRollup?: { state: string } | null } } | null)[] };
  reviewRequested?: boolean;
  mergeStateStatus?: string | null;
  /** The head commit's checks that branch protection requires, and how each stands; filled in for PRs whose checks fail. */
  requiredChecks?: RequiredCheck[] | null;
  [field: string]: unknown;
}

export interface Fetched {
  viewer: string;
  /** Open PRs the viewer authored. */
  pullRequests: RawPullRequest[];
  /** Open PRs by others that the viewer is asked to review or already reviewed. */
  reviewPullRequests: RawPullRequest[];
  /** Each enabled custom view's matching PRs, by view id. A PR already in
   * `pullRequests` or `reviewPullRequests` that also matches a view shows up
   * in both. */
  viewPullRequests: Record<string, RawPullRequest[]>;
  /** GitHub left out orgs whose SSO the token isn't authorized for. */
  ssoPartial: boolean;
}

/** A merged PR as the lighter merged-PR search returns it. */
export interface RawMergedPullRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  repository: { nameWithOwner: string };
}

/** One page of merged PRs, newest first. */
export interface MergedPage {
  items: RawMergedPullRequest[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/** A PR found by "Search on GitHub", in any state. */
export interface FoundPullRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string | null;
  state: "open" | "draft" | "merged" | "closed";
  updatedAt: string;
}

/** What the Statistics section is drawn from; the UI works the averages out. */
export interface StatsData {
  /** All of your PRs merged in the window, in any repo. */
  mergedByMe: number;
  /** Your PRs merged in the window in the chosen team's organization, the
   * scope the team's count is in too; null with no team. */
  mergedByMeInTeamOrg: number | null;
  /** PRs merged by the team's members in the window, when a team is chosen. */
  mergedByTeam: number | null;
  /** The team has more members than are looked up, so its count is short. */
  teamMembersCapped: boolean;
  /** How many members of the team were looked up; 0 with no team. */
  teamMemberCount: number;
  /** What each member merged, in no particular order, for a team small
   * enough to count member by member; null otherwise. */
  teamMemberMerged: number[] | null;
  /** Up to 100 of your merged PRs, newest first. */
  sample: {
    /** When the PR was opened. */
    createdAt: string;
    /** When it was merged. */
    mergedAt: string;
    /** Each time it was marked ready for review or turned back into a draft,
     * oldest first. A PR opened as a draft starts with a ready event. */
    draftEvents: { kind: "ready" | "draft"; at: string }[];
    requestedAt: string | null;
    reviews: { by: string | null; at: string }[];
    /** The approvals still in effect when it merged, one per reviewer. */
    approvals: { by: string | null; at: string }[];
  }[];
}

/** What the review chart is drawn from: reviews people submitted in a window. */
export interface ReviewStatsData {
  /** Reviews you submitted, in any repo. */
  reviewsByMe: number;
  /** Reviews you submitted in the chosen team's organization, the scope the
   * team's counts are in; null with no team. */
  reviewsByMeInTeamOrg: number | null;
  /** How many members of the team were looked up; 0 with no team. */
  teamMemberCount: number;
  /** What each member reviewed in the org, in no particular order, for a
   * team small enough to count member by member; null otherwise. */
  teamMemberReviews: number[] | null;
}

/** GitHub rejects search text over 256 characters. */
const MAX_SEARCH_CHARS = 250;
/**
 * Teams up to this size are counted member by member, which the median
 * needs. Bigger ones are counted together in a few searches, as one number.
 */
export const MEMBER_COUNT_CAP = 150;
// Measured against a real account: members per query and queries at once.
const MEMBERS_PER_QUERY = 8;
const MEMBER_QUERIES_AT_ONCE = 10;

/**
 * Search texts that count PRs merged in the date `range` (GitHub's `merged:`
 * syntax, such as `>=2026-10-01`) in `org` by any
 * of `logins`: several `author:` qualifiers match any of them, but only so
 * many fit in one search, so the logins are split across as few as will hold
 * them.
 */
export function mergedBySearches(range: string, org: string, logins: string[]): string[] {
  const start = `is:pr is:merged merged:${range} org:${org}`;
  const searches: string[] = [];
  let current = start;
  for (const login of logins) {
    const author = ` author:${login}`;
    if (current !== start && current.length + author.length > MAX_SEARCH_CHARS) {
      searches.push(current);
      current = start;
    }
    current += author;
  }
  if (current !== start) searches.push(current);
  return searches;
}

/** What a team lookup found: lowercase member logins by `org/slug`. */
export interface Found {
  teams: Record<string, string[]>;
  /** GitHub refused for lack of the `read:org` scope. */
  denied: boolean;
}

export interface Needs {
  teams: [string, string][];
}

/** Which pull requests to fetch first, so the screen updates in phases. */
export interface Plan {
  /** Refetched at once, while the searches run: the PRs in sections that are open. */
  first: string[];
  /** Which of `first` are the viewer's own, since only those get required checks and merge states. */
  own: string[];
  /** The Review requests tab is the one being looked at, so its PRs come before the rest. */
  reviewsTab: boolean;
}

/** Which searches found each PR, so one fetched partway through can be filed. */
export interface Matches {
  authored: string[];
  requested: string[];
  reviewed: string[];
  /** Each enabled view's matches, by view id. */
  views: Record<string, string[]>;
}

/** PRs that just arrived, handed over for display while the rest is fetched. */
export interface Progress {
  fresh: RawPullRequest[];
  /** Known once the searches have returned. */
  matches: Matches | null;
  /** Empty until the searches have returned. */
  viewer: string;
  ssoPartial: boolean;
}

export const NO_PLAN: Plan = { first: [], own: [], reviewsTab: false };

export interface Github {
  /**
   * `includeAuthored` is false to skip the search for your own open PRs
   * entirely. `views` is `[id, query]` pairs for enabled custom views, each
   * already including `is:pr`. The PRs on screen (`plan.first`) are refetched
   * while the searches run, then the tab being looked at, then the other
   * one. `onProgress` gets each phase's PRs as soon as they're in, before
   * their merge states.
   */
  fetchOpenPullRequests(
    reviewedSince: string,
    includeAuthored: boolean,
    views: [string, string][],
    plan?: Plan,
    onProgress?: (progress: Progress) => void,
  ): Promise<Fetched>;
  fetchDetails(ids: string[]): Promise<RawPullRequest[]>;
  /** `cursor` continues from a previous page's `endCursor`; `null` starts from the top. */
  fetchMergedPage(cursor: string | null, count: number): Promise<MergedPage>;
  /** The first page of PRs, in any state, matching the text and any qualifiers in it. */
  searchPullRequests(text: string): Promise<FoundPullRequest[]>;
  /**
   * The reviews submitted between `from` and `to` (ISO times): yours, and a
   * team's (`org/slug`) member by member when one is chosen and it's small
   * enough.
   */
  fetchReviewStats(
    team: string | null,
    from: string,
    to: string,
    /** False for an earlier window that's only compared with: just your own counts. */
    byMember?: boolean,
  ): Promise<ReviewStatsData>;
  /** The teams you belong to, as `org/slug`. Needs `read:org`. */
  fetchMyTeams(): Promise<string[]>;
  /**
   * The statistics for the merged-date `range` (GitHub's `merged:` syntax,
   * such as `>=2026-10-01` or `2026-08-30..2026-09-28`), with `team`
   * (`org/slug`) counted too when chosen. Without `byMember`, as for an
   * earlier window that's only compared with, the team is counted in total
   * rather than member by member.
   */
  fetchStats(team: string | null, range: string, byMember?: boolean): Promise<StatsData>;
  addMergeStates(pullRequests: RawPullRequest[]): Promise<void>;
  /** Best effort: leaves `requiredChecks` unset when GitHub can't say. */
  addRequiredChecks(pullRequests: RawPullRequest[]): Promise<void>;
  fetchDirectory(needs: Needs): Promise<Found>;
  /** The token's scopes as GitHub lists them; `null` for tokens that have none, such as fine-grained ones. */
  scopes(): Promise<string | null>;
  /** One page of the user's gists, 100 at a time, as JSON. */
  gists(page: number): Promise<string>;
  /** The gist as JSON, or `null` when it's gone. */
  gist(id: string): Promise<string | null>;
  /** Creates a gist from a request body and returns its id. */
  createGist(body: string): Promise<string>;
  updateGist(id: string, body: string): Promise<void>;
}

interface Options {
  token: string;
  queries: Queries;
  fetch?: typeof fetch;
  /** For tests, so retries don't wait. */
  sleep?: (ms: number) => Promise<void>;
}

interface GraphqlError {
  type?: string;
  message: string;
}

interface Reply<T> {
  data: T;
  ssoPartial: boolean;
  scopeMissing: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `fn` over `items` with at most `limit` in flight, keeping the order of the results. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Runs at most `max` tasks at once, starting them in the order they were
 * asked for, so whatever is asked for first finishes first.
 */
function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** When a primary or secondary rate limit lifts: `undefined` if this isn't one. */
function rateLimitReset(status: number, headers: Headers): string | null | undefined {
  if (status !== 403 && status !== 429) return undefined;
  const num = (name: string) => {
    const value = headers.get(name);
    return value === null || value === "" || Number.isNaN(Number(value)) ? null : Number(value);
  };
  const retryAfter = num("retry-after");
  if (retryAfter !== null) return new Date(Date.now() + retryAfter * 1000).toISOString();
  if (num("x-ratelimit-remaining") === 0) {
    const reset = num("x-ratelimit-reset");
    return reset === null ? null : new Date(reset * 1000).toISOString();
  }
  if (status === 429) return null;
  return undefined;
}

export function createGithub({
  token,
  queries,
  fetch: fetchImpl = fetch,
  sleep = defaultSleep,
}: Options): Github {
  async function request<T>(query: string, variables: unknown = {}): Promise<Reply<T>> {
    const body = JSON.stringify({ query, variables });
    let attempt = 0;
    let response: Response;
    for (;;) {
      attempt++;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
          body,
        });
      } catch (e) {
        throw new FetchError("network", e instanceof Error ? e.message : String(e));
      }
      // GitHub occasionally times out heavy queries with a 502.
      if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
        await sleep(2000 * attempt);
        continue;
      }
      break;
    }

    if (response.status === 401) throw new FetchError("unauthorized", "GitHub rejected the token");
    const reset = rateLimitReset(response.status, response.headers);
    if (reset !== undefined)
      throw new FetchError("rateLimited", "GitHub rate limit reached", reset);
    if (!response.ok) throw new FetchError("api", `GitHub returned HTTP ${response.status}`);

    const ssoPartial = (response.headers.get("x-github-sso") ?? "").includes("partial-results");
    let parsed: { data?: T | null; errors?: GraphqlError[] };
    try {
      parsed = await response.json();
    } catch (e) {
      throw new FetchError("api", `Unexpected response from GitHub: ${e}`);
    }
    const errors = parsed.errors ?? [];
    if (errors.some((e) => e.type === "RATE_LIMITED")) {
      throw new FetchError("rateLimited", "GitHub rate limit reached");
    }
    const scopeMissing = errors.some(
      (e) => e.type === "INSUFFICIENT_SCOPES" || e.message.includes("read:org"),
    );
    if (parsed.data == null) {
      throw new FetchError("api", errors.map((e) => e.message).join("; ") || "No data from GitHub");
    }
    return { data: parsed.data, ssoPartial, scopeMissing };
  }

  /** A REST call, which unlike the GraphQL ones is a single attempt: sync tries again on the next change. */
  async function rest(method: string, path: string, body?: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(`${REST}${path}`, {
        method,
        headers: {
          Authorization: `bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body,
      });
    } catch (e) {
      throw new FetchError("network", e instanceof Error ? e.message : String(e));
    }
    if (response.status === 401) throw new FetchError("unauthorized", "GitHub rejected the token");
    const reset = rateLimitReset(response.status, response.headers);
    if (reset !== undefined)
      throw new FetchError("rateLimited", "GitHub rate limit reached", reset);
    return response;
  }

  function gistFailure(response: Response): FetchError {
    return new FetchError(
      "api",
      response.status === 403 || response.status === 404
        ? "GitHub wouldn't let this token use gists. Check that it has the gist scope."
        : `GitHub returned HTTP ${response.status} for the sync gist.`,
    );
  }

  async function searchIds(search: string) {
    interface Data {
      viewer: { login: string };
      search: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ({ id?: string } | null)[];
      };
    }
    const result = { viewer: "", ids: [] as string[], ssoPartial: false };
    let cursor: string | null = null;
    for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
      const reply: Reply<Data> = await request<Data>(queries.search, { q: search, cursor });
      result.viewer = reply.data.viewer.login;
      result.ssoPartial ||= reply.ssoPartial;
      for (const node of reply.data.search.nodes) if (node?.id) result.ids.push(node.id);
      const info = reply.data.search.pageInfo;
      if (!info.hasNextPage || !info.endCursor) break;
      cursor = info.endCursor;
    }
    return result;
  }

  /** Runs `query` for `ids` in concurrent batches and collects the non-null nodes. */
  async function inBatches<T>(query: string, ids: string[]): Promise<T[]> {
    const replies = await mapLimit(chunks(ids, BATCH_SIZE), MAX_CONCURRENT, (batch) =>
      request<{ nodes: (T | null)[] }>(query, { ids: batch }),
    );
    return replies.flatMap((reply) => reply.data.nodes).filter((node): node is T => node !== null);
  }

  const github: Github = {
    async fetchOpenPullRequests(
      reviewedSince,
      includeAuthored,
      views,
      plan = NO_PLAN,
      onProgress,
    ) {
      const started = performance.now();
      const lap = (what: string) =>
        console.info(`refresh timing +${Math.round(performance.now() - started)}ms: ${what}`);
      console.info(`refresh timing: starting; phase 1 has ${plan.first.length} PRs (${plan.own.length} own), reviews tab: ${plan.reviewsTab}`);
      const reviewed = `is:pr is:open reviewed-by:@me -author:@me archived:false updated:>=${reviewedSince}`;
      const emptySearch = { viewer: "", ids: [] as string[], ssoPartial: false };
      const searches = Promise.all([
        includeAuthored ? searchIds(AUTHORED) : Promise.resolve(emptySearch),
        searchIds(REVIEW_REQUESTED),
        searchIds(reviewed),
        Promise.all(views.map(([, query]) => searchIds(query))),
      ]).then((found) => {
        lap("searches returned");
        return found;
      });
      // Added to what the details query returns for your own PRs: required
      // checks, then (after `show`) merge states, which double a PR's cost.
      const fetchPart = async (
        prs: RawPullRequest[],
        own: Set<string>,
        show: (fresh: RawPullRequest[]) => void,
        name: string,
      ) => {
        const mine = prs.filter((pr) => own.has(pr.id));
        // Before the first paint, so a red badge doesn't flash and turn green.
        await github.addRequiredChecks(mine);
        lap(`${name} required checks done (${mine.length} own)`);
        if (prs.length > 0) {
          show(prs);
          lap(`${name} shown`);
        }
        await github.addMergeStates(mine);
        lap(`${name} merge states done`);
        return prs;
      };
      const firstPhase = async () => {
        if (plan.first.length === 0) return [];
        const fresh = await github.fetchDetails(plan.first);
        lap(`phase 1 details in (${fresh.length} PRs)`);
        return fetchPart(
          fresh,
          new Set(plan.own),
          (shown) => onProgress?.({ fresh: shown, matches: null, viewer: "", ssoPartial: false }),
          "phase 1",
        );
      };
      const [first, [authored, requested, reviewedByMe, viewResults]] = await Promise.all([
        firstPhase(),
        searches,
      ]);
      const authoredIds = new Set(authored.ids);
      const requestedIds = new Set(requested.ids);
      const reviewedIds = new Set(reviewedByMe.ids);
      const viewIds = views.map(([id], i) => [id, viewResults[i].ids] as const);

      // A PR can be in several of these at once (requested and reviewed, or
      // any of them and a view too), so dedupe for the one details fetch.
      const ids = [
        ...new Set([
          ...authored.ids,
          ...requested.ids,
          ...reviewedByMe.ids,
          ...viewIds.flatMap(([, ids]) => ids),
        ]),
      ];

      const viewer = authored.viewer || requested.viewer;
      const ssoPartial =
        authored.ssoPartial ||
        requested.ssoPartial ||
        reviewedByMe.ssoPartial ||
        viewResults.some((r) => r.ssoPartial);

      const matches: Matches = {
        authored: authored.ids,
        requested: requested.ids,
        reviewed: reviewedByMe.ids,
        views: Object.fromEntries(viewIds.map(([id, ids]) => [id, ids])),
      };
      const inViews = new Set(viewIds.flatMap(([, ids]) => ids));
      const inTab = (id: string) =>
        plan.reviewsTab
          ? requestedIds.has(id) || reviewedIds.has(id)
          : authoredIds.has(id) || inViews.has(id);
      const fetchedFirst = new Set(first.map((pr) => pr.id));
      const wanted = ids.filter((id) => !fetchedFirst.has(id));

      // The tab being looked at and the other one share the request slots,
      // with the tab asked for first: it finishes first, and the other
      // starts in the slots it leaves idle instead of waiting for all of it.
      const limit = limiter(MAX_CONCURRENT);
      const detailsOf = async (ids: string[]) => {
        const replies = await Promise.all(
          chunks(ids, BATCH_SIZE).map((batch) =>
            limit(() => request<{ nodes: (RawPullRequest | null)[] }>(queries.details, { ids: batch })),
          ),
        );
        return replies
          .flatMap((reply) => reply.data.nodes)
          .filter((node): node is RawPullRequest => node !== null);
      };
      const phase = async (name: string, ids: string[]) => {
        const fresh = await detailsOf(ids);
        lap(`${name} details in (${fresh.length} PRs)`);
        return fetchPart(
          fresh,
          authoredIds,
          (shown) => onProgress?.({ fresh: shown, matches, viewer, ssoPartial }),
          name,
        );
      };
      const [tab, other] = await Promise.all([
        phase("phase 2", wanted.filter(inTab)),
        phase("phase 3", wanted.filter((id) => !inTab(id))),
      ]);
      lap("all phases done");
      // Only your own PRs got the expensive merge state; it's on the objects
      // before anything clones from `byId`, so a PR that's also in a view carries it.
      const byId = new Map([...first, ...tab, ...other].map((pr) => [pr.id, pr]));
      const pullRequests = authored.ids.flatMap((id) => byId.get(id) ?? []);

      const reviewPullRequests = [...byId.values()].filter(
        (pr) => !authoredIds.has(pr.id) && (requestedIds.has(pr.id) || reviewedIds.has(pr.id)),
      );
      for (const pr of reviewPullRequests) pr.reviewRequested = requestedIds.has(pr.id);

      const viewPullRequests: Record<string, RawPullRequest[]> = {};
      for (const [id, ids] of viewIds) {
        viewPullRequests[id] = ids.flatMap((prId) => {
          const pr = byId.get(prId);
          // Each view's own PRs need their own objects: a reviewRequested
          // flag set for the Review tab shouldn't leak into a view's copy.
          return pr ? [{ ...pr }] : [];
        });
      }

      return {
        // The authored search may have been skipped; the other two always know who the viewer is.
        viewer,
        pullRequests,
        reviewPullRequests,
        viewPullRequests,
        ssoPartial,
      };
    },

    fetchDetails: (ids) => inBatches<RawPullRequest>(queries.details, ids),

    async fetchMergedPage(cursor, count) {
      interface Data {
        search: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: (RawMergedPullRequest | null)[];
        };
      }
      const reply: Reply<Data> = await request<Data>(queries.mergedSearch, {
        q: MERGED_SEARCH,
        count,
        cursor,
      });
      return {
        items: reply.data.search.nodes.filter((node): node is RawMergedPullRequest => node !== null),
        hasNextPage: reply.data.search.pageInfo.hasNextPage,
        endCursor: reply.data.search.pageInfo.endCursor,
      };
    },

    async searchPullRequests(text) {
      interface Node {
        id: string;
        number: number;
        title: string;
        url: string;
        state: string;
        isDraft: boolean;
        updatedAt: string;
        author: { login: string } | null;
        repository: { nameWithOwner: string };
      }
      const reply = await request<{ search: { nodes: (Node | null)[] } }>(queries.prSearch, {
        q: `is:pr ${text} sort:updated-desc`,
        count: 20,
      });
      return reply.data.search.nodes
        .filter((node): node is Node => node !== null)
        .map((pr) => ({
          id: pr.id,
          number: pr.number,
          title: pr.title,
          url: pr.url,
          repo: pr.repository.nameWithOwner,
          author: pr.author?.login ?? null,
          state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open",
          updatedAt: pr.updatedAt,
        }));
    },

    async fetchMyTeams() {
      const orgs = await request<{
        viewer: { login: string; organizations: { nodes: ({ login: string } | null)[] } };
      }>("query { viewer { login organizations(first: 50) { nodes { login } } } }");
      if (orgs.scopeMissing) throw new FetchError("api", "Listing your teams needs the read:org scope.");
      const logins = orgs.data.viewer.organizations.nodes.flatMap((org) => (org ? [org.login] : []));
      if (logins.length === 0) return [];
      const text = `query {\n${logins
        .map(
          (org, i) =>
            `o${i}: organization(login: ${JSON.stringify(org)}) { login teams(first: 100, userLogins: [${JSON.stringify(orgs.data.viewer.login)}]) { nodes { slug } } }`,
        )
        .join("\n")}\n}`;
      const reply = await request<
        Record<string, { login: string; teams: { nodes: ({ slug: string } | null)[] } } | null>
      >(text);
      return logins
        .flatMap((_, i) => {
          const org = reply.data[`o${i}`];
          return (org?.teams.nodes ?? []).flatMap((team) =>
            team ? [`${org!.login.toLowerCase()}/${team.slug.toLowerCase()}`] : [],
          );
        })
        .sort();
    },

    async fetchReviewStats(team, from, to, byMember = true) {
      const countQuery =
        "query($from: DateTime!, $to: DateTime!, $org: ID) { viewer { contributionsCollection(from: $from, to: $to, organizationID: $org) { totalPullRequestReviewContributions } } }";
      const countOf = (data: {
        viewer: { contributionsCollection: { totalPullRequestReviewContributions: number } };
      }) => data.viewer.contributionsCollection.totalPullRequestReviewContributions;
      const mine = async () => countOf((await request<Parameters<typeof countOf>[0]>(countQuery, { from, to, org: null })).data);
      const teamPart = async (): Promise<{
        inOrg: number | null;
        members: number;
        reviews: number[] | null;
      }> => {
        if (!team) return { inOrg: null, members: 0, reviews: null };
        const [org, slug] = team.split("/");
        if (!org || !slug) throw new FetchError("api", `Not a team: ${team}`);
        const [found, orgReply] = await Promise.all([
          byMember
            ? github.fetchDirectory({ teams: [[org, slug]] })
            : Promise.resolve<Found>({ teams: {}, denied: false }),
          request<{ organization: { id: string } | null }>(
            "query($org: String!) { organization(login: $org) { id } }",
            { org },
          ),
        ]);
        if (found.denied) throw new FetchError("api", "Counting a team's reviews needs the read:org scope.");
        const orgId = orgReply.data.organization?.id;
        if (!orgId) throw new FetchError("api", `Could not find ${org}.`);
        const logins = [...(found.teams[`${org.toLowerCase()}/${slug.toLowerCase()}`] ?? [])].sort();
        const inOrg = async () =>
          countOf((await request<Parameters<typeof countOf>[0]>(countQuery, { from, to, org: orgId })).data);
        const members = async (): Promise<number[] | null> => {
          if (!byMember || logins.length > MEMBER_COUNT_CAP) return null;
          const replies = await mapLimit(chunks(logins, MEMBERS_PER_QUERY), MEMBER_QUERIES_AT_ONCE, (batch) =>
            request<
              Record<
                string,
                { c: { totalPullRequestReviewContributions: number } } | null
              >
            >(
              `query($from: DateTime!, $to: DateTime!, $org: ID!) {\n${batch
                .map(
                  (login, i) =>
                    `u${i}: user(login: ${JSON.stringify(login)}) { c: contributionsCollection(from: $from, to: $to, organizationID: $org) { totalPullRequestReviewContributions } }`,
                )
                .join("\n")}\n}`,
              { from, to, org: orgId },
            ).then((reply) =>
              // A login GitHub doesn't know is left out rather than counted as zero.
              batch.flatMap((_, i) => {
                const count = reply.data[`u${i}`]?.c.totalPullRequestReviewContributions;
                return count === undefined ? [] : [count];
              }),
            ),
          );
          return replies.flat();
        };
        const [mineInOrg, counts] = await Promise.all([inOrg(), members()]);
        return { inOrg: mineInOrg, members: logins.length, reviews: counts };
      };
      const [reviewsByMe, part] = await Promise.all([mine(), teamPart()]);
      return {
        reviewsByMe,
        reviewsByMeInTeamOrg: part.inOrg,
        teamMemberCount: part.members,
        teamMemberReviews: part.reviews,
      };
    },

    async fetchStats(team, range, byMember = true) {
      interface Mine {
        search: {
          issueCount: number;
          nodes: ({
            createdAt: string;
            mergedAt: string | null;
            draftEvents: { nodes: ({ __typename: string; createdAt?: string } | null)[] };
            timelineItems: { nodes: ({ createdAt?: string } | null)[] };
            reviews: { nodes: ({ submittedAt: string | null; author: { login: string } | null } | null)[] };
            approvals: {
              nodes: ({ state: string; submittedAt: string | null; author: { login: string } | null } | null)[];
            };
          } | null)[];
        };
      }
      const mine = async () => {
        const reply = await request<Mine>(queries.statsMerged, {
          q: `is:pr is:merged author:@me merged:${range} sort:updated-desc`,
        });
        const sample = reply.data.search.nodes.flatMap((pr) =>
          // A PR with no merge time can't have merged; there's nothing to time.
          pr && pr.mergedAt
            ? [
                {
                  createdAt: pr.createdAt,
                  mergedAt: pr.mergedAt,
                  draftEvents: pr.draftEvents.nodes
                    .flatMap((event) => {
                      const kind =
                        event?.__typename === "ReadyForReviewEvent"
                          ? ("ready" as const)
                          : event?.__typename === "ConvertToDraftEvent"
                            ? ("draft" as const)
                            : null;
                      return kind && event?.createdAt ? [{ kind, at: event.createdAt }] : [];
                    })
                    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
                  requestedAt: pr.timelineItems.nodes.find((event) => event?.createdAt)?.createdAt ?? null,
                  reviews: pr.reviews.nodes.flatMap((review) =>
                    review?.submittedAt ? [{ by: review.author?.login ?? null, at: review.submittedAt }] : [],
                  ),
                  approvals: pr.approvals.nodes.flatMap((review) =>
                    review?.state === "APPROVED" && review.submittedAt
                      ? [{ by: review.author?.login ?? null, at: review.submittedAt }]
                      : [],
                  ),
                },
              ]
            : [],
        );
        return { mergedByMe: reply.data.search.issueCount, sample };
      };
      const teamCount = async (): Promise<{
        merged: number | null;
        capped: boolean;
        members: number;
        mineInOrg: number | null;
        counts: number[] | null;
      }> => {
        if (!team) return { merged: null, capped: false, members: 0, mineInOrg: null, counts: null };
        const [org, slug] = team.split("/");
        if (!org || !slug) throw new FetchError("api", `Not a team: ${team}`);
        const found = await github.fetchDirectory({ teams: [[org, slug]] });
        if (found.denied) throw new FetchError("api", "Counting a team's merges needs the read:org scope.");
        const logins = [...(found.teams[`${org.toLowerCase()}/${slug.toLowerCase()}`] ?? [])].sort();
        // Members are read a page at a time up to a limit, so a team that
        // reaches it may have more.
        const capped = logins.length >= MAX_MEMBER_PAGES * 100;
        // Your merges in the same org, so the two compare.
        const mineInOrg = async () => {
          const text = `is:pr is:merged author:@me merged:${range} org:${org}`;
          const reply = await request<{ me: { issueCount: number } | null }>(
            `query { me: search(type: ISSUE, query: ${JSON.stringify(text)}) { issueCount } }`,
          );
          return reply.data.me?.issueCount ?? null;
        };
        // The members' merges: one by one for a team small enough, which
        // also gives the total; together, as one number, for a bigger one.
        const membersMerged = async (): Promise<{ total: number; counts: number[] | null }> => {
          // An earlier window is only compared in total, so no member-by-member.
          if (byMember && logins.length <= MEMBER_COUNT_CAP) {
            const replies = await mapLimit(
              chunks(logins, MEMBERS_PER_QUERY),
              MEMBER_QUERIES_AT_ONCE,
              (batch) =>
                request<Record<string, { issueCount: number } | null>>(
                  `query {\n${batch
                    .map(
                      (login, i) =>
                        `m${i}: search(type: ISSUE, query: ${JSON.stringify(`is:pr is:merged merged:${range} org:${org} author:${login}`)}) { issueCount }`,
                    )
                    .join("\n")}\n}`,
                ).then((reply) => batch.map((_, i) => reply.data[`m${i}`]?.issueCount ?? 0)),
            );
            const counts = replies.flat();
            return { total: counts.reduce((sum, count) => sum + count, 0), counts };
          }
          const searches = mergedBySearches(range, org, logins);
          const text = `query {\n${searches
            .map((s, i) => `s${i}: search(type: ISSUE, query: ${JSON.stringify(s)}) { issueCount }`)
            .join("\n")}\n}`;
          const reply = await request<Record<string, { issueCount: number }>>(text);
          return {
            total: searches.reduce((sum, _, i) => sum + (reply.data[`s${i}`]?.issueCount ?? 0), 0),
            counts: null,
          };
        };
        const [inOrg, { total, counts }] = await Promise.all([mineInOrg(), membersMerged()]);
        return { merged: total, capped, members: logins.length, mineInOrg: inOrg, counts };
      };
      const [mineResult, team_] = await Promise.all([mine(), teamCount()]);
      return {
        ...mineResult,
        mergedByMeInTeamOrg: team_.mineInOrg,
        mergedByTeam: team_.merged,
        teamMembersCapped: team_.capped,
        teamMemberCount: team_.members,
        teamMemberMerged: team_.counts,
      };
    },

    async addMergeStates(pullRequests) {
      const candidates = pullRequests.filter(couldBeReady).map((pr) => pr.id);
      const states = await inBatches<{ id: string; mergeStateStatus: string }>(
        queries.mergeState,
        candidates,
      );
      const byId = new Map(states.map((state) => [state.id, state.mergeStateStatus]));
      for (const pr of pullRequests) pr.mergeStateStatus = byId.get(pr.id) ?? null;
    },

    async addRequiredChecks(pullRequests) {
      let asking: [string, string | null][] = pullRequests
        .filter(needsRequiredChecks)
        .map((pr) => [pr.id, null]);
      const found = new Map<string, RequiredCheck[]>();
      try {
        for (let page = 0; page < MAX_CHECK_PAGES && asking.length > 0; page++) {
          const replies = await mapLimit(chunks(asking, BATCH_SIZE), MAX_CONCURRENT, (batch) =>
            request<Record<string, RequiredChecksReply | null>>(requiredChecksQuery(batch)),
          );
          asking = [];
          for (const reply of replies.flatMap((r) => Object.values(r.data))) {
            if (!reply) continue;
            const [id, checks, next] = requiredPage(reply);
            found.set(id, [...(found.get(id) ?? []), ...checks]);
            if (next !== null) asking.push([id, next]);
          }
        }
      } catch (e) {
        console.warn("Could not tell which checks are required", e);
        return;
      }
      // A PR still being paged through when the limit hit has an incomplete list.
      const incomplete = new Set(asking.map(([id]) => id));
      for (const pr of pullRequests) {
        if (needsRequiredChecks(pr) && !incomplete.has(pr.id)) {
          pr.requiredChecks = found.get(pr.id) ?? null;
        }
      }
    },

    async fetchDirectory(needs) {
      const quote = (s: string) => JSON.stringify(s);
      const key = (org: string, slug: string) => `${org.toLowerCase()}/${slug.toLowerCase()}`;
      const queriesToRun = chunks(needs.teams, DIRECTORY_BATCH).map((batch) => ({
        text: `query {\n${batch
          .map(
            ([org, slug], i) =>
              `t${i}: organization(login: ${quote(org)}) { team(slug: ${quote(slug)}) { members(first: 100) { nodes { login } pageInfo { hasNextPage endCursor } } } }`,
          )
          .join("\n")}\n}`,
        aliases: batch.map(([org, slug], i) => ({ alias: `t${i}`, org, slug })),
      }));

      const replies = await mapLimit(queriesToRun, DIRECTORY_CONCURRENT, async (query) => ({
        query,
        reply: await request<Record<string, MembersData | null>>(query.text),
      }));

      const found: Found = { teams: {}, denied: false };
      for (const { query, reply } of replies) {
        if (reply.scopeMissing) return { teams: {}, denied: true };
        for (const { alias, org, slug } of query.aliases) {
          const members = reply.data[alias]?.team?.members;
          if (!members) continue;
          let { logins, next } = membersPage(members);
          for (let page = 1; page < MAX_MEMBER_PAGES && next; page++) {
            const more = await request<{ organization?: MembersData | null }>(MEMBERS_QUERY, {
              org,
              slug,
              after: next,
            });
            const extra = more.data.organization?.team?.members;
            if (!extra) break;
            const parsed = membersPage(extra);
            logins = logins.concat(parsed.logins);
            next = parsed.next;
          }
          found.teams[key(org, slug)] = logins;
        }
      }
      return found;
    },

    async scopes() {
      const response = await rest("GET", "/user");
      if (!response.ok) throw new FetchError("api", `GitHub returned HTTP ${response.status}`);
      return response.headers.get("x-oauth-scopes");
    },

    async gists(page) {
      const response = await rest("GET", `/gists?per_page=100&page=${page}`);
      if (!response.ok) throw gistFailure(response);
      return response.text();
    },

    async gist(id) {
      const response = await rest("GET", `/gists/${encodeURIComponent(id)}`);
      if (response.status === 404) return null;
      if (!response.ok) throw gistFailure(response);
      return response.text();
    },

    async createGist(body) {
      const response = await rest("POST", "/gists", body);
      if (!response.ok) throw gistFailure(response);
      const created: { id?: string } = await response.json();
      if (!created.id) throw new FetchError("api", "GitHub's reply had no gist id.");
      return created.id;
    },

    async updateGist(id, body) {
      const response = await rest("PATCH", `/gists/${encodeURIComponent(id)}`, body);
      if (!response.ok) throw gistFailure(response);
    },
  };
  return github;
}

interface MembersData {
  team?: {
    members?: {
      nodes: ({ login?: string } | null)[];
      pageInfo?: { hasNextPage: boolean; endCursor: string | null };
    };
  } | null;
}

function membersPage(members: NonNullable<NonNullable<MembersData["team"]>["members"]>) {
  const logins = members.nodes.flatMap((node) => (node?.login ? [node.login.toLowerCase()] : []));
  const info = members.pageInfo;
  return { logins, next: info?.hasNextPage ? (info.endCursor ?? null) : null };
}

/** Whether the PR's checks fail, so which of them are required decides if that counts. Mirrors the core crate's `needs_required_checks`. */
export function needsRequiredChecks(pr: RawPullRequest): boolean {
  const commits = (pr.commits?.nodes ?? []).filter((node) => node !== null);
  const state = commits.at(-1)?.commit.statusCheckRollup?.state;
  return state === "FAILURE" || state === "ERROR";
}

/** Most pages of checks followed for one PR. Mirrors the core crate's `MAX_CHECK_PAGES`. */
const MAX_CHECK_PAGES = 5;

/**
 * Asks which of each PR's head-commit checks are required, and how each
 * stands. `isRequired` needs the PR it's asked about, which a query over many
 * PRs can't pass along, so each PR gets its own aliased lookup, after the
 * cursor given for it when its checks span pages. Mirrors the core crate's
 * `required_checks_query`.
 */
export function requiredChecksQuery(lookups: [id: string, cursor: string | null][]): string {
  const body = lookups
    .map(([id, cursor], i) => {
      // JSON quoting is GraphQL string quoting, and an id can't break out of it.
      const quoted = JSON.stringify(id);
      const after = cursor === null ? "" : `, after: ${JSON.stringify(cursor)}`;
      return `  r${i}: node(id: ${quoted}) { ... on PullRequest { id commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100${after}) { pageInfo { hasNextPage endCursor } nodes { __typename ... on CheckRun { name status conclusion isRequired(pullRequestId: ${quoted}) } ... on StatusContext { context state isRequired(pullRequestId: ${quoted}) } } } } } } } } }\n`;
    })
    .join("");
  return `query RequiredChecks {\n${body}}`;
}

export type RequiredCheck = { name: string; outcome: "passed" | "running" | "failed" };

interface RequiredChecksReply {
  id: string;
  commits?: {
    nodes: ({
      commit: {
        statusCheckRollup?: {
          contexts?: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: ({
              name?: string;
              status?: string;
              conclusion?: string | null;
              context?: string;
              state?: string;
              isRequired?: boolean;
            } | null)[];
          } | null;
        } | null;
      };
    } | null)[];
  } | null;
}

/**
 * The PR's id, the required checks on this page, and the cursor to ask for
 * the next page with, when there is one. Mirrors `RequiredChecksReply::page`.
 */
export function requiredPage(reply: RequiredChecksReply): [string, RequiredCheck[], string | null] {
  const contexts = (reply.commits?.nodes ?? []).flatMap(
    (node) => node?.commit.statusCheckRollup?.contexts ?? [],
  )[0];
  const checks = (contexts?.nodes ?? []).flatMap((c): RequiredCheck[] => {
    if (!c?.isRequired) return [];
    const name = c.name ?? c.context;
    if (name === undefined) return [];
    let outcome: RequiredCheck["outcome"];
    if (c.status !== undefined) {
      if (c.status !== "COMPLETED") outcome = "running";
      else if (["SUCCESS", "SKIPPED", "NEUTRAL"].includes(c.conclusion ?? "")) outcome = "passed";
      else outcome = "failed";
    } else if (c.state === "SUCCESS") outcome = "passed";
    else if (c.state === "FAILURE" || c.state === "ERROR") outcome = "failed";
    else outcome = "running";
    return [{ name, outcome }];
  });
  const next = contexts?.pageInfo.hasNextPage ? contexts.pageInfo.endCursor : null;
  return [reply.id, checks, next];
}

/**
 * Approved, mergeable, green, and not already auto-merging: the only PRs
 * whose ready-to-merge verdict depends on `mergeStateStatus`. Mirrors the
 * other conditions of the rule in the core crate's `prs::actions`.
 */
export function couldBeReady(pr: RawPullRequest): boolean {
  const approved =
    pr.reviewDecision === "APPROVED" ||
    (pr.reviewDecision == null &&
      (pr.latestOpinionatedReviews?.nodes ?? []).some((review) => review?.state === "APPROVED"));
  const commits = (pr.commits?.nodes ?? []).filter((node) => node !== null);
  const rollup = commits.at(-1)?.commit.statusCheckRollup;
  const checksOk = rollup == null || rollup.state === "SUCCESS";
  return (
    approved &&
    checksOk &&
    !pr.isDraft &&
    pr.mergeable !== "CONFLICTING" &&
    pr.autoMergeRequest == null &&
    pr.mergeQueueEntry == null
  );
}
