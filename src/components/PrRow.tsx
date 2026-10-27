import { useState, type CSSProperties } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { chipClass, fillStyle } from "./Chips";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { checksProgress, dayAndTime, elapsed, queueProgress, remaining } from "../format";
import { TeamChannelForm, TeamChip } from "../slack";
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

/** Matches the compact badges the rows have always used. */
export const BADGE_SIZE = "gap-[3px] px-1.5 py-0 text-[11px] leading-[18px] font-semibold";

const ACTION_VARIANTS: Record<Action, "danger" | "info" | "success"> = {
  changesRequested: "danger",
  newFeedback: "info",
  conflicts: "danger",
  ciFailing: "danger",
  readyToMerge: "success",
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

export function ReviewerChip({
  reviewer,
  prUrl,
  onAsk,
}: {
  reviewer: Reviewer;
  prUrl: string;
  /** Asks for a team's Slack channel, which a team chip links to. */
  onAsk: (team: string) => void;
}) {
  const label = `${reviewer.login} ${REVIEWER_LABELS[reviewer.state]}${
    reviewer.rerequested ? ", re-requested" : ""
  }`;
  if (reviewer.team) {
    return (
      <TeamChip
        team={reviewer.team}
        login={reviewer.rerequested ? `${reviewer.login} ↻` : reviewer.login}
        glyph={REVIEWER_GLYPHS[reviewer.state]}
        className={chipClass(reviewer.state)}
        title={label}
        prUrl={prUrl}
        onAsk={onAsk}
      />
    );
  }
  return (
    <span className={chipClass(reviewer.state)} title={label}>
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
      <Button
        type="button"
        variant="link"
        size="xs"
        onClick={() => invoke("unsnooze", { id: pr.id })}
      >
        Unsnooze
      </Button>
    );
  }
  if (!choosing) {
    return (
      <Button type="button" variant="link" size="xs" onClick={() => setChoosing(true)}>
        Snooze
      </Button>
    );
  }
  return (
    <span className="inline-flex">
      {SNOOZE_OPTIONS.map(({ days, label }) => (
        <Button
          key={days}
          type="button"
          variant="link"
          size="xs"
          aria-label={`Snooze for ${days} ${days === 1 ? "day" : "days"}`}
          onClick={() => invoke("snooze", { id: pr.id, days })}
        >
          {label}
        </Button>
      ))}
      <Button
        type="button"
        variant="link"
        size="xs"
        aria-label="Cancel"
        onClick={() => setChoosing(false)}
      >
        ✕
      </Button>
    </span>
  );
}

export function PrRow({ pr, now }: { pr: PullRequest; now: number }) {
  const [askingTeam, setAskingTeam] = useState<string | null>(null);
  const showActions =
    pr.group === "approved" || pr.group === "needsAction" || pr.group === "waiting";
  // Neutral context for why an approved PR isn't "ready to merge" yet.
  const progress = checksProgress(pr.checksStarted, pr.checksEstimateSecs, now);
  const runningFor = pr.checksStarted && elapsed(pr.checksStarted, now);
  const queueFill = pr.queued ? queueProgress(pr.mergeEnqueuedAt, pr.mergeEta, now) : null;
  const notes: {
    key: string;
    label: string;
    variant: "warning" | "success";
    style?: CSSProperties;
    title?: string;
  }[] = showActions
    ? [
        pr.checks === "pending" && {
          key: "checksRunning",
          label: runningFor ? `Checks running · ${runningFor}` : "Checks running",
          variant: "warning" as const,
          style: fillStyle(progress, "warning"),
          title:
            pr.checksEstimateSecs && pr.checksStarted
              ? `Running for ${runningFor}, usually about ${Math.round(pr.checksEstimateSecs / 60)}m${
                  progress === 1 ? " (taking longer than usual)" : ""
                }`
              : undefined,
        },
        pr.autoMerge && {
          key: "autoMerge",
          label: "Auto-merge",
          variant: "success" as const,
        },
        pr.queued && {
          key: "queued",
          label: [
            pr.mergeQueuePosition ? `Queued #${pr.mergeQueuePosition}` : "Queued",
            pr.mergeEta && remaining(pr.mergeEta, now),
          ]
            .filter(Boolean)
            .join(" · "),
          variant: "warning" as const,
          style: fillStyle(queueFill, "warning"),
          title: pr.mergeEnqueuedAt
            ? `In the merge queue for ${elapsed(pr.mergeEnqueuedAt, now)}`
            : undefined,
        },
      ].filter((note) => note !== false)
    : [];

  return (
    <li className="group relative border-b hover:bg-accent/50 focus-within:bg-accent/50">
      <button
        type="button"
        className="flex w-full cursor-pointer flex-col gap-[3px] border-0 bg-transparent px-3 py-2 text-left outline-none"
        onClick={() => visitPr(pr)}
      >
        <span className="truncate font-medium">{pr.title}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {pr.repo}#{pr.number} · open {elapsed(pr.openSince, now)} · quiet{" "}
          {elapsed(pr.quietSince, now)}
          {pr.group === "dormant" && ` · idle ${elapsed(pr.lastActivity, now)}`}
          {pr.snoozedUntil && ` · until ${dayAndTime(pr.snoozedUntil)}`}
        </span>
        {((showActions && pr.actions.length > 0) ||
          notes.length > 0 ||
          pr.reviewers.length > 0) && (
          <span className="flex flex-wrap gap-1">
            {showActions &&
              pr.actions.map((action) => (
                <Badge key={action} variant={ACTION_VARIANTS[action]} className={BADGE_SIZE}>
                  {ACTION_LABELS[action]}
                </Badge>
              ))}
            {notes.map(({ key, label, variant, style, title }) => (
              <Badge key={key} variant={variant} className={BADGE_SIZE} style={style} title={title}>
                {label}
              </Badge>
            ))}
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

/** Revealed on hover so rows stay uncluttered. */
export function RowActions({ pr }: { pr: Pick<PullRequest, "id" | "snoozedUntil"> }) {
  return (
    <span className="invisible absolute top-1.5 right-2 rounded-md border bg-popover px-1 text-xs group-focus-within:visible group-hover:visible">
      <SnoozeControl pr={pr} />
    </span>
  );
}
