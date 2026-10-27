# Review Pinger — v1 spec

A cross-platform tray app that shows, at a glance, the open pull requests you
authored on github.com, their per-reviewer review state, and how long they
have been open and waiting, plus the pull requests waiting on your review.

## Stack and platforms

- Tauri v2, React + TypeScript popover UI, built with Tailwind v4 and shadcn/ui
  (components in `src/components/ui`, default neutral theme in light mode and a dark blue
  one in dark mode, following the system setting).
- macOS and Windows: tray-only (no Dock icon / taskbar entry). Left-clicking
  the tray icon toggles a popover anchored to the icon; it hides on blur.
  Right-click opens a menu with Quit.
- Linux (best effort): libappindicator does not emit tray click events, so
  the tray opens a native menu with the count, "Open PR list" (shows a normal
  decorated window), and Quit.
- Launch at login (Tauri autostart plugin), on by default with a toggle.

## Authentication

The user picks the token source in Settings: the GitHub CLI or a pasted PAT.
The choice is kept in `state.json` and never falls back to the other source,
so a problem with the chosen one is reported rather than hidden.

- **GitHub CLI**: `gh auth token --hostname github.com`. GUI apps don't
  inherit the shell's PATH, so Homebrew and other common install locations
  are checked explicitly.
- **Personal access token**: stored in the OS keychain. Useful for orgs the
  gh token isn't SSO-authorized for. Pasting a token selects it, and removing
  the saved token selects the CLI. Selecting the CLI keeps a saved token.
- **Before a choice is made**: a saved PAT wins over the CLI, so existing
  setups keep working.

If the chosen source doesn't work, the popover shows a setup screen that names
the problem and accepts a PAT (with a way back to the CLI when no token is
saved). When GitHub omits SSO-protected results (`X-GitHub-SSO:
partial-results`), a banner says so.

## Data

Each refresh takes three steps, because a single search query with every
field takes ~11 s per 25 PRs and regularly hits GitHub's ~10 s GraphQL
timeout:

1. Three `search(type: ISSUE, ...)` queries run concurrently, for ids only,
   100 per page (~3 s). All have `is:pr is:open archived:false`:
   - `author:@me`: your own PRs.
   - `review-requested:@me -author:@me`: PRs waiting on your review. GitHub
     matches requests made to you directly or to a team you belong to.
   - `reviewed-by:@me -author:@me updated:>=<date>`: PRs you've already
     reviewed, limited to those updated within `dormantAfterDays`, since the
     open PRs you ever reviewed would otherwise pile up.
2. `nodes(ids:)` for the details of the union of those ids, in batches of 10,
   up to 8 concurrently (~2 s each): `author`, `isDraft`, `createdAt`,
   `reviewDecision`, `mergeable`, `autoMergeRequest`, head commit
   `oid`, `committedDate` and `statusCheckRollup` (with timestamps of its
   first 50 contexts), `reviewRequests`, latest reviews
   (with `submittedAt`), and timeline items (ready-for-review,
   review-requested with the requested reviewer, reviews, comments). Each PR
   is then filed under "yours" or "review", and "review" PRs remember
   whether they came back from the `review-requested` search.
3. `mergeStateStatus` only for your own PRs that could be ready to merge
   (approved, green, mergeable, no auto-merge), since GitHub computes it on
   demand and it doubles a PR's cost.

A refresh takes ~5–8 s for ~70 PRs (previously ~38 s), more with the review
searches. 5xx responses are
retried twice per request.

- Clicking a row remembers that PR (in memory only). The next time the popover
  opens, those PRs are refetched on their own (details, plus merge state for
  your own) and patched into the lists, so what you just did on GitHub shows
  up in about a second; merged or closed ones disappear. Only then does the
  full refresh below run. The single refresh sends no notifications, which
  stay with the full poll. For a review-request PR, whether it's still
  requested is inferred: you're listed directly, or a team is and it was
  requested through it before.
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
| **Approved** | `reviewDecision == APPROVED`, or `reviewDecision == null` (no required reviews) with ≥1 approval. |
| **Ready to merge** | Approved, no outstanding changes requested, checks passed (or none run), `mergeStateStatus` is `CLEAN` or `HAS_HOOKS` (branch protection satisfied), auto-merge is off, and it isn't in the merge queue. Approved PRs with running checks, auto-merge enabled, or a merge queue entry wait instead, labeled "Checks running · 12m" (yellow), "Auto-merge" (green), or "Queued #N · ~29m" (yellow; queue position and GitHub's `estimatedTimeToMerge`, counted down between polls). The checks badge shows the time since the checks started and, once an estimate is known (see Check duration), fills left to right like a progress bar, full when it overruns; its tooltip gives the usual duration. The queued badge fills the same way, from when the PR entered the queue to GitHub's estimated merge time. |
| **CI failing** | Head commit `statusCheckRollup.state` is `FAILURE` or `ERROR`. |
| **New feedback** | Another human's comment (a comment review, inline or not, or a plain PR comment) is newer than the author's last push, own comment or reply, or review request. Approvals and change requests don't trigger it, and it's suppressed while changes are requested. |
| **Conflicts** | `mergeable == CONFLICTING`. |
| **Last activity** | The latest of: the last commit's `committedDate` (approximates the last push), the open clock, or a review or comment by any human, the author included. |
| **Dormant** | A non-draft PR whose last activity is older than `dormantAfterDays` (default 30). Listed in its own collapsed section, never counted or nudged. Any push or human comment revives it. |
| **Needs action** | Any of the five states above, excluding drafts, dormant, and snoozed PRs. Counted in the tray whether the PR sits in Approved or Needs your action. |

