// The numbers in Settings' Statistics section, worked out from what's loaded.
// Pure, so every host gets the same answers.

import type { PullRequest, StatsData } from "./types";

/** How far back the merge counts and the merged-PR average look. */
export const STATS_DAYS = 30;

/** An average and how many PRs it's over; `average` is null with none. */
export interface Average {
  average: number | null;
  count: number;
}

function averageOf(values: number[]): Average {
  return {
    average: values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : null,
    count: values.length,
  };
}

/** Your open PRs that aren't drafts, the ones a review can be waited on. */
function reviewable(prs: PullRequest[]): PullRequest[] {
  return prs.filter((pr) => pr.group !== "draft");
}

/**
 * How long your open PRs have been waiting on a review, in milliseconds: for
 * each non-draft PR with a person or team still to review, the time since the
 * oldest of those requests (the PR's longest outstanding wait).
 */
export function averageWaitingNow(prs: PullRequest[], now: number): Average {
  const waits = reviewable(prs).flatMap((pr) => {
    const pending = pr.reviewers.filter((r) => r.state === "pending" && r.kind !== "bot");
    if (pending.length === 0) return [];
    // A request GitHub didn't date counts from when the PR opened.
    const since = Math.min(
      ...pending.map((r) => Date.parse(r.requestedAt ?? pr.openSince)),
    );
    return [Math.max(0, now - since)];
  });
  return averageOf(waits);
}

/**
 * How long reviews took on your merged PRs, in milliseconds: from the first
 * review request to the first review by someone else after it. PRs merged
 * without a request or without a review don't count.
 */
export function averageReviewWait(sample: StatsData["sample"], viewer: string | null): Average {
  const waits = sample.flatMap((pr) => {
    if (!pr.requestedAt) return [];
    const requested = Date.parse(pr.requestedAt);
    const answers = pr.reviews
      .filter((review) => review.by !== null && review.by.toLowerCase() !== viewer?.toLowerCase())
      .map((review) => Date.parse(review.at))
      .filter((at) => at >= requested);
    return answers.length > 0 ? [Math.min(...answers) - requested] : [];
  });
  return averageOf(waits);
}

/**
 * Code owners per PR, over your open non-draft PRs: how many of the pending
 * review requests GitHub made because of CODEOWNERS. A request ends once the
 * owner reviews, so partly reviewed PRs count fewer.
 */
export function averageCodeOwners(prs: PullRequest[]): Average {
  return averageOf(reviewable(prs).map((pr) => pr.codeOwners ?? 0));
}

/** PRs merged per team member, or null when there are no members to divide by. */
export function perMember(merged: number | null, members: number): number | null {
  return merged === null || members <= 0 ? null : merged / members;
}

/** "2d 4h", "5h 20m", "12m": a duration at a glance. */
export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}
