// Shapes what GitHub says about a PR into the rows of the "Details" timeline:
// the PR itself, then each code owner and anyone else who reviewed, with
// markers for what they did and when. Pure, so every host gets the same rows.

import type { OtelSpan } from "react-otel-trace-waterfall";
import type { DetailReviewer, PrDetailsData } from "./types";

/** What a marker on a row stands for; it decides the marker's colour. */
export type MarkerKind =
  | "opened"
  | "ready"
  | "draft"
  | "merged"
  | "closed"
  | "comment"
  | "approved"
  | "changes";

const MINUTE = 60_000;
/** Most reviewers shown beyond the code owners, so a busy PR stays readable. */
const MAX_OTHER_REVIEWERS = 6;

interface Person {
  key: string;
  label: string;
  codeOwner: boolean;
  /** Still asked to review: a request ends once they do. */
  pending: boolean;
  markers: { kind: MarkerKind; at: number; url: string }[];
}

function whoIs(
  reviewer: DetailReviewer | null,
): { key: string; label: string } | null {
  if (!reviewer) return null;
  if (reviewer.__typename === "User" && "login" in reviewer) {
    return { key: reviewer.login.toLowerCase(), label: reviewer.login };
  }
  if (reviewer.__typename === "Team" && "slug" in reviewer) {
    const name = `${reviewer.organization.login}/${reviewer.slug}`;
    return { key: name.toLowerCase(), label: `@${name}` };
  }
  return null;
}

const isBot = (login: string) => login.endsWith("[bot]");

