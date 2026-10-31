import type { Fetched, Progress, RawPullRequest } from "./github.ts";

/** A fetch with nothing in it yet, to build up from the first phase of a first load. */
export function emptyFetched(): Fetched {
  return {
    viewer: "",
    pullRequests: [],
    reviewPullRequests: [],
    viewPullRequests: {},
    ssoPartial: false,
  };
}

/**
 * Puts PRs fetched partway through a refresh into `base`, for display only,
 * the way the Rust `engine::apply_progress` does. Before the searches return
 * (`matches` is null) only PRs already in a list are replaced; afterwards new
 * ones are filed where the searches found them. Nothing is removed for no
 * longer matching: the complete fetch decides that.
 */
export function applyProgress(base: Fetched, progress: Progress): Fetched {
  const next: Fetched = {
    ...base,
    pullRequests: [...base.pullRequests],
    reviewPullRequests: [...base.reviewPullRequests],
    viewPullRequests: Object.fromEntries(
      Object.entries(base.viewPullRequests).map(([id, prs]) => [id, [...prs]]),
    ),
  };
  if (progress.viewer) {
    next.viewer = progress.viewer;
    next.ssoPartial = progress.ssoPartial;
  }
  const { matches } = progress;
  const found = matches && {
    authored: new Set(matches.authored),
    requested: new Set(matches.requested),
    reviewed: new Set(matches.reviewed),
    views: Object.entries(matches.views).map(([id, ids]) => [id, new Set(ids)] as const),
  };
  const previous = new Map(base.pullRequests.map((pr) => [pr.id, pr]));

  for (const fresh of progress.fresh) {
    // Merge states arrive last, so keep what's shown until they do; otherwise
    // a "Ready to merge" badge would vanish and come back.
    const pr: RawPullRequest =
      fresh.mergeStateStatus == null && previous.get(fresh.id)?.mergeStateStatus
        ? { ...fresh, mergeStateStatus: previous.get(fresh.id)!.mergeStateStatus }
        : fresh;
    const closed = pr.closed === true;
    // Each list gets its own copy: a flag set for one shouldn't leak into another.
    const place = (list: RawPullRequest[], add: boolean, copy: RawPullRequest) => {
      const at = list.findIndex((p) => p.id === pr.id);
      if (at !== -1) {
        if (closed) list.splice(at, 1);
        else list[at] = copy;
      } else if (add && !closed) list.push(copy);
    };

    for (const list of Object.values(next.viewPullRequests)) {
      place(list, false, { ...pr });
    }
    if (found) {
      for (const [id, ids] of found.views) {
        if (ids.has(pr.id)) {
          next.viewPullRequests[id] ??= [];
          place(next.viewPullRequests[id], true, { ...pr });
        }
      }
    }
    place(next.pullRequests, !!found?.authored.has(pr.id), { ...pr });
    const reviewed = !!found && (found.requested.has(pr.id) || found.reviewed.has(pr.id));
    const reviewPr = { ...pr };
    // Without the searches, a PR keeps whether it was requested; with them, it's known.
    const was = base.reviewPullRequests.find((p) => p.id === pr.id);
    reviewPr.reviewRequested = found ? found.requested.has(pr.id) : was?.reviewRequested;
    place(next.reviewPullRequests, reviewed && !found!.authored.has(pr.id), reviewPr);
  }
  return next;
}
