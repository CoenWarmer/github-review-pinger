# Review Pinger — v1 spec

A cross-platform tray app that shows, at a glance, the open pull requests you
authored on github.com, their per-reviewer review state, and how long they
have been open and waiting.

## Stack and platforms

- Tauri v2, React + TypeScript popover UI.
- macOS and Windows: tray-only (no Dock icon / taskbar entry). Left-clicking
  the tray icon toggles a popover anchored to the icon; it hides on blur.
  Right-click opens a menu with Quit.
- Linux (best effort): libappindicator does not emit tray click events, so
  the tray opens a native menu with the count, "Open PR list" (shows a normal
  decorated window), and Quit.
- Launch at login (Tauri autostart plugin), on by default with a toggle.

## Authentication

1. `gh auth token` (github.com only).
2. If `gh` is missing, logged out, or its token cannot see an SSO-protected
   org, the popover shows a setup screen that names the problem
   (`gh auth login`, "authorize SSO for org X") and accepts a pasted PAT,
   stored in the OS keychain.

## Data

- One GraphQL query: `search(type: ISSUE, query: "is:pr is:open author:@me")`
  with, per PR: `isDraft`, `createdAt`, `reviewDecision`, `mergeable`, head
  commit `statusCheckRollup`, `reviewRequests` (users and teams), latest
  reviews, and timeline items (`ReadyForReviewEvent`, reviews, comments).
- Poll every 2 minutes; also refresh when the popover opens and data is older
  than 30 s. Respect rate-limit headers with backoff; pause while asleep or
  offline.

## Derived state

| Concept | Rule |
| --- | --- |
| **Open** clock | Since the latest `ReadyForReviewEvent`, falling back to `createdAt`. |
| **Quiet** clock | Since the last review, review comment, or comment by someone other than the author. Bots (`__typename: Bot`, `[bot]` logins, plus a configurable ignore list) never reset it. |
| **Changes requested** | Any reviewer's latest review is `CHANGES_REQUESTED`. |
| **Ready to merge** | (`reviewDecision == APPROVED`, or `reviewDecision == null` with ≥1 approval and no outstanding changes requested) and `mergeable == MERGEABLE` and no failing checks. |
| **CI failing** | Head commit `statusCheckRollup.state` is `FAILURE` or `ERROR`. |
| **Conflicts** | `mergeable == CONFLICTING`. |
| **Needs action** | Any of the four states above, excluding drafts and snoozed PRs. |

## Tray icon

Shows the number of PRs needing action (title text on macOS, overlay badge
elsewhere). Zero means nothing to do.

## Popover

Grouped, top to bottom:

1. **Needs action**: changes requested, conflicts, CI failing, ready to merge.
2. **Waiting on review**: sorted by longest quiet first.
3. **Drafts**: muted and not counted.

Each row shows: repo, title, `open 6d · quiet 2d`, and one chip per reviewer
with their latest state. A team request shows as `@team · pending` until a
member reviews, after which that member's chip replaces it.

Clicking a row opens the PR in the default browser. A row can be snoozed for
N days, which mutes its nudges and removes it from the count.

## Notifications

- One notification per review event from others: approved, changes
  requested, commented.
- Staleness nudge: once per quiet period, after 24 business hours
  (configurable), skipping weekends, in the local time zone.
- After launch or a long gap, the first poll diffs against persisted state and
  sends a single "while you were away" summary instead of replaying events.
- Seen events, nudge state, and snoozes persist across restarts (Tauri store
  plugin).

## Distribution

- Unsigned builds from GitHub Actions for macOS, Windows, and Linux.
- macOS via a cask in a personal Homebrew tap. Users approve the app once in
  System Settings → Privacy & Security; Homebrew's `--no-quarantine` is
  deprecated and not relied upon.
- If the app goes public: Developer ID signing, notarization, the official
  cask, and the Tauri updater.

## Known risks

- Business-hours math across time zones and DST: unit-test from day one.
- Bots that post as regular users: covered by the ignore list.
- The unsigned macOS install step will deter non-technical users.

## Out of scope for v1

GitHub Enterprise Server, multiple accounts, repo/org exclude lists, an
in-app PR detail view.
