import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PrDetailsData } from "@review-pinger/app";
import { descriptionPreview, timelineSpans } from "../../../packages/app/src/details.ts";

const at = (s: string) => Date.parse(s);
const NOW = at("2026-10-10T12:00:00Z");
const PR_URL = "https://github.com/o/r/pull/1";

const data = (overrides: Partial<PrDetailsData> = {}): PrDetailsData => ({
  body: "",
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  createdAt: "2026-10-01T09:00:00Z",
  mergedAt: null,
  closedAt: null,
  isDraft: false,
  author: { login: "me" },
  files: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
  baseRef: null,
  reviewRequests: { nodes: [] },
  events: { nodes: [] },
  activity: { nodes: [] },
  ...overrides,
});

const user = (login: string) => ({ __typename: "User" as const, login });
const names = (spans: ReturnType<typeof timelineSpans>) =>
  spans.filter((s) => s.kind !== "EVENT").map((s) => s.name);
const eventsOf = (spans: ReturnType<typeof timelineSpans>, parent: string) =>
  spans.filter((s) => s.parentSpanId === parent).map((s) => s.name);

describe("timelineSpans", () => {
  it("is the PR alone, opened for review, when nobody has done anything", () => {
    const spans = timelineSpans(data(), NOW, PR_URL);
    assert.deepEqual(names(spans), ["PR Timeline"]);
    assert.deepEqual(eventsOf(spans, "pr"), ["Opened"]);
    // The PR's own milestones open the PR.
    assert.equal(spans.find((s) => s.parentSpanId === "pr")?.attributes?.url, PR_URL);
    // Runs until now while it's open.
    assert.equal((spans[0] as { endTimeMs: number }).endTimeMs, NOW);
  });

  it("marks when a PR opened as a draft was marked ready, and ends at the merge", () => {
    const spans = timelineSpans(
      data({
        mergedAt: "2026-10-03T09:00:00Z",
        events: {
          nodes: [{ __typename: "ReadyForReviewEvent", createdAt: "2026-10-02T09:00:00Z" }],
        },
      }),
      NOW,
      PR_URL,
    );
    assert.deepEqual(eventsOf(spans, "pr"), ["Opened as draft", "Ready for review", "Merged"]);
    assert.equal((spans[0] as { endTimeMs: number }).endTimeMs, at("2026-10-03T09:00:00Z"));
  });

  it("puts code owners first, each with their comments and approval, bar running to the approval", () => {
    const spans = timelineSpans(
      data({
        reviewRequests: {
          nodes: [
            { asCodeOwner: true, requestedReviewer: user("zed") },
            { asCodeOwner: true, requestedReviewer: user("ann") },
          ],
        },
        activity: {
          nodes: [
            { __typename: "IssueComment", createdAt: "2026-10-02T09:00:00Z", url: "https://github.com/o/r/pull/1#issuecomment-1", author: user("ann") },
            {
              __typename: "PullRequestReview",
              state: "APPROVED",
              submittedAt: "2026-10-03T09:00:00Z",
              url: "https://github.com/o/r/pull/1#pullrequestreview-1",
              author: user("ann"),
              comments: { nodes: [{ createdAt: "2026-10-03T08:59:00Z", url: "https://github.com/o/r/pull/1#discussion_r1" }] },
            },
            // The author's own comment is not a reviewer's, and a bot's isn't a person's.
            { __typename: "IssueComment", createdAt: "2026-10-02T10:00:00Z", url: "u", author: user("me") },
            { __typename: "IssueComment", createdAt: "2026-10-02T11:00:00Z", url: "u", author: user("ci[bot]") },
          ],
        },
      }),
      NOW,
      PR_URL,
    );
    assert.deepEqual(names(spans), ["PR Timeline", "ann · code owner", "zed · code owner"]);
    assert.deepEqual(eventsOf(spans, "person:ann"), ["Commented", "Commented", "Approved"]);
    const ann = spans.find((s) => s.spanId === "person:ann") as { startTimeMs: number; endTimeMs: number };
    // From when the PR was ready for review (here: opened ready).
    assert.equal(ann.startTimeMs, at("2026-10-01T09:00:00Z"));
    assert.equal(ann.endTimeMs, at("2026-10-03T09:00:00Z"));
    // Still being waited on: runs to now.
    const zed = spans.find((s) => s.spanId === "person:zed") as { endTimeMs: number };
    assert.equal(zed.endTimeMs, NOW);
  });

  it("shows other reviewers who acted after the code owners, and teams by their org/slug", () => {
    const spans = timelineSpans(
      data({
        reviewRequests: {
          nodes: [
            {
              asCodeOwner: true,
              requestedReviewer: { __typename: "Team", slug: "core", organization: { login: "Acme" } },
            },
          ],
        },
        activity: {
          nodes: [
            {
              __typename: "PullRequestReview",
              state: "CHANGES_REQUESTED",
              submittedAt: "2026-10-02T09:00:00Z",
              url: "https://github.com/o/r/pull/1#pullrequestreview-2",
              author: user("bo"),
              comments: { nodes: [] },
            },
          ],
        },
      }),
      NOW,
      PR_URL,
    );
    assert.deepEqual(names(spans), ["PR Timeline", "@Acme/core · code owner", "bo"]);
    assert.deepEqual(eventsOf(spans, "person:bo"), ["Requested changes"]);
    // A marker opens its own item on GitHub.
    const change = spans.find((s) => s.parentSpanId === "person:bo");
    assert.equal(change?.attributes?.url, "https://github.com/o/r/pull/1#pullrequestreview-2");
  });
});

describe("descriptionPreview", () => {
  it("drops template comments and cuts after a few lines", () => {
    const body = `<!-- fill this in -->\n${Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n")}`;
    const { text, cut } = descriptionPreview(body, 3);
    assert.equal(text, "line 0\nline 1\nline 2");
    assert.equal(cut, true);
    assert.deepEqual(descriptionPreview("short", 3), { text: "short", cut: false });
  });
});
