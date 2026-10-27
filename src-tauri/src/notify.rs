//! Decides what to notify about by diffing fresh pull requests against
//! memory, and words the notifications.

use std::collections::HashSet;

use chrono::{DateTime, Duration, TimeZone, Utc};

use crate::calendar;
use crate::memory::{Memory, PrMemory};
#[cfg(test)]
use crate::prs::Checks;
use crate::prs::{Group, PrView, Response, ResponseKind};
use crate::reviews::{ReviewGroup, ReviewView};

/// More events than this in one poll are folded into a single summary.
const MAX_INDIVIDUAL: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Response {
        pr: PrRef,
        response: Response,
    },
    Stale {
        pr: PrRef,
    },
    ReviewRequested {
        pr: PrRef,
        author: String,
        rerequested: bool,
    },
    /// A review that has been waiting on the viewer for too long.
    ReviewStale {
        pr: PrRef,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrRef {
    pub repo: String,
    pub number: u64,
    pub title: String,
}

impl PrRef {
    fn of(view: &PrView) -> Self {
        Self {
            repo: view.repo.clone(),
            number: view.number,
            title: view.title.clone(),
        }
    }

    fn of_review(view: &ReviewView) -> Self {
        Self {
            repo: view.repo.clone(),
            number: view.number,
            title: view.title.clone(),
        }
    }

    fn label(&self) -> String {
        format!("{}#{}: {}", self.repo, self.number, self.title)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notification {
    pub title: String,
    pub body: String,
}

/// Records `views` and `reviews` in `memory` and returns what changed since
/// the last poll: new responses from others, waiting PRs whose current quiet
/// period has just exceeded `nudge_after` weekday time in `tz`, new review
/// requests, and requested reviews waiting longer than `review_nudge_after`.
pub fn diff<Tz: TimeZone>(
    views: &[PrView],
    reviews: &[ReviewView],
    memory: &mut Memory,
    now: DateTime<Utc>,
    nudge_after: Duration,
    review_nudge_after: Duration,
    tz: &Tz,
) -> Vec<Event> {
    // On the very first poll there is no history, so everything before now
    // counts as already seen.
    let baseline = memory.last_poll_at.unwrap_or(now);
    let mut events = Vec::new();

    for view in views {
        let entry = memory
            .pull_requests
            .entry(view.id.clone())
            .or_insert_with(|| PrMemory::new(baseline));

        for response in view.responses.iter().filter(|r| r.at > entry.seen_until) {
            events.push(Event::Response {
                pr: PrRef::of(view),
                response: response.clone(),
            });
        }
        if let Some(latest) = view.responses.last() {
            entry.seen_until = entry.seen_until.max(latest.at);
        }

        let overdue = calendar::weekday_time(view.quiet_since, now, tz) >= nudge_after;
        // Approved PRs are waiting on checks or merging, not on reviewers.
        let awaiting_review = view.group == Group::Waiting && !view.approved;
        if awaiting_review && overdue && entry.nudged_for != Some(view.quiet_since) {
            events.push(Event::Stale {
                pr: PrRef::of(view),
            });
            entry.nudged_for = Some(view.quiet_since);
        }
    }

    for view in reviews {
        let entry = memory
            .pull_requests
            .entry(view.id.clone())
            .or_insert_with(|| PrMemory::new(baseline));
        let Some(since) = view.waiting_since else {
            continue;
        };

        // Drafts are only recorded, so marking one ready later notifies.
        let seen = entry.requested_seen_until.unwrap_or(entry.seen_until);
        if view.group != ReviewGroup::Draft && since > seen {
            events.push(Event::ReviewRequested {
                pr: PrRef::of_review(view),
                author: view.author.clone(),
                rerequested: view.rerequested,
            });
        }
        entry.requested_seen_until = Some(seen.max(since));

        let overdue = calendar::weekday_time(since, now, tz) >= review_nudge_after;
        if view.group == ReviewGroup::NeedsReview && overdue && entry.nudged_for != Some(since) {
            events.push(Event::ReviewStale {
                pr: PrRef::of_review(view),
            });
            entry.nudged_for = Some(since);
        }
    }

    let open: HashSet<&str> = views
        .iter()
        .map(|v| v.id.as_str())
        .chain(reviews.iter().map(|v| v.id.as_str()))
        .collect();
    memory
        .pull_requests
        .retain(|id, _| open.contains(id.as_str()));
    memory.last_poll_at = Some(now);
    events
}

/// One notification per event, or a single summary after a cold start or
/// when there are too many to show individually.
pub fn compose(events: &[Event], cold_start: bool) -> Vec<Notification> {
    if events.is_empty() {
        return Vec::new();
    }
    if cold_start || events.len() > MAX_INDIVIDUAL {
        let title = if cold_start {
            "While you were away"
        } else {
            "Pull request updates"
        };
        return vec![Notification {
            title: title.to_string(),
            body: summary(events),
        }];
    }
    events.iter().map(single).collect()
}

fn single(event: &Event) -> Notification {
    match event {
        Event::Response { pr, response } => {
            let verb = match response.kind {
                ResponseKind::Approved => "approved",
                ResponseKind::ChangesRequested => "requested changes",
                ResponseKind::Commented => "commented",
            };
            Notification {
                title: format!("{} {verb}", response.login),
                body: pr.label(),
            }
        }
        Event::Stale { pr } => Notification {
            title: "Still waiting on review".to_string(),
            body: pr.label(),
        },
        Event::ReviewRequested {
            pr,
            author,
            rerequested,
        } => Notification {
            title: format!(
                "{author} {} your review",
                if *rerequested {
                    "re-requested"
                } else {
                    "requested"
                }
            ),
            body: pr.label(),
        },
        Event::ReviewStale { pr } => Notification {
            title: "Still waiting on your review".to_string(),
            body: pr.label(),
        },
    }
}

fn summary(events: &[Event]) -> String {
    let count = |matches: fn(&Event) -> bool| events.iter().filter(|e| matches(e)).count();
    let approvals = count(
        |e| matches!(e, Event::Response { response, .. } if response.kind == ResponseKind::Approved),
    );
    let change_requests = count(
        |e| matches!(e, Event::Response { response, .. } if response.kind == ResponseKind::ChangesRequested),
    );
    let comments = count(
        |e| matches!(e, Event::Response { response, .. } if response.kind == ResponseKind::Commented),
    );
    let stale = count(|e| matches!(e, Event::Stale { .. }));
    let requests = count(|e| matches!(e, Event::ReviewRequested { .. }));
    let review_stale = count(|e| matches!(e, Event::ReviewStale { .. }));

    let parts: Vec<String> = [
        (approvals, "approval", "approvals"),
        (change_requests, "change request", "change requests"),
        (comments, "comment", "comments"),
        (
            stale,
            "PR still waiting on review",
            "PRs still waiting on review",
        ),
        (requests, "review request", "review requests"),
        (
            review_stale,
            "PR still waiting on your review",
            "PRs still waiting on your review",
        ),
    ]
    .into_iter()
    .filter(|(n, _, _)| *n > 0)
    .map(|(n, one, many)| format!("{n} {}", if n == 1 { one } else { many }))
    .collect();

    match parts.as_slice() {
        [] => String::new(),
        [only] => only.clone(),
        [init @ .., last] => format!("{} and {last}", init.join(", ")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono_tz::Europe::Amsterdam;

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    fn view(id: &str, group: Group, quiet_since: &str, responses: Vec<Response>) -> PrView {
        PrView {
            id: id.to_string(),
            number: 1,
            title: "Fix it".to_string(),
            url: String::new(),
            repo: "o/r".to_string(),
            group,
            actions: Vec::new(),
            open_since: at(quiet_since),
            quiet_since: at(quiet_since),
            last_activity: at(quiet_since),
            snoozed_until: None,
            approved: false,
            checks: Checks::Passing,
            checks_started: None,
            checks_estimate_secs: None,
            auto_merge: false,
            merge_queue_position: None,
            merge_eta: None,
            merge_enqueued_at: None,
            queued: false,
            reviewers: Vec::new(),
            responses,
        }
    }

    fn response(login: &str, kind: ResponseKind, when: &str) -> Response {
        Response {
            login: login.to_string(),
            kind,
            at: at(when),
        }
    }

    fn run(views: &[PrView], memory: &mut Memory, now: &str) -> Vec<Event> {
        run_reviews(views, &[], memory, now)
    }

    fn run_reviews(
        views: &[PrView],
        reviews: &[ReviewView],
        memory: &mut Memory,
        now: &str,
    ) -> Vec<Event> {
        diff(
            views,
            reviews,
            memory,
            at(now),
            Duration::hours(24),
            Duration::hours(24),
            &Amsterdam,
        )
    }

    fn review_view(id: &str, group: ReviewGroup, waiting_since: Option<&str>) -> ReviewView {
        ReviewView {
            id: id.to_string(),
            number: 5,
            title: "Add it".to_string(),
            url: String::new(),
            repo: "o/r".to_string(),
            author: "ana".to_string(),
            group,
            open_since: at(TUESDAY),
            waiting_since: waiting_since.map(at),
            rerequested: false,
            my_state: None,
            reviewed_at: None,
            last_activity: at(TUESDAY),
            snoozed_until: None,
            reviewers: Vec::new(),
        }
    }

    // Tue 2026-10-06 10:00 local.
    const TUESDAY: &str = "2026-10-06T08:00:00Z";

    #[test]
    fn first_poll_ever_treats_history_as_seen() {
        let mut memory = Memory::default();
        let views = [view(
            "a",
            Group::NeedsAction,
            TUESDAY,
            vec![response("rev", ResponseKind::Approved, TUESDAY)],
        )];
        assert!(run(&views, &mut memory, "2026-10-06T09:00:00Z").is_empty());
        assert_eq!(memory.last_poll_at, Some(at("2026-10-06T09:00:00Z")));
    }

    #[test]
    fn new_responses_are_reported_once() {
        let mut memory = Memory::default();
        let mut views = [view("a", Group::Waiting, TUESDAY, vec![])];
        run(&views, &mut memory, "2026-10-06T09:00:00Z");

        views[0].responses = vec![response(
            "rev",
            ResponseKind::ChangesRequested,
            "2026-10-06T09:30:00Z",
        )];
        let events = run(&views, &mut memory, "2026-10-06T09:32:00Z");
        assert_eq!(events.len(), 1);
        assert!(run(&views, &mut memory, "2026-10-06T09:34:00Z").is_empty());
    }

    #[test]
    fn responses_on_a_pr_opened_between_polls_are_reported() {
        let mut memory = Memory::default();
        run(&[], &mut memory, "2026-10-06T09:00:00Z");
        let views = [view(
            "new",
            Group::Waiting,
            TUESDAY,
            vec![response(
                "rev",
                ResponseKind::Commented,
                "2026-10-06T09:01:00Z",
            )],
        )];
        assert_eq!(run(&views, &mut memory, "2026-10-06T09:02:00Z").len(), 1);
    }

    #[test]
    fn nudges_once_per_quiet_period_after_a_business_day() {
        let mut memory = Memory::default();
        let views = [view("a", Group::Waiting, TUESDAY, vec![])];
        assert!(run(&views, &mut memory, "2026-10-07T07:59:00Z").is_empty());

        let events = run(&views, &mut memory, "2026-10-07T08:01:00Z");
        assert!(matches!(events.as_slice(), [Event::Stale { .. }]));
        assert!(run(&views, &mut memory, "2026-10-08T08:01:00Z").is_empty());

        // A response starts a new quiet period, which can be nudged again.
        let views = [view("a", Group::Waiting, "2026-10-08T08:00:00Z", vec![])];
        assert!(run(&views, &mut memory, "2026-10-08T09:00:00Z").is_empty());
        assert_eq!(run(&views, &mut memory, "2026-10-09T08:00:00Z").len(), 1);
    }

    #[test]
    fn friday_afternoon_prs_are_not_nudged_over_the_weekend() {
        let mut memory = Memory::default();
        // Fri 2026-10-09 15:00 local.
        let views = [view("a", Group::Waiting, "2026-10-09T13:00:00Z", vec![])];
        assert!(run(&views, &mut memory, "2026-10-11T20:00:00Z").is_empty());
        assert_eq!(run(&views, &mut memory, "2026-10-12T13:00:00Z").len(), 1);
    }

    #[test]
    fn only_waiting_prs_are_nudged() {
        let mut memory = Memory::default();
        let views = [
            view("action", Group::NeedsAction, TUESDAY, vec![]),
            view("snoozed", Group::Snoozed, TUESDAY, vec![]),
            view("dormant", Group::Dormant, TUESDAY, vec![]),
            view("draft", Group::Draft, TUESDAY, vec![]),
        ];
        assert!(run(&views, &mut memory, "2026-10-09T08:00:00Z").is_empty());
    }

    #[test]
    fn approved_prs_are_not_nudged() {
        let mut memory = Memory::default();
        let mut approved = view("a", Group::Waiting, TUESDAY, vec![]);
        approved.approved = true;
        assert!(run(&[approved], &mut memory, "2026-10-09T08:00:00Z").is_empty());
    }

    #[test]
    fn closed_prs_are_forgotten() {
        let mut memory = Memory::default();
        run(
            &[view("a", Group::Waiting, TUESDAY, vec![])],
            &mut memory,
            TUESDAY,
        );
        run(&[], &mut memory, TUESDAY);
        assert!(memory.pull_requests.is_empty());
    }

    fn approval(login: &str) -> Event {
        Event::Response {
            pr: PrRef {
                repo: "o/r".into(),
                number: 7,
                title: "Fix it".into(),
            },
            response: response(login, ResponseKind::Approved, TUESDAY),
        }
    }

    #[test]
    fn few_events_notify_individually() {
        let notes = compose(&[approval("ana")], false);
        assert_eq!(
            notes,
            vec![Notification {
                title: "ana approved".into(),
                body: "o/r#7: Fix it".into(),
            }]
        );
    }

    #[test]
    fn many_events_or_a_cold_start_are_summarized() {
        let stale = Event::Stale {
            pr: PrRef {
                repo: "o/r".into(),
                number: 8,
                title: "Other".into(),
            },
        };
        let notes = compose(&[approval("ana"), approval("bo"), stale], true);
        assert_eq!(
            notes,
            vec![Notification {
                title: "While you were away".into(),
                body: "2 approvals and 1 PR still waiting on review".into(),
            }]
        );

        let many: Vec<Event> = (0..4).map(|_| approval("ana")).collect();
        assert_eq!(compose(&many, false)[0].title, "Pull request updates");
    }

    #[test]
    fn new_review_requests_are_reported_once() {
        let mut memory = Memory::default();
        run_reviews(&[], &[], &mut memory, "2026-10-06T09:00:00Z");

        let reviews = [review_view(
            "r",
            ReviewGroup::NeedsReview,
            Some("2026-10-06T09:30:00Z"),
        )];
        let events = run_reviews(&[], &reviews, &mut memory, "2026-10-06T09:32:00Z");
        assert!(matches!(
            events.as_slice(),
            [Event::ReviewRequested {
                rerequested: false,
                ..
            }]
        ));
        assert!(run_reviews(&[], &reviews, &mut memory, "2026-10-06T09:34:00Z").is_empty());
    }

    #[test]
    fn re_requests_are_reported_again() {
        let mut memory = Memory::default();
        run_reviews(&[], &[], &mut memory, "2026-10-06T09:00:00Z");
        let mut review = review_view("r", ReviewGroup::NeedsReview, Some("2026-10-06T09:30:00Z"));
        run_reviews(&[], &[review.clone()], &mut memory, "2026-10-06T09:32:00Z");

        // Reviewed, then requested again.
        review.waiting_since = Some(at("2026-10-06T11:00:00Z"));
        review.rerequested = true;
        let events = run_reviews(&[], &[review], &mut memory, "2026-10-06T11:02:00Z");
        assert_eq!(
            single(&events[0]),
            Notification {
                title: "ana re-requested your review".into(),
                body: "o/r#5: Add it".into(),
            }
        );
    }

    #[test]
    fn requests_that_predate_tracking_are_not_reported() {
        let mut memory = Memory::default();
        // First poll ever: the request is history.
        let reviews = [review_view("r", ReviewGroup::NeedsReview, Some(TUESDAY))];
        assert!(run_reviews(&[], &reviews, &mut memory, "2026-10-06T09:00:00Z").is_empty());
        assert!(run_reviews(&[], &reviews, &mut memory, "2026-10-06T09:02:00Z").is_empty());
    }

    #[test]
    fn a_draft_that_becomes_ready_notifies() {
        let mut memory = Memory::default();
        run_reviews(&[], &[], &mut memory, "2026-10-06T09:00:00Z");
        let draft = review_view("r", ReviewGroup::Draft, Some("2026-10-06T09:10:00Z"));
        assert!(run_reviews(&[], &[draft], &mut memory, "2026-10-06T09:12:00Z").is_empty());

        let ready = review_view("r", ReviewGroup::NeedsReview, Some("2026-10-06T09:20:00Z"));
        assert_eq!(
            run_reviews(&[], &[ready], &mut memory, "2026-10-06T09:22:00Z").len(),
            1
        );
    }

    #[test]
    fn snoozed_requests_notify_but_are_not_nudged() {
        let mut memory = Memory::default();
        run_reviews(&[], &[], &mut memory, "2026-10-06T09:00:00Z");
        let snoozed = review_view("r", ReviewGroup::Snoozed, Some("2026-10-06T09:10:00Z"));
        let events = run_reviews(
            &[],
            std::slice::from_ref(&snoozed),
            &mut memory,
            "2026-10-09T09:00:00Z",
        );
        assert!(matches!(events.as_slice(), [Event::ReviewRequested { .. }]));
        assert!(run_reviews(&[], &[snoozed], &mut memory, "2026-10-09T09:02:00Z").is_empty());
    }

    #[test]
    fn reviews_are_nudged_once_per_waiting_period() {
        let mut memory = Memory::default();
        let reviews = [review_view("r", ReviewGroup::NeedsReview, Some(TUESDAY))];
        // Recorded as already seen on the first poll.
        run_reviews(&[], &reviews, &mut memory, "2026-10-06T09:00:00Z");
        assert!(run_reviews(&[], &reviews, &mut memory, "2026-10-07T07:59:00Z").is_empty());

        let events = run_reviews(&[], &reviews, &mut memory, "2026-10-07T08:01:00Z");
        assert!(matches!(events.as_slice(), [Event::ReviewStale { .. }]));
        assert!(run_reviews(&[], &reviews, &mut memory, "2026-10-08T08:01:00Z").is_empty());

        // A re-request starts a new waiting period.
        let again = [review_view(
            "r",
            ReviewGroup::NeedsReview,
            Some("2026-10-08T08:00:00Z"),
        )];
        let events = run_reviews(&[], &again, &mut memory, "2026-10-08T08:02:00Z");
        assert!(matches!(events.as_slice(), [Event::ReviewRequested { .. }]));
        assert_eq!(
            run_reviews(&[], &again, &mut memory, "2026-10-09T08:01:00Z").len(),
            1
        );
    }

    #[test]
    fn only_requested_reviews_are_nudged() {
        let mut memory = Memory::default();
        let reviews = [
            review_view("author", ReviewGroup::WaitingOnAuthor, None),
            review_view("draft", ReviewGroup::Draft, Some(TUESDAY)),
        ];
        assert!(run_reviews(&[], &reviews, &mut memory, "2026-10-09T08:00:00Z").is_empty());
    }

    #[test]
    fn review_events_are_summarized() {
        let pr = PrRef {
            repo: "o/r".into(),
            number: 5,
            title: "Add it".into(),
        };
        let events = [
            Event::ReviewRequested {
                pr: pr.clone(),
                author: "ana".into(),
                rerequested: false,
            },
            Event::ReviewRequested {
                pr: pr.clone(),
                author: "bo".into(),
                rerequested: true,
            },
            Event::ReviewStale { pr },
            approval("cy"),
        ];
        assert_eq!(
            compose(&events, false)[0].body,
            "1 approval, 2 review requests and 1 PR still waiting on your review"
        );
    }
}