### Review requests

PRs by others that involve you, derived separately from the rules above. They
come from the `review-requested` and `reviewed-by` searches and exclude PRs
you authored.

| Concept | Rule |
| --- | --- |
| **Requested** | The PR came back from the `review-requested:@me` search: you or one of your teams is a pending reviewer. |
| **Waiting since** | When it became your turn: the latest review-request event naming you, if you're a pending reviewer yourself, otherwise the latest one naming a team. Never earlier than the open clock, and the open clock when no event is visible. |
| **Re-requested** | Requested, and you've already submitted a review. |
| **Reviewed** | Your latest submitted review (approval, change request, or comment). Dismissed and pending reviews don't count. |

PRs that are neither requested nor reviewed by you are dropped. Groups, in
order:

1. **Needs your review**: requested, not a draft, not snoozed. Longest
   waiting first.
2. **Waiting on author**: reviewed by you but no longer requested, whatever
   your verdict, until the PR merges or closes. Most recently active first.
   A new request moves it back to Needs your review.
3. **Snoozed**: collapsed, most recently active first.
4. **Drafts**: collapsed and not counted.

Only **Needs your review** is counted. Other reviewers' chips use the same
rules as your own PRs, leaving out you and the author.

### Check duration

GitHub says when checks started, not how long they will take, so the app
learns it. Each poll follows the head commit's checks of your own PRs:

- **Start:** the earliest check run `startedAt`, or the `createdAt` of a
  pending commit status. External CI such as Buildkite reports commit
  statuses, whose `createdAt` is when the status last changed: the start
  while pending, the finish once settled.
- **Run:** first seen pending, the run is remembered with its commit and
  start. A new push, or pending again after finishing (a retry), starts a
  new run.
- **Sample:** when a remembered run settles as passing, its duration (the
  latest finish minus the remembered start) is recorded for the repo. Failed
  runs, runs first seen already done, and durations under 30 s or over 6 h
  are not, since they would skew the estimate. The last 10 per repo are kept
  in `state.json`.
- **Estimate:** the median of a repo's samples once it has 3, otherwise
  `checkDurations` from settings (minutes, by `owner/repo`), otherwise the
  median of whatever samples exist, otherwise none.

## Tray icon

Shows two numbers, PRs needing your action and reviews needing you, as title
text, for example `3 · 2` (macOS and Linux; Windows only has the tooltip,
which spells both out). Both are always shown, so position is the cue; when
both are zero there is no title at all.

## Popover

Three tabs: **My PRs** and **Review Requests**, each with a count badge (the
numbers in the tray), and **Settings**, shown as a cog icon at the end of the tab bar. The tab choice is not remembered
between openings.

### My PRs

Grouped, top to bottom. Within every section the stalest PRs are at the
bottom:

1. **Approved**: every approved PR (per the rule above) that isn't a draft,
   snoozed, or dormant, keeping its action badges. Ready to merge first, then
   other actions, then those waiting on checks or auto-merge; most recently
   active first within each.
2. **Needs your action**: ready to merge first, then changes requested, new
   feedback, conflicts, CI failing; most recently active first within each.
3. **Waiting on others**: reviews, running checks, or auto-merge; sorted by
   most recently active first.
4. **Snoozed**: collapsed, most recently active first, with the snooze end
   time.
5. **Dormant**: collapsed, most recently active first, with an `idle` time.
6. **Drafts**: collapsed and not counted.

