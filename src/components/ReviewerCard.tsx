import { useContext, type ReactNode } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { ago } from "../format";
import { SlackContext } from "../slack";
import type { Activity, Reviewer } from "../types";

/** Teams listed before "+N more". Few PRs have more owning teams than this. */
const MAX_TEAMS = 5;

const REVIEW_LABELS: Record<Exclude<Reviewer["state"], "pending">, string> = {
  approved: "Approved",
  changesRequested: "Requested changes",
  commented: "Commented",
};

const ACTIVITY_LABELS: Record<Activity["kind"], string> = {
  approved: "approved",
  changesRequested: "requested changes",
  commented: "commented",
  pushed: "pushed",
};

/** Shows what's known about a reviewer when hovering or focusing their chip. Bots get no card. */
export function ReviewerCard({
  reviewer,
  now,
  children,
}: {
  reviewer: Reviewer;
  now: number;
  children: ReactNode;
}) {
  if (reviewer.kind === "bot") return children;
  return (
    <HoverCard openDelay={300} closeDelay={0}>
      <HoverCardTrigger asChild>
        <span className="inline-flex">{children}</span>
      </HoverCardTrigger>
      {/* Not interactive: the card closes when the pointer leaves the chip. */}
      <HoverCardContent className="pointer-events-none w-60 p-3 text-xs" side="bottom">
        {reviewer.kind === "team" ? (
          <TeamDetails reviewer={reviewer} now={now} />
        ) : (
          <UserDetails reviewer={reviewer} now={now} />
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

function Line({ children }: { children: ReactNode }) {
  return <p className="m-0 mt-1 text-muted-foreground">{children}</p>;
}

function UserDetails({ reviewer, now }: { reviewer: Reviewer; now: number }) {
  const { state, at, requestedAt, teams } = reviewer;
  const review =
    state === "pending"
      ? requestedAt
        ? `Hasn't reviewed yet, requested ${ago(requestedAt, now)}`
        : "Hasn't reviewed yet"
      : at
        ? `${REVIEW_LABELS[state]} ${ago(at, now)}`
        : REVIEW_LABELS[state];

  return (
    <>
      <p className="m-0 text-sm font-medium">
        {reviewer.login}
        {teams.length > 0 && (
          <span className="font-normal text-muted-foreground">
            {" "}
            for {teams.slice(0, MAX_TEAMS).join(", ")}
            {teams.length > MAX_TEAMS && ` +${teams.length - MAX_TEAMS} more`}
          </span>
        )}
      </p>
      <Line>{review}</Line>
    </>
  );
}

function TeamDetails({ reviewer, now }: { reviewer: Reviewer; now: number }) {
  const { requestedAt, membersKnown, activity } = reviewer;
  const { channels } = useContext(SlackContext);
  const linked = reviewer.team !== null && reviewer.team in channels;
  return (
    <>
      <p className="m-0 text-sm font-medium">{reviewer.team ?? reviewer.login}</p>
      {requestedAt && <Line>Requested {ago(requestedAt, now)}</Line>}
      <Line>
        {!membersKnown
          ? "Team members unavailable"
          : activity
            ? `Last activity ${ago(activity.at, now)} by ${activity.login} (${ACTIVITY_LABELS[activity.kind]})`
            : "No response yet"}
      </Line>
      <Line>
        {linked
          ? "Click to open its Slack channel and copy the PR link. Shift-click to change it."
          : "Click to add its Slack channel."}
      </Line>
    </>
  );
}
