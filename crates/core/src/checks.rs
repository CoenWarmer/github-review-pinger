//! How long checks take. GitHub reports when checks started but not how long
//! they will last, so finished runs are timed as they're seen and the median
//! per repo estimates the next one.

use std::collections::HashMap;

use chrono::{DateTime, Utc};

use crate::github::types::{CheckContext, CheckRunStatus, CheckState, PullRequest};
use crate::memory::{ChecksRun, Memory};
use crate::prs::{self, Checks};

/// Runs shorter than this are noise (a skipped or instantly failing build).
const MIN_RUN_SECS: i64 = 30;
/// Longer than this is a stuck or abandoned run, not a duration.
const MAX_RUN_SECS: i64 = 6 * 60 * 60;
/// Durations needed before the learned median replaces the configured one.
const MIN_SAMPLES: usize = 3;

/// Statuses from a PR bot, such as Kibana's `prbot:outdated` ("branch is out
/// of date"), that report on the PR rather than on a build. They fail often
/// and drag the whole rollup to FAILURE while the real CI is still running.
fn is_advisory(context: &CheckContext) -> bool {
    matches!(context, CheckContext::StatusContext { context, .. } if context.starts_with("prbot:"))
}

/// The head commit's checks, judged without the advisory statuses. `None`
/// when the rollup is not a failure, or can't be second-guessed because only
/// part of the checks were fetched; the rollup's own verdict stands then.
pub(crate) fn without_advisory(pr: &PullRequest) -> Option<Checks> {
    let rollup = pr
        .commits
        .iter()
        .last()?
        .commit
        .status_check_rollup
        .as_ref()?;
    if !matches!(rollup.state, CheckState::Failure | CheckState::Error) {
        return None;
    }
    let contexts = rollup.contexts.as_ref()?;
    if contexts
        .total_count
        .is_none_or(|total| total > contexts.nodes.len())
    {
        return None;
    }

    let (mut failed, mut running, mut settled) = (false, false, false);
    for context in contexts.iter().filter(|c| !is_advisory(c)) {
        match context {
            CheckContext::CheckRun {
                status, conclusion, ..
            } => match (status, conclusion.as_deref()) {
                (CheckRunStatus::Completed, Some("SUCCESS" | "SKIPPED" | "NEUTRAL")) => {
                    settled = true
                }
                (CheckRunStatus::Completed, _) => failed = true,
                _ => running = true,
            },
            CheckContext::StatusContext { state, .. } => match state {
                CheckState::Success => settled = true,
                CheckState::Pending | CheckState::Expected => running = true,
                _ => failed = true,
            },
            CheckContext::Other => {}
        }
    }
    Some(if failed {
        Checks::Failing
    } else if running {
        Checks::Pending
    } else if settled {
        Checks::Passing
    } else {
        Checks::None
    })
}

/// When the head commit's checks started, and when the last finished.
///
/// A check run keeps its `startedAt`, but a commit status only has the time
/// it last changed state: the start while pending, the finish once done. So
/// the start is the earliest check run start or pending status, and the
/// finish the latest completed check run or settled status.
pub fn timing(pr: &PullRequest) -> (Option<DateTime<Utc>>, Option<DateTime<Utc>>) {
    let contexts = pr
        .commits
        .iter()
        .last()
        .and_then(|node| node.commit.status_check_rollup.as_ref())
        .and_then(|rollup| rollup.contexts.as_ref());

    let mut started: Option<DateTime<Utc>> = None;
    let mut finished: Option<DateTime<Utc>> = None;
    let mut earliest = |at: DateTime<Utc>| started = Some(started.map_or(at, |s| s.min(at)));
    let mut latest = |at: DateTime<Utc>| finished = Some(finished.map_or(at, |f| f.max(at)));

    for context in contexts
        .into_iter()
        .flat_map(|c| c.iter())
        .filter(|c| !is_advisory(c))
    {
        match context {
            CheckContext::CheckRun {
                status,
                started_at,
                completed_at,
                ..
            } => {
                if let Some(at) = started_at {
                    earliest(*at);
                }
                if let (CheckRunStatus::Completed, Some(at)) = (status, completed_at) {
                    latest(*at);
                }
            }
            CheckContext::StatusContext {
                state, created_at, ..
            } => {
                if matches!(state, CheckState::Pending | CheckState::Expected) {
                    earliest(*created_at);
                } else {
                    latest(*created_at);
                }
            }
            CheckContext::Other => {}
        }
    }
    (started, finished)
}

