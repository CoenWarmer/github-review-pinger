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
 * How long your merged PRs took to be approved, in milliseconds: from the
 * first review request to the last approval still in effect when it merged,
 * by someone other than `viewer`. That is when the final approval came in,
 * which includes every required code owner's: GitHub keeps no record of who
 * the code owners of a merged PR were, so this can't pick them out, and an
 * approval from someone who wasn't required counts too. PRs merged without a
 * request or without an approval don't count.
 */
export function averageApproval(sample: StatsData["sample"], viewer: string | null): Average {
  const times = sample.flatMap((pr) => {
    if (!pr.requestedAt) return [];
    const requested = Date.parse(pr.requestedAt);
    const approvals = pr.approvals
      .filter((approval) => approval.by !== null && approval.by.toLowerCase() !== viewer?.toLowerCase())
      .map((approval) => Date.parse(approval.at))
      // An approval from before the request can't be a response to it.
      .filter((at) => at >= requested);
    return approvals.length > 0 ? [Math.max(...approvals) - requested] : [];
  });
  return averageOf(times);
}

/**
 * When a merged PR was first ready for review: when it was opened, or for one
 * opened as a draft (its first draft event is a "ready") when it was first
 * marked ready.
 */
function firstReady(pr: StatsData["sample"][number]): number {
  const first = pr.draftEvents[0];
  return Date.parse(first?.kind === "ready" ? first.at : pr.createdAt);
}

/**
 * How long your merged PRs took from first being ready for review to being
 * merged, in milliseconds: the reviews, the CI and the merge queue together.
 * Time spent as a draft again after that counts, as it's time not yet merged.
 */
export function averageReadyToMerged(sample: StatsData["sample"]): Average {
  const times = sample
    .map((pr) => Date.parse(pr.mergedAt) - firstReady(pr))
    // Merged before it was ready can only be bad data.
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  return averageOf(times);
}

/**
 * Code owners per PR, over your open non-draft PRs: how many of the pending
 * review requests GitHub made because of CODEOWNERS. A request ends once the
 * owner reviews, so partly reviewed PRs count fewer.
 */
export function averageCodeOwners(prs: PullRequest[]): Average {
  return averageOf(reviewable(prs).map((pr) => pr.codeOwners ?? 0));
}

/** How a number moved since the window before it. */
export interface Change {
  direction: "up" | "down" | "same";
  /** "▲ 56 (was 4)", "▼ 3 (was 10)" or "same (was 7)". */
  text: string;
}

/** Whole numbers as they are, anything else to a tenth. */
function plain(n: number): string {
  return Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toString();
}

/**
 * How `current` compares with `previous`: the direction, the size of the
 * move, and what it was. Sizes under `tiny` (a rounding error, or under a
 * minute for durations) count as no change. The size, not a percentage, so a
 * jump from 4 to 60 doesn't read as "+1400%".
 */
export function change(
  current: number,
  previous: number,
  format: (n: number) => string = plain,
  tiny = 0.05,
): Change {
  const diff = current - previous;
  if (Math.abs(diff) < tiny) return { direction: "same", text: `same (was ${format(previous)})` };
  return diff > 0
    ? { direction: "up", text: `▲ ${format(diff)} (was ${format(previous)})` }
    : { direction: "down", text: `▼ ${format(-diff)} (was ${format(previous)})` };
}

/** PRs merged per team member, or null when there are no members to divide by. */
export function perMember(merged: number | null, members: number): number | null {
  return merged === null || members <= 0 ? null : merged / members;
}

/** The middle value (the mean of the two middle ones for an even count), or null for none. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 === 1
    ? sorted[Math.floor(middle)]
    : (sorted[middle - 1] + sorted[middle]) / 2;
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
