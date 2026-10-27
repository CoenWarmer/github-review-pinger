// Fetches pull requests from GitHub's GraphQL API, the way the desktop app's
// Rust code does: list the ids of the open PRs, fetch their details in
// concurrent batches, then fetch the expensive merge state only for the
// viewer's own PRs that could be ready to merge.

const ENDPOINT = "https://api.github.com/graphql";
const MAX_SEARCH_PAGES = 10;
/** Small enough that each request finishes well inside GitHub's ~10 s GraphQL timeout. */
const BATCH_SIZE = 10;
const MAX_CONCURRENT = 8;
const MAX_ATTEMPTS = 3;
/** Aliases per directory query, which keeps each query light. */
const DIRECTORY_BATCH = 15;
const DIRECTORY_CONCURRENT = 2;
/** Members are read 100 at a time, so this reads teams of up to 500. */
const MAX_MEMBER_PAGES = 5;

const AUTHORED = "is:pr is:open author:@me archived:false";
const REVIEW_REQUESTED = "is:pr is:open review-requested:@me -author:@me archived:false";

const MEMBERS_QUERY =
  "query($org: String!, $slug: String!, $after: String) { organization(login: $org) { team(slug: $slug) { members(first: 100, after: $after) { nodes { login } pageInfo { hasNextPage endCursor } } } } }";

/** The GraphQL documents, which the Rust code shares through the core crate. */
export interface Queries {
  search: string;
  /** The details query followed by the pull request fragment it uses. */
  details: string;
  mergeState: string;
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
  [field: string]: unknown;
}

export interface Fetched {
  viewer: string;
  /** Open PRs the viewer authored. */
  pullRequests: RawPullRequest[];
  /** Open PRs by others that the viewer is asked to review or already reviewed. */
  reviewPullRequests: RawPullRequest[];
  /** GitHub left out orgs whose SSO the token isn't authorized for. */
  ssoPartial: boolean;
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

export interface Github {
  fetchOpenPullRequests(reviewedSince: string): Promise<Fetched>;
  fetchDetails(ids: string[]): Promise<RawPullRequest[]>;
  addMergeStates(pullRequests: RawPullRequest[]): Promise<void>;
  fetchDirectory(needs: Needs): Promise<Found>;
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
    async fetchOpenPullRequests(reviewedSince) {
      const reviewed = `is:pr is:open reviewed-by:@me -author:@me archived:false updated:>=${reviewedSince}`;
      const [authored, requested, reviewedByMe] = await Promise.all([
        searchIds(AUTHORED),
        searchIds(REVIEW_REQUESTED),
        searchIds(reviewed),
      ]);
      const authoredIds = new Set(authored.ids);
      const requestedIds = new Set(requested.ids);
      // A PR can be both requested and reviewed (a re-request), so dedupe.
      const ids = [...new Set([...authored.ids, ...requested.ids, ...reviewedByMe.ids])];

      const all = await github.fetchDetails(ids);
      const pullRequests = all.filter((pr) => authoredIds.has(pr.id));
      const reviewPullRequests = all.filter((pr) => !authoredIds.has(pr.id));
      for (const pr of reviewPullRequests) pr.reviewRequested = requestedIds.has(pr.id);

      await github.addMergeStates(pullRequests);
      return {
        viewer: authored.viewer,
        pullRequests,
        reviewPullRequests,
        ssoPartial: authored.ssoPartial || requested.ssoPartial || reviewedByMe.ssoPartial,
      };
    },

    fetchDetails: (ids) => inBatches<RawPullRequest>(queries.details, ids),

    async addMergeStates(pullRequests) {
      const candidates = pullRequests.filter(couldBeReady).map((pr) => pr.id);
      const states = await inBatches<{ id: string; mergeStateStatus: string }>(
        queries.mergeState,
        candidates,
      );
      const byId = new Map(states.map((state) => [state.id, state.mergeStateStatus]));
      for (const pr of pullRequests) pr.mergeStateStatus = byId.get(pr.id) ?? null;
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
