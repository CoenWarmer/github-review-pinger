import { useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { checksProgress, dayAndTime, elapsed, queueProgress, remaining } from "../format";
import type { Action, PullRequest, Reviewer, ReviewerState } from "../types";

/** Opens the PR on GitHub, and has it refreshed first the next time the popover shows. */
export function visitPr(pr: Pick<PullRequest, "id" | "url">) {
  invoke("visit", { id: pr.id });
  openUrl(pr.url);
}

const ACTION_LABELS: Record<Action, string> = {
  changesRequested: "Changes requested",
  newFeedback: "New feedback",
  conflicts: "Conflicts",
  ciFailing: "CI failing",
  readyToMerge: "Ready to merge",
};

export const REVIEWER_GLYPHS: Record<ReviewerState, string> = {
  approved: "✓",
  changesRequested: "✕",
  commented: "•",
  pending: "○",
};

export const REVIEWER_LABELS: Record<ReviewerState, string> = {
  approved: "approved",
  changesRequested: "requested changes",
  commented: "commented",
  pending: "review pending",
};

const SNOOZE_OPTIONS = [
  { days: 1, label: "1d" },
  { days: 3, label: "3d" },
  { days: 7, label: "1w" },
];

export function ReviewerChip({ reviewer }: { reviewer: Reviewer }) {
  const label = `${reviewer.login} ${REVIEWER_LABELS[reviewer.state]}${
    reviewer.rerequested ? ", re-requested" : ""
  }`;
  return (
    <span className={`chip chip-${reviewer.state}`} title={label}>
      <span aria-hidden="true">{REVIEWER_GLYPHS[reviewer.state]}</span>
      {reviewer.login}
      {reviewer.rerequested && <span aria-hidden="true"> ↻</span>}
    </span>
  );
}

export function SnoozeControl({ pr }: { pr: Pick<PullRequest, "id" | "snoozedUntil"> }) {
  const [choosing, setChoosing] = useState(false);

  if (pr.snoozedUntil) {
    return (
      <button type="button" className="link" onClick={() => invoke("unsnooze", { id: pr.id })}>
        Unsnooze
      </button>
    );
  }
  if (!choosing) {
    return (
      <button type="button" className="link" onClick={() => setChoosing(true)}>
        Snooze
      </button>
    );
  }
  return (
    <span className="snooze-options">
      {SNOOZE_OPTIONS.map(({ days, label }) => (
        <button
          key={days}
          type="button"
          className="link"
          aria-label={`Snooze for ${days} ${days === 1 ? "day" : "days"}`}
          onClick={() => invoke("snooze", { id: pr.id, days })}
        >
          {label}
        </button>
      ))}
      <button type="button" className="link" aria-label="Cancel" onClick={() => setChoosing(false)}>
        ✕
      </button>
    </span>
  );
}

export function PrRow({ pr, now }: { pr: PullRequest; now: number }) {
  const showActions =
    pr.group === "approved" || pr.group === "needsAction" || pr.group === "waiting";
  // Neutral context for why an approved PR isn't "ready to merge" yet.
  const progress = checksProgress(pr.checksStarted, pr.checksEstimateSecs, now);
  const runningFor = pr.checksStarted && elapsed(pr.checksStarted, now);
  const queueFill = pr.queued ? queueProgress(pr.mergeEnqueuedAt, pr.mergeEta, now) : null;
  const fill = (fraction: number | null) =>
    fraction !== null ? ({ "--progress": `${fraction * 100}%` } as CSSProperties) : undefined;
  const notes: { label: string; className: string; style?: CSSProperties; title?: string }[] =
    showActions
      ? [
          pr.checks === "pending" && {
            label: runningFor ? `Checks running · ${runningFor}` : "Checks running",
            className: `badge-checksRunning${progress !== null ? " badge-progress" : ""}`,
            style: fill(progress),
            title:
              pr.checksEstimateSecs && pr.checksStarted
                ? `Running for ${runningFor}, usually about ${Math.round(pr.checksEstimateSecs / 60)}m${
                    progress === 1 ? " (taking longer than usual)" : ""
                  }`
                : undefined,
          },
          pr.autoMerge && { label: "Auto-merge", className: "badge-autoMerge" },
          pr.queued && {
            label: [
              pr.mergeQueuePosition ? `Queued #${pr.mergeQueuePosition}` : "Queued",
              pr.mergeEta && remaining(pr.mergeEta, now),
            ]
              .filter(Boolean)
              .join(" · "),
            className: `badge-queued${queueFill !== null ? " badge-progress" : ""}`,
            style: fill(queueFill),
            title: pr.mergeEnqueuedAt
              ? `In the merge queue for ${elapsed(pr.mergeEnqueuedAt, now)}`
              : undefined,
          },
        ].filter((note) => note !== false)
      : [];

  return (
    <li className="pr">
      <button type="button" className="pr-main" onClick={() => visitPr(pr)}>
        <span className="pr-title">{pr.title}</span>
        <span className="pr-meta">
          {pr.repo}#{pr.number} · open {elapsed(pr.openSince, now)} · quiet{" "}
          {elapsed(pr.quietSince, now)}
          {pr.group === "dormant" && ` · idle ${elapsed(pr.lastActivity, now)}`}
          {pr.snoozedUntil && ` · until ${dayAndTime(pr.snoozedUntil)}`}
        </span>
        {((showActions && pr.actions.length > 0) || notes.length > 0 || pr.reviewers.length > 0) && (
          <span className="pr-badges">
            {showActions &&
              pr.actions.map((action) => (
                <span key={action} className={`badge badge-${action}`}>
                  {ACTION_LABELS[action]}
                </span>
              ))}
            {notes.map(({ label, className, style, title }) => (
              <span key={className} className={`badge ${className}`} style={style} title={title}>
                {label}
              </span>
            ))}
            {pr.reviewers.map((reviewer) => (
              <ReviewerChip key={reviewer.login} reviewer={reviewer} />
            ))}
          </span>
        )}
      </button>
      {pr.group !== "draft" && (
        <span className="pr-side">
          <SnoozeControl pr={pr} />
        </span>
      )}
    </li>
  );
}