/** The spans to draw: one per row, with the markers as `EVENT` children folded onto it. */
export function timelineSpans(
  data: PrDetailsData,
  now: number,
  prUrl: string,
): OtelSpan[] {
  const created = Date.parse(data.createdAt);
  const finished = data.mergedAt ?? data.closedAt;
  const end = Math.max(finished ? Date.parse(finished) : now, created + MINUTE);

  const ready: number[] = [];
  const drafted: number[] = [];
  for (const event of data.events.nodes) {
    if (!event || !("createdAt" in event)) continue;
    const at = Date.parse(event.createdAt);
    if (event.__typename === "ReadyForReviewEvent") ready.push(at);
    else if (event.__typename === "ConvertToDraftEvent") drafted.push(at);
  }
  ready.sort((a, b) => a - b);
  // A PR opened as a draft has a first ready event; one opened ready has none.
  const openedAsDraft = ready.length > 0 && ready[0] > created;
  const firstReady = openedAsDraft ? ready[0] : created;

  const people = new Map<string, Person>();
  const person = (key: string, label: string): Person => {
    let found = people.get(key);
    if (!found) {
      found = {
        key,
        label,
        codeOwner: false,
        pending: false,
        markers: [],
      };
      people.set(key, found);
    }
    return found;
  };
  for (const request of data.reviewRequests.nodes) {
    const who = request && whoIs(request.requestedReviewer);
    if (!request || !who) continue;
    const owner = person(who.key, who.label);
    owner.pending = true;
    owner.codeOwner ||= request.asCodeOwner;
  }
  const author = data.author?.login.toLowerCase();
  const reviewerBy = (login: string | undefined) =>
    login && login.toLowerCase() !== author && !isBot(login)
      ? person(login.toLowerCase(), login)
      : null;
  for (const item of data.activity.nodes) {
    if (!item) continue;
    if (item.__typename === "IssueComment" && "createdAt" in item) {
      reviewerBy(item.author?.login)?.markers.push({
        kind: "comment",
        at: Date.parse(item.createdAt),
        url: item.url,
      });
    } else if (item.__typename === "PullRequestReview" && "state" in item) {
      if (!item.submittedAt) continue;
      const who = reviewerBy(item.author?.login);
      if (!who) continue;
      const at = Date.parse(item.submittedAt);
      const inline = item.comments.nodes.flatMap((comment) =>
        comment ? [comment] : [],
      );
      for (const comment of inline) {
        who.markers.push({
          kind: "comment",
          at: Date.parse(comment.createdAt),
          url: comment.url,
        });
      }
      if (item.state === "APPROVED")
        who.markers.push({ kind: "approved", at, url: item.url });
      else if (item.state === "CHANGES_REQUESTED")
        who.markers.push({ kind: "changes", at, url: item.url });
      else if (item.state === "COMMENTED" && inline.length === 0) {
        who.markers.push({ kind: "comment", at, url: item.url });
      }
    }
  }

  const spans: OtelSpan[] = [];
  // What a marker opens on GitHub: the comment or review, and for the PR's own milestones the PR.
  const marker = (
    parent: string,
    kind: MarkerKind,
    name: string,
    at: number,
    url: string,
    status?: "OK" | "ERROR",
  ) => {
    spans.push({
      traceId: "pr",
      spanId: `${parent}:${kind}:${at}`,
      parentSpanId: parent,
      name,
      kind: "EVENT",
      startTimeMs: at,
      endTimeMs: at,
      attributes: { kind, at: new Date(at).toISOString(), url },
      ...(status ? { status: { code: status } } : {}),
    });
  };

  spans.push({
    traceId: "pr",
    spanId: "pr",
    name: "PR Timeline",
    kind: "INTERNAL",
    startTimeMs: created,
    endTimeMs: end,
  });
  marker(
    "pr",
    "opened",
    openedAsDraft ? "Opened as draft" : "Opened",
    created,
    prUrl,
  );
  if (openedAsDraft) marker("pr", "ready", "Ready for review", ready[0], prUrl);
  for (const at of ready.slice(openedAsDraft ? 1 : 0))
    marker("pr", "ready", "Ready for review", at, prUrl);
  for (const at of drafted)
    marker("pr", "draft", "Converted to draft", at, prUrl);
  if (finished) {
    const name = data.mergedAt ? "Merged" : "Closed";
    marker(
      "pr",
      data.mergedAt ? "merged" : "closed",
      name,
      Date.parse(finished),
      prUrl,
    );
  }

  const rows = [...people.values()].filter(
    (p) => p.codeOwner || p.markers.length > 0,
  );
  for (const row of rows) row.markers.sort((a, b) => a.at - b.at);
  const owners = rows
    .filter((p) => p.codeOwner)
    .sort((a, b) => a.label.localeCompare(b.label));
  const others = rows
    .filter((p) => !p.codeOwner)
    .sort((a, b) => a.markers[0].at - b.markers[0].at)
    .slice(0, MAX_OTHER_REVIEWERS);
  for (const row of [...owners, ...others]) {
    const last = row.markers[row.markers.length - 1]?.at;
    // Everyone's bar starts when the PR was ready for review, which is when the wait began.
    // The waterfall orders rows by start, so equal starts keep code owners first.
    const since = Math.min(firstReady, end - MINUTE);
    const approved = row.markers.some((m) => m.kind === "approved");
    // Someone still being waited on keeps their bar running to now.
    const until = Math.max(
      row.pending && !approved ? end : (last ?? since),
      since + MINUTE,
    );
    const id = `person:${row.key}`;
    spans.push({
      traceId: "pr",
      spanId: id,
      name: row.codeOwner ? `${row.label} · code owner` : row.label,
      kind: "INTERNAL",
      startTimeMs: since,
      endTimeMs: Math.min(until, end),
    });
    for (const { kind, at, url } of row.markers) {
      const name =
        kind === "approved"
          ? "Approved"
          : kind === "changes"
            ? "Requested changes"
            : "Commented";
      marker(
        id,
        kind,
        name,
        at,
        url,
        kind === "approved" ? "OK" : kind === "changes" ? "ERROR" : undefined,
      );
    }
  }
  return spans;
}

/** The first `lines` non-blank-leading lines of a description, and whether any were left out. */
export function descriptionPreview(
  body: string,
  lines = 8,
): { text: string; cut: boolean } {
  // Comments in a PR template are for whoever writes it, not whoever reads it.
  const text = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
  const all = text.split("\n");
  return all.length > lines
    ? { text: all.slice(0, lines).join("\n"), cut: true }
    : { text, cut: false };
}
