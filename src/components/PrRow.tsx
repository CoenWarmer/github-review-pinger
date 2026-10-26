import { openUrl } from "@tauri-apps/plugin-opener";
import { elapsed } from "../format";
import type { Action, PullRequest, Reviewer, ReviewerState } from "../types";

const ACTION_LABELS: Record<Action, string> = {
  changesRequested: "Changes requested",
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

export function PrRow({ pr, now }: { pr: PullRequest; now: number }) {
  return (
    <li>
      <button type="button" className="pr" onClick={() => openUrl(pr.url)}>
        <span className="pr-title">{pr.title}</span>
        <span className="pr-meta">
          {pr.repo}#{pr.number} · open {elapsed(pr.openSince, now)} · quiet{" "}
          {elapsed(pr.quietSince, now)}
          {pr.group === "dormant" && ` · idle ${elapsed(pr.lastActivity, now)}`}
        </span>
        {(pr.actions.length > 0 || pr.reviewers.length > 0) && (
          <span className="pr-badges">
            {pr.group !== "draft" &&
              pr.group !== "dormant" &&
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
    </li>
  );
}