Each row shows: repo, title, `open 6d · quiet 2d`, and one chip per reviewer
with their latest state. An approval or change request outranks a later
comment by the same reviewer. A team request shows as a pending `@team` chip
until a member reviews, after which that member's chip replaces it. Bots and
ignored logins only get a chip when explicitly requested (e.g. Copilot);
re-requested reviewers are marked ↻.

A team chip (`@team`) links to the team's Slack channel, on both tabs, so you
can ask the team for a review. Clicking it copies the PR's link to the
clipboard and opens the channel, in the Slack app or the browser per
`slackOpensIn`; the chip shows "✓ copied" briefly. A team without a channel
asks for one inline on first click: paste a Slack channel link and it's saved
to `state.json` and used from then on. Shift-clicking a team chip asks again,
to change a saved channel. Channels in `settings.json` take precedence over
saved ones. Teams are keyed by `org/team-slug`, lowercased, since slugs are
only unique within an organization. Accepted links are Slack channel links on
`slack.com` (`https://app.slack.com/client/T…/C…` or
`https://<workspace>.slack.com/archives/C…`) and `slack://` links; anything
else is rejected, so nothing arbitrary gets opened. For the app, the client
form becomes `slack://channel?team=T…&id=C…`; an `archives` link is opened as is and
Slack offers to switch to the app. Slack can't pre-fill a message, which is why
the link goes on the clipboard.

Clicking a row opens the PR in the default browser. Hovering a non-draft row
reveals Snooze (1 day, 3 days, 1 week), which moves it to Snoozed: out of the
count and never nudged, though new reviews still notify. Snoozed rows offer
Unsnooze.

### Review Requests

The groups above, as sections. Each row shows repo, title, author, and
`waiting 2d` (the waiting-since clock) for requested PRs or `reviewed 3d ago`
for the rest, a `↻ re-requested` badge, your own verdict chip, and the other
reviewers' chips. Rows can be snoozed like your own: out of the count and
never nudged, though a new request still notifies.

Every section header has a sort icon, on both tabs. It offers Default (the
order above), Oldest first and Newest first (by open clock), Recently active,
and Repository. The choice is per section and remembered across restarts in
the webview's local storage; the icon is highlighted when it isn't Default.

While the first load is in progress the popover shows a halftone sphere (an
11 x 11 grid of dots sized by their distance from an orbiting light, after the
Halftone Sphere pattern on bookofshapes.com by Nikolaj Sokolowski) above
"Loading pull requests…". It holds still when the system asks for reduced
motion.

The footer shows when data was refreshed and a refresh icon button, which spins while refreshing.

### Settings

The third tab holds, top to bottom:

- A **Startup** section with Launch at login (on by default in release builds).
- A **Notifications** section: a mute switch for the cards and a "Send test
  notification" button.
- An **Authentication** section: a GitHub CLI / Personal access token
  selector, who is signed in ("Signed in as CoenWarmer"), and the token form
  when the token is selected. With the CLI selected, a saved token is noted
  as kept but unused.
- **Slack channels**: every team with a configured channel, as the team name
  and its link, labeled "settings.json" or "saved". Saved channels (pasted
  into a team chip) can be clicked to change their link in place, and have a
  Remove button, after which the chip asks for a channel again. Channels from `settings.json` are read-only here, and one
  there overrides a saved one for the same team, so only it is listed. Teams
  are added by clicking their chip.

## Settings

`settings.json` in the app config directory (`~/Library/Application
Support/dev.coenwarmer.reviewpinger/` on macOS), re-read on every poll:

```json
{
  "ignoredLogins": ["kibanamachine", "elasticmachine"],
  "dormantAfterDays": 30,
  "nudgeAfterHours": 24,
  "reviewNudgeAfterHours": 24,
  "checkDurations": { "elastic/kibana": 45 },
  "teamChannels": {
    "elastic/kibana-operations": "https://app.slack.com/client/T0123/C0456"
  },
  "slackOpensIn": "app"
}
```

`teamChannels` maps `org/team-slug` to a Slack channel link, and
`slackOpensIn` is `"app"` (default) or `"browser"`.

`checkDurations` seeds the check duration estimate, in minutes, until enough
runs have been timed.

`reviewNudgeAfterHours` is the same threshold as `nudgeAfterHours`, for PRs
waiting on you.

## Notifications

- One notification per new response from another human: an approval, a
  change request, or a comment (review or plain PR comment). Applies to every
  PR, snoozed and dormant included.
