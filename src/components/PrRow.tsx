import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { dayAndTime, elapsed } from "../format";
import type { Action, PullRequest, Reviewer, ReviewerState } from "../types";

const ACTION_LABELS: Record<Action, string> = {
  changesRequested: "Changes requested",
  newFeedback: "New feedback",
  conflicts: "Conflicts",
  ciFailing: "CI failing",
  readyToMerge: "Ready to merge",
};

const REVIEWER_GLYPHS: Record<ReviewerState, string> = {
  approved: "✓",
  changesRequested: "✕",
  commented: "•",
  pending: "○",
};

const REVIEWER_LABELS: Record<ReviewerState, string> = {
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

function ReviewerChip({ reviewer }: { reviewer: Reviewer }) {
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

function SnoozeControl({ pr }: { pr: PullRequest }) {
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
  const showActions = pr.group === "needsAction" || pr.group === "waiting";

  return (
    <li className="pr">
      <button type="button" className="pr-main" onClick={() => openUrl(pr.url)}>
        <span className="pr-title">{pr.title}</span>
        <span className="pr-meta">
          {pr.repo}#{pr.number} · open {elapsed(pr.openSince, now)} · quiet{" "}
          {elapsed(pr.quietSince, now)}
          {pr.group === "dormant" && ` · idle ${elapsed(pr.lastActivity, now)}`}
          {pr.snoozedUntil && ` · until ${dayAndTime(pr.snoozedUntil)}`}
        </span>
        {((showActions && pr.actions.length > 0) || pr.reviewers.length > 0) && (
          <span className="pr-badges">
            {showActions &&
              pr.actions.map((action) => (
                <span key={action} className={`badge badge-${action}`}>
                  {ACTION_LABELS[action]}
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