/// Follows each of the viewer's PRs' checks from running to done, and
/// records how long a successful run took. Only PRs already in `memory` are
/// tracked, so closed ones are forgotten with the rest of their entry.
pub fn track(prs: &[PullRequest], memory: &mut Memory) {
    let mut durations: Vec<(String, u64)> = Vec::new();

    for pr in prs {
        let Some(oid) = pr
            .commits
            .iter()
            .last()
            .and_then(|node| node.commit.oid.clone())
        else {
            continue;
        };
        let Some(entry) = memory.pull_requests.get_mut(&pr.id) else {
            continue;
        };
        let (started, finished) = timing(pr);

        match prs::checks(pr) {
            Checks::Pending => {
                let Some(started) = started else { continue };
                match &mut entry.checks_run {
                    Some(run) if run.oid == oid && !run.finished => {
                        run.started_at = run.started_at.min(started);
                    }
                    // A new push, or a re-run after the last one finished.
                    _ => {
                        entry.checks_run = Some(ChecksRun {
                            oid,
                            started_at: started,
                            finished: false,
                        });
                    }
                }
            }
            outcome => {
                let Some(run) = entry
                    .checks_run
                    .as_mut()
                    .filter(|run| run.oid == oid && !run.finished)
                else {
                    continue;
                };
                run.finished = true;
                // Failures stop early, which would drag the estimate down.
                if outcome == Checks::Passing
                    && let Some(finished) = finished
                {
                    let secs = (finished - run.started_at).num_seconds();
                    if (MIN_RUN_SECS..=MAX_RUN_SECS).contains(&secs) {
                        durations.push((pr.repository.name_with_owner.clone(), secs as u64));
                    }
                }
            }
        }
    }

    for (repo, secs) in durations {
        memory.record_check_duration(&repo, secs);
    }
}

/// Seconds checks are expected to take, by repo: the median of the timed
/// runs once there are enough, otherwise the configured minutes.
pub fn estimates(memory: &Memory, configured: &HashMap<String, u32>) -> HashMap<String, u64> {
    let mut estimates: HashMap<String, u64> = configured
        .iter()
        .map(|(repo, minutes)| (repo.clone(), u64::from(*minutes) * 60))
        .collect();
    for (repo, durations) in &memory.check_durations {
        if durations.len() >= MIN_SAMPLES
            || (!durations.is_empty() && !estimates.contains_key(repo))
        {
            estimates.insert(repo.clone(), median(durations));
        }
    }
    estimates
}