- Staleness nudge: once per quiet period for unapproved PRs in Waiting on
  others (approved ones wait on checks, not people), after
  `nudgeAfterHours` (default 24) of weekday time in the local time zone.
  Weekdays count in full, so 24 hours is one working day; a Friday-afternoon
  PR is nudged Monday afternoon. A new response starts a new quiet period.
- One notification when someone requests your review, or re-requests it
  after you've reviewed ("ana requested your review"). Applies to snoozed
  PRs too, not drafts.
- Review nudge: once per waiting period for PRs in Needs your review, after
  `reviewNudgeAfterHours` (default 24) of weekday time since waiting-since,
  counted like the staleness nudge. A re-request starts a new waiting period.
  Reviews you merely participate in don't notify about other people's
  responses.
- More than 3 events in one poll are folded into a single summary
  ("2 approvals and 1 PR still waiting on review"); review requests count as
  "review requests" and review nudges as "PRs still waiting on your review".
- The first poll after launch, or after a gap of more than 15 minutes (sleep,
  offline), sends one "While you were away" summary instead of replaying.
- The very first poll after install is silent: everything is marked seen and
  overdue PRs (including ones waiting on you) as nudged; the list itself shows what's pending.

### Notification cards

Notifications are shown as a small in-app card, not an OS notification, so
they match the app's look. This replaces the native notification plugin, so
macOS Focus and the OS notification permission don't apply. The card has its
own mute switch instead.

- **Window**: a frameless, transparent, always-on-top window (380 px wide,
  height follows the content) with rounded corners, created hidden and shown
  without taking focus. It's hidden when idle.
- **Placement**: next to the tray icon, towards the screen center: below the
  icon when the tray is in the top half of its screen (macOS), above it when
  in the bottom half (Windows), clamped to the work area. Linux has no tray
  position, so the card goes in the top-right corner of the primary screen.
- **Content**: an event label with an accent dot and a close button, the PR
  title, `repo#number · author`, and one detail line ("ana requested your
  review"). Summary cards ("While you were away", "Pull request updates")
  have a label and the summary text only.
- **Accent by urgency**: red for changes requested, blue for a new review
  request, re-request or other feedback, amber for staleness nudges, green
  for approvals.
- **Dismissal**: 5 seconds, with a thin countdown bar along the top edge.
  Hovering pauses the countdown, and leaving restarts it. The close button
  dismisses at once.
- **Queue**: one card at a time. Events from one poll are queued and shown
  in turn, 5 seconds each. A poll never produces more than 3 individual
  cards, since larger batches fold into one summary.
- **Click**: opens the PR on GitHub and marks it visited, like clicking a row.
  A summary card has no PR, so it opens the popover instead.
- **Popover open**: events that arrive while the popover is open show no
  card; the list already shows them.
- **Mute**: the Notifications section in Settings has a switch. While muted
  no cards show and the queue is dropped. Events still count as seen, so
  unmuting doesn't replay them. It's kept in `state.json`.
- **Test**: "Send test notification" in the Notifications section queues one
  card, rotating through the event types. It ignores the mute switch and the
  popover-open rule.
- **Not covered**: Windows quiet time and fullscreen presentations aren't
  detected yet, so the card shows during them unless muted.

- Seen responses, notified review requests, nudged quiet and waiting
  periods, and snoozes persist in `state.json`
  in the app data directory, written atomically. Closed PRs are pruned.

## Distribution

- `ci.yml` runs fmt, clippy, tests, and the frontend build on macOS, Linux,
  and Windows for every PR and push to main.
- `release.yml`: pushing a `v*` tag builds a universal macOS `.dmg`, Windows
  `.msi`/`.exe`, and Linux `.deb`/`.rpm`/`.AppImage` into a draft release.
- macOS builds are ad-hoc signed (`signingIdentity: "-"`), since Apple
  Silicon won't run unsigned bundles, but not notarized. `Info.plist` sets
  `LSUIElement` so no Dock icon flashes at launch.
- `homebrew.yml`: publishing the release renders
  `packaging/homebrew/review-pinger.rb.in` with the `.dmg`'s URL and sha256,
  and pushes it to `CoenWarmer/homebrew-tap`. Users approve the app once in
  System Settings → Privacy & Security; the cask's caveats say so. Homebrew's
  `--no-quarantine` is deprecated and not relied upon.
- If the app goes public: Developer ID signing, notarization, the official
  cask, and the Tauri updater.

## Known risks

- Business-hours math across time zones and DST: unit-test from day one.
- Bots that post as regular users: covered by the ignore list.
- The unsigned macOS install step will deter non-technical users.

## Out of scope for v1

GitHub Enterprise Server, multiple accounts, repo/org exclude lists, an
in-app PR detail view.
