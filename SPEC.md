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

1. A pasted PAT stored in the OS keychain, if present. Pasting one is an
   explicit override, typically for orgs the gh token isn't SSO-authorized for.
2. Otherwise `gh auth token --hostname github.com`. GUI apps don't inherit
   the shell's PATH, so Homebrew and other common install locations are
   checked explicitly.
3. If neither works, the popover shows a setup screen that names the problem
   and accepts a PAT. When GitHub omits SSO-protected results
   (`X-GitHub-SSO: partial-results`), a banner says so.

## Data

- One GraphQL query: `search(type: ISSUE, query: "is:pr is:open author:@me")`
  with, per PR: `isDraft`, `createdAt`, `reviewDecision`, `mergeable`, head
  commit `statusCheckRollup`, `reviewRequests` (users and teams), latest
  reviews, and timeline items (`ReadyForReviewEvent`, reviews, comments).
- Pages of 25. The query is heavy (about 5 s per page) and GitHub
  occasionally answers with a 502, so 5xx responses are retried twice.
- Poll every 2 minutes; also refresh when the popover opens and data is older
  than 30 s (wall-clock, so time asleep counts). Wait out rate limits until
  the reset time; back off exponentially (up to 10 min) on network and API
  errors. On failure, keep showing the last good data with a banner.

## Derived state

| Concept | Rule |
| --- | --- |
| **Open** clock | Since the latest `ReadyForReviewEvent`, falling back to `createdAt`. |
| **Quiet** clock | Since the last review or comment by someone other than the author, but never earlier than the open clock. Bots (`__typename: Bot`, `[bot]` logins, plus `ignoredLogins` in settings) never reset it. |
| **Changes requested** | A reviewer's latest opinionated review is `CHANGES_REQUESTED` and the author hasn't re-requested their review since (re-requesting hands the ball back). Falls back to `reviewDecision` when no such review is visible. |
| **Ready to merge** | (`reviewDecision == APPROVED`, or `reviewDecision == null` with ≥1 approval and no outstanding changes requested) and `mergeable == MERGEABLE` and no failing checks. |
| **CI failing** | Head commit `statusCheckRollup.state` is `FAILURE` or `ERROR`. |
| **Conflicts** | `mergeable == CONFLICTING`. |
| **Last activity** | The latest of: the last commit's `committedDate` (approximates the last push), the open clock, or a review or comment by any human, the author included. |
| **Dormant** | A non-draft PR whose last activity is older than `dormantAfterDays` (default 30). Listed in its own collapsed section, never counted or nudged. Any push or human comment revives it. |
| **Needs action** | Any of the four states above, excluding drafts, dormant, and snoozed PRs. |

## Tray icon

Shows the number of PRs needing action (title text on macOS, overlay badge
elsewhere). Zero means nothing to do.

## Popover

Grouped, top to bottom:

1. **Needs action**: ready to merge first, then changes requested,
   conflicts, CI failing; oldest quiet first within each.
2. **Waiting on review**: sorted by longest quiet first.
3. **Snoozed**: collapsed, ending soonest first, with the snooze end time.
4. **Dormant**: collapsed, most recently active first, with an `idle` time.
5. **Drafts**: collapsed and not counted.

Each row shows: repo, title, `open 6d · quiet 2d`, and one chip per reviewer
with their latest state. An approval or change request outranks a later
comment by the same reviewer. A team request shows as a pending `@team` chip
until a member reviews, after which that member's chip replaces it. Bots and
ignored logins only get a chip when explicitly requested (e.g. Copilot);
re-requested reviewers are marked ↻.

Clicking a row opens the PR in the default browser. Hovering a non-draft row
reveals Snooze (1 day, 3 days, 1 week), which moves it to Snoozed: out of the
count and never nudged, though new reviews still notify. Snoozed rows offer
Unsnooze.

The footer shows when data was refreshed, a Refresh button, and Settings:
launch at login (on by default in release builds) and the token form.

## Settings

`settings.json` in the app config directory (`~/Library/Application
Support/dev.coenwarmer.reviewpinger/` on macOS), re-read on every poll:

```json
{
  "ignoredLogins": ["kibanamachine", "elasticmachine"],
  "dormantAfterDays": 30,
  "nudgeAfterHours": 24
}
```

## Notifications

- One notification per new response from another human: an approval, a
  change request, or a comment (review or plain PR comment). Applies to every
  PR, snoozed and dormant included.
- Staleness nudge: once per quiet period for PRs in Waiting on review, after
  `nudgeAfterHours` (default 24) of weekday time in the local time zone.
  Weekdays count in full, so 24 hours is one working day; a Friday-afternoon
  PR is nudged Monday afternoon. A new response starts a new quiet period.
- More than 3 events in one poll are folded into a single summary
  ("2 approvals and 1 PR still waiting on review").
- The first poll after launch, or after a gap of more than 15 minutes (sleep,
  offline), sends one "While you were away" summary instead of replaying.
- The very first poll after install is silent: everything is marked seen and
  overdue PRs as nudged; the list itself shows what's pending.
- Seen responses, nudged quiet periods, and snoozes persist in `state.json`
  in the app data directory, written atomically. Closed PRs are pruned.

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