fn median(durations: &[u64]) -> u64 {
    let mut sorted = durations.to_vec();
    sorted.sort_unstable();
    let mid = sorted.len() / 2;
    if sorted.len().is_multiple_of(2) {
        (sorted[mid - 1] + sorted[mid]) / 2
    } else {
        sorted[mid]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::PrMemory;
    use serde_json::{Value, json};

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    fn pr(oid: &str, state: &str, contexts: Vec<Value>) -> PullRequest {
        serde_json::from_value(json!({
            "id": "PR_1",
            "number": 1,
            "title": "Title",
            "url": "https://github.com/o/r/pull/1",
            "isDraft": false,
            "createdAt": "2026-10-01T09:00:00Z",
            "reviewDecision": null,
            "mergeable": "MERGEABLE",
            "autoMergeRequest": null,
            "repository": { "nameWithOwner": "o/r" },
            "commits": { "nodes": [{ "commit": {
                "oid": oid,
                "committedDate": "2026-10-01T09:00:00Z",
                "statusCheckRollup": { "state": state, "contexts": { "nodes": contexts } },
            } }] },
            "timelineItems": { "nodes": [] },
        }))
        .unwrap()
    }

    fn status(state: &str, when: &str) -> Value {
        json!({ "__typename": "StatusContext", "state": state, "createdAt": when })
    }

    fn run(status: &str, started: &str, completed: Option<&str>) -> Value {
        json!({
            "__typename": "CheckRun",
            "status": status,
            "startedAt": started,
            "completedAt": completed,
        })
    }

    fn memory() -> Memory {
        let mut memory = Memory::default();
        memory
            .pull_requests
            .insert("PR_1".into(), PrMemory::new(at("2026-10-01T09:00:00Z")));
        memory
    }

    #[test]
    fn timing_takes_the_earliest_start_and_latest_finish() {
        let pr = pr(
            "a",
            "PENDING",
            vec![
                run(
                    "COMPLETED",
                    "2026-10-05T10:05:00Z",
                    Some("2026-10-05T10:09:00Z"),
                ),
                run("IN_PROGRESS", "2026-10-05T10:02:00Z", None),
                status("PENDING", "2026-10-05T10:03:00Z"),
                status("SUCCESS", "2026-10-05T10:20:00Z"),
            ],
        );
        assert_eq!(
            timing(&pr),
            (
                Some(at("2026-10-05T10:02:00Z")),
                Some(at("2026-10-05T10:20:00Z"))
            )
        );
    }

    #[test]
    fn a_passing_run_is_timed_from_when_it_was_first_seen_pending() {
        let mut memory = memory();
        track(
            &[pr(
                "a",
                "PENDING",
                vec![status("PENDING", "2026-10-05T10:00:00Z")],
            )],
            &mut memory,
        );
        // The status's time moves to the finish once it settles.
        track(
            &[pr(
                "a",
                "SUCCESS",
                vec![status("SUCCESS", "2026-10-05T10:40:00Z")],
            )],
            &mut memory,
        );
        assert_eq!(memory.check_durations["o/r"], vec![2400]);
        // Seen again, it isn't recorded twice.
        track(
            &[pr(
                "a",
                "SUCCESS",
                vec![status("SUCCESS", "2026-10-05T10:40:00Z")],
            )],
            &mut memory,
        );
        assert_eq!(memory.check_durations["o/r"].len(), 1);
    }

    #[test]
    fn failures_and_runs_never_seen_pending_are_not_timed() {
        let mut memory = memory();
        track(
            &[pr(
                "a",
                "PENDING",
                vec![status("PENDING", "2026-10-05T10:00:00Z")],
            )],
            &mut memory,
        );
        track(
            &[pr(
                "a",
                "FAILURE",
                vec![status("FAILURE", "2026-10-05T10:05:00Z")],
            )],
            &mut memory,
        );
        assert!(memory.check_durations.is_empty());

        // First seen already done: no start to measure from.
        let mut memory = self::memory();
        track(
            &[pr(
                "b",
                "SUCCESS",
                vec![status("SUCCESS", "2026-10-05T10:40:00Z")],
            )],
            &mut memory,
        );
        assert!(memory.check_durations.is_empty());
    }

    #[test]
    fn a_rerun_after_a_failure_and_a_new_push_start_over() {
        let mut memory = memory();
        track(
            &[pr(
                "a",
                "PENDING",
                vec![status("PENDING", "2026-10-05T10:00:00Z")],
            )],
            &mut memory,
        );
        track(
            &[pr(
                "a",
                "FAILURE",
                vec![status("FAILURE", "2026-10-05T10:05:00Z")],
            )],
            &mut memory,
        );
        // Retried on the same commit.
        track(
            &[pr(
                "a",
                "PENDING",
                vec![status("PENDING", "2026-10-05T11:00:00Z")],
            )],
            &mut memory,
        );
        track(
            &[pr(
                "a",
                "SUCCESS",
                vec![status("SUCCESS", "2026-10-05T11:30:00Z")],
            )],
            &mut memory,
        );
        assert_eq!(memory.check_durations["o/r"], vec![1800]);

        // A new commit replaces whatever was being timed.
        track(
            &[pr(
                "b",
                "PENDING",
                vec![status("PENDING", "2026-10-05T12:00:00Z")],
            )],
            &mut memory,
        );
        track(
            &[pr(
                "c",
                "SUCCESS",
                vec![status("SUCCESS", "2026-10-05T12:30:00Z")],
            )],
            &mut memory,
        );
        assert_eq!(memory.check_durations["o/r"].len(), 1);
    }

    #[test]
    fn the_earliest_start_is_kept_while_checks_finish_one_by_one() {
        let mut memory = memory();
        let first = pr(
            "a",
            "PENDING",
            vec![
                run("IN_PROGRESS", "2026-10-05T10:00:00Z", None),
                run("IN_PROGRESS", "2026-10-05T10:01:00Z", None),
            ],
        );
        track(&[first], &mut memory);
        let later = pr(
            "a",
            "PENDING",
            vec![
                run(
                    "COMPLETED",
                    "2026-10-05T10:00:00Z",
                    Some("2026-10-05T10:10:00Z"),
                ),
                run("IN_PROGRESS", "2026-10-05T10:01:00Z", None),
            ],
        );
        track(&[later], &mut memory);
        assert_eq!(
            memory.pull_requests["PR_1"]
                .checks_run
                .as_ref()
                .unwrap()
                .started_at,
            at("2026-10-05T10:00:00Z")
        );
    }

    #[test]
    fn absurd_durations_are_ignored() {
        let mut memory = memory();
        track(
            &[pr(
                "a",
                "PENDING",
                vec![status("PENDING", "2026-10-05T10:00:00Z")],
            )],
            &mut memory,
        );
        track(
            &[pr(
                "a",
                "SUCCESS",
                vec![status("SUCCESS", "2026-10-05T10:00:05Z")],
            )],
            &mut memory,
        );
        assert!(memory.check_durations.is_empty());
    }

    #[test]
    fn only_the_latest_durations_are_kept() {
        let mut memory = Memory::default();
        for secs in 1..=12 {
            memory.record_check_duration("o/r", secs * 100);
        }
        assert_eq!(memory.check_durations["o/r"].len(), 10);
        assert_eq!(memory.check_durations["o/r"][0], 300);
    }

    #[test]
    fn estimates_prefer_learned_medians_once_there_are_enough() {
        let configured = HashMap::from([("o/r".to_string(), 45), ("o/other".to_string(), 10)]);
        let mut memory = Memory::default();

        // Nothing learned: the configured value.
        assert_eq!(estimates(&memory, &configured)["o/r"], 2700);

        // Too few samples to trust over the configured value.
        memory.record_check_duration("o/r", 600);
        memory.record_check_duration("o/r", 1200);
        assert_eq!(estimates(&memory, &configured)["o/r"], 2700);

        memory.record_check_duration("o/r", 900);
        let learned = estimates(&memory, &configured);
        assert_eq!(learned["o/r"], 900);
        assert_eq!(learned["o/other"], 600);

        // With no configured value, even one sample will do.
        memory.record_check_duration("new/repo", 300);
        assert_eq!(estimates(&memory, &configured)["new/repo"], 300);
    }

    #[test]
    fn the_median_of_an_even_count_is_the_middle_pair_average() {
        assert_eq!(median(&[100, 400, 200, 300]), 250);
        assert_eq!(median(&[5]), 5);
    }
}
