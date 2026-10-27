import { useState } from "react";
import { dayAndTime, elapsed } from "../format";
import { TeamChannelForm } from "../slack";
import type { ReviewRequest } from "../types";
import { Badge } from "@/components/ui/badge";
import { chipClass } from "./Chips";
import {
  BADGE_SIZE,
  REVIEWER_GLYPHS,
  REVIEWER_LABELS,
  ReviewerChip,
  RowActions,
  visitPr,
} from "./PrRow";

export function ReviewRow({ pr, now }: { pr: ReviewRequest; now: number }) {
  const [askingTeam, setAskingTeam] = useState<string | null>(null);
  const waiting = pr.waitingSince && `waiting ${elapsed(pr.waitingSince, now)}`;
  const reviewed = pr.reviewedAt && `reviewed ${elapsed(pr.reviewedAt, now)} ago`;

  return (
    <li className="group relative border-b hover:bg-accent/50 focus-within:bg-accent/50">
      <button
        type="button"
        className="flex w-full cursor-pointer flex-col gap-[3px] border-0 bg-transparent px-3 py-2 text-left outline-none"
        onClick={() => visitPr(pr)}
      >
        <span className="truncate font-medium">{pr.title}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {pr.repo}#{pr.number} · {pr.author}
          {waiting && ` · ${waiting}`}
          {!waiting && reviewed && ` · ${reviewed}`}
          {pr.snoozedUntil && ` · until ${dayAndTime(pr.snoozedUntil)}`}
        </span>
        {(pr.rerequested || pr.myState || pr.reviewers.length > 0) && (
          <span className="flex flex-wrap gap-1">
            {pr.rerequested && (
              <Badge variant="info" className={BADGE_SIZE}>
                Re-requested ↻
              </Badge>
            )}
            {pr.myState && (
              <span className={chipClass(pr.myState)} title={`You ${REVIEWER_LABELS[pr.myState]}`}>
                <span aria-hidden="true">{REVIEWER_GLYPHS[pr.myState]}</span>
                you
              </span>
            )}
            {pr.reviewers.map((reviewer) => (
              <ReviewerChip
                key={reviewer.login}
                reviewer={reviewer}
                prUrl={pr.url}
                onAsk={setAskingTeam}
              />
            ))}
          </span>
        )}
      </button>
      {askingTeam && <TeamChannelForm team={askingTeam} onDone={() => setAskingTeam(null)} />}
      {pr.group !== "draft" && <RowActions pr={pr} />}
    </li>
  );
}
