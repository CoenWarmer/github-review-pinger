import { dayAndTime, elapsed } from "../format";
import type { ReviewRequest } from "../types";
import { REVIEWER_GLYPHS, REVIEWER_LABELS, ReviewerChip, SnoozeControl, visitPr } from "./PrRow";

export function ReviewRow({ pr, now }: { pr: ReviewRequest; now: number }) {
  const waiting = pr.waitingSince && `waiting ${elapsed(pr.waitingSince, now)}`;
  const reviewed = pr.reviewedAt && `reviewed ${elapsed(pr.reviewedAt, now)} ago`;

  return (
    <li className="pr">
      <button type="button" className="pr-main" onClick={() => visitPr(pr)}>
        <span className="pr-title">{pr.title}</span>
        <span className="pr-meta">
          {pr.repo}#{pr.number} · {pr.author}
          {waiting && ` · ${waiting}`}
          {!waiting && reviewed && ` · ${reviewed}`}
          {pr.snoozedUntil && ` · until ${dayAndTime(pr.snoozedUntil)}`}
        </span>
        {(pr.rerequested || pr.myState || pr.reviewers.length > 0) && (
          <span className="pr-badges">
            {pr.rerequested && <span className="badge badge-rerequested">Re-requested ↻</span>}
            {pr.myState && (
              <span
                className={`chip chip-${pr.myState}`}
                title={`You ${REVIEWER_LABELS[pr.myState]}`}
              >
                <span aria-hidden="true">{REVIEWER_GLYPHS[pr.myState]}</span>
                you
              </span>
            )}
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
