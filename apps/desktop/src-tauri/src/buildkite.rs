//! CI build statistics from the Buildkite CLI (`bk`), for Settings. Desktop
//! only: the CLI is local, uses whatever login it already has, and the app
//! stores nothing for it. Without the CLI, or without a login, the answer says
//! so and the UI explains how to set it up.
//!
//! "Your builds" are the builds on PRs you authored. Builds on a PR are
//! created by a bot (such as `elasticmachine`), so Buildkite's own `--creator`
//! filter never finds a person's; instead the PRs come from GitHub and their
//! builds are found by branch, and each is checked against its PR number.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, mpsc};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::github::PrBranch;

/// How long to wait for the CLI before giving up on it.
const TIMEOUT: Duration = Duration::from_secs(120);
/// Branches asked for in one `bk build list`, and how many of those run at once.
const BRANCHES_PER_CALL: usize = 20;
const CALLS_AT_ONCE: usize = 10;
/// How long the builds are reused, so the earlier window needs no new fetch.
const REUSE_FOR: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CiStats {
    /// Builds on your PRs created in the window, and how long the finished
    /// ones took.
    Ok {
        builds: usize,
        /// Average of start to finish over the builds that have both.
        avg_duration_secs: Option<u64>,
        /// How many builds the average is over.
        duration_sample: usize,
    },
    /// There is no `bk` to run.
    NotInstalled,
    /// `bk` is there but has no working login.
    NotLoggedIn,
    Error {
        message: String,
    },
}

/// Apps launched from Finder or as a login item don't inherit the shell's
/// PATH, so common install locations are checked explicitly.
fn find_bk() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "bk.exe" } else { "bk" };
    let fallbacks: &[&str] = if cfg!(windows) {
        &[]
    } else {
        &[
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/home/linuxbrew/.linuxbrew/bin",
            "/usr/bin",
        ]
    };

    env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .chain(fallbacks.iter().map(PathBuf::from))
        .chain(env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/bin")))
        .map(|dir| dir.join(exe))
        .find(|candidate| candidate.is_file())
}

/// What a run of the CLI printed and whether it succeeded, or why it didn't
/// run. Gives up after `TIMEOUT`; the abandoned process ends on its own.
fn run(bk: &Path, args: &[String]) -> Result<(bool, String, String), String> {
    let mut command = Command::new(bk);
    command.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = send.send(command.output());
    });
    match receive.recv_timeout(TIMEOUT) {
        Ok(Ok(output)) => Ok((
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )),
        Ok(Err(e)) => Err(format!("Could not run bk: {e}")),
        Err(_) => Err("The Buildkite CLI took too long to answer.".to_string()),
    }
}

/// The JSON in `output`, which the CLI may print warnings before.
fn json_part(output: &str, open: char) -> &str {
    output.find(open).map_or("", |start| &output[start..])
}

/// The CLI to use, or the answer to give when it can't be: not installed, or
/// without a login.
pub fn ready() -> Result<PathBuf, CiStats> {
    let bk = find_bk().ok_or(CiStats::NotInstalled)?;
    match run(&bk, &["auth".to_string(), "status".to_string()]) {
        Ok((true, stdout, _)) if json_part(&stdout, '{').starts_with('{') => Ok(bk),
        Ok(_) => Err(CiStats::NotLoggedIn),
        Err(message) => Err(CiStats::Error { message }),
    }
}

/// A build, with what's needed to attribute and time it.
#[derive(Debug, Clone, Deserialize)]
pub struct Build {
    pipeline: Option<PipelineRef>,
    branch: Option<String>,
    created_at: DateTime<Utc>,
    started_at: Option<DateTime<Utc>>,
    finished_at: Option<DateTime<Utc>>,
    pull_request: Option<PullRequestRef>,
}

#[derive(Debug, Clone, Deserialize)]
struct PipelineRef {
    slug: String,
}

#[derive(Debug, Clone, Deserialize)]
struct PullRequestRef {
    /// The PR number, which Buildkite gives as text.
    id: Option<Value>,
    /// The repository the PR's branch is in, as a git URL.
    repository: Option<String>,
}

/// Whether `build` is a build of one of `prs`: its branch, its PR number and
/// its repository all agree, so another repository's branch of the same name
/// can't be taken for yours.
fn is_on(build: &Build, prs: &[PrBranch]) -> bool {
    let (Some(branch), Some(pr)) = (&build.branch, &build.pull_request) else {
        return false;
    };
    let number = match &pr.id {
        Some(Value::String(id)) => id.parse::<u64>().ok(),
        Some(Value::Number(id)) => id.as_u64(),
        _ => None,
    };
    let repository = pr.repository.as_deref().unwrap_or_default().to_lowercase();
    prs.iter().any(|candidate| {
        Some(candidate.number) == number
            && &candidate.branch == branch
            && repository.contains(&format!("github.com/{}", candidate.head_repo))
    })
}

/// The `bk build list` arguments for builds of the pipeline on any of the
/// comma-separated `branches`, created in the last `since` (a Go duration,
/// which has no days).
fn list_args(branches: &str, since: &str, pipeline: &str) -> Vec<String> {
    [
        "build",
        "list",
        "--pipeline",
        pipeline,
        "--branch",
        branches,
        "--since",
        since,
        "--no-limit",
        "--json",
    ]
    .map(String::from)
    .into()
}

/// The builds on `prs` in `pipeline`, created in the last `2 * days` days:
/// the window and the one before it, both from one fetch. Several
/// `bk build list` runs go at once, each for a batch of branches.
pub fn my_builds(
    bk: &Path,
    prs: &[PrBranch],
    days: i64,
    pipeline: &str,
) -> Result<Vec<Build>, String> {
    let mut branches: Vec<&str> = prs.iter().map(|pr| pr.branch.as_str()).collect();
    branches.sort_unstable();
    branches.dedup();
    let batches: Vec<String> = branches
        .chunks(BRANCHES_PER_CALL)
        .map(|chunk| chunk.join(","))
        .collect();
    let since = format!("{}h", 2 * days * 24);
    let next = AtomicUsize::new(0);
    let collected: Mutex<Vec<Result<Vec<Build>, String>>> = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..CALLS_AT_ONCE.min(batches.len()) {
            scope.spawn(|| {
                while let Some(joined) = batches.get(next.fetch_add(1, Ordering::Relaxed)) {
                    let args = list_args(joined, &since, pipeline);
                    let result = run(bk, &args).and_then(|(ok, stdout, stderr)| {
                        if !ok {
                            return Err(last_line(&stderr));
                        }
                        serde_json::from_str(json_part(&stdout, '['))
                            .map_err(|e| format!("Unexpected output from bk: {e}"))
                    });
                    collected.lock().unwrap().push(result);
                }
            });
        }
    });
    let mut builds = Vec::new();
    for batch in collected.into_inner().unwrap() {
        builds.extend(batch?);
    }
    // The CLI filters by pipeline too, but what's counted is checked anyway.
    builds.retain(|build| {
        build
            .pipeline
            .as_ref()
            .is_some_and(|p| p.slug.eq_ignore_ascii_case(pipeline))
            && is_on(build, prs)
    });
    Ok(builds)
}

/// The last line of what the CLI said on stderr, which is the error.
fn last_line(stderr: &str) -> String {
    stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty() && !line.starts_with("Warning"))
        .unwrap_or("bk could not list builds.")
        .trim()
        .to_string()
}

/// The count of `builds` created in the window of `days` ending `days` days
/// before `now` with `previous` (otherwise ending at `now`), and the average
/// time the ones with a start and a finish took.
pub fn summarize(builds: &[Build], now: DateTime<Utc>, days: i64, previous: bool) -> CiStats {
    let end = if previous {
        now - chrono::Duration::days(days)
    } else {
        now
    };
    let start = end - chrono::Duration::days(days);
    let in_window: Vec<&Build> = builds
        .iter()
        .filter(|build| build.created_at >= start && build.created_at < end)
        .collect();
    let durations: Vec<i64> = in_window
        .iter()
        .filter_map(|build| Some((build.finished_at? - build.started_at?).num_seconds()))
        .filter(|seconds| *seconds >= 0)
        .collect();
    CiStats::Ok {
        builds: in_window.len(),
        avg_duration_secs: (!durations.is_empty())
            .then(|| (durations.iter().sum::<i64>() / durations.len() as i64) as u64),
        duration_sample: durations.len(),
    }
}

/// The builds last fetched, for `days` and a pipeline, while they're recent
/// enough to reuse.
type Recent = Option<(Instant, i64, String, Vec<Build>)>;
static RECENT: Mutex<Recent> = Mutex::new(None);

pub fn recent(days: i64, pipeline: &str) -> Option<Vec<Build>> {
    let recent = RECENT.lock().unwrap();
    let (at, for_days, for_pipeline, builds) = recent.as_ref()?;
    (*for_days == days && for_pipeline == pipeline && at.elapsed() < REUSE_FOR)
        .then(|| builds.clone())
}

pub fn remember(days: i64, pipeline: &str, builds: &[Build]) {
    *RECENT.lock().unwrap() = Some((Instant::now(), days, pipeline.to_string(), builds.to_vec()));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    fn pr(number: u64, branch: &str, repo: &str) -> PrBranch {
        PrBranch {
            number,
            branch: branch.to_string(),
            head_repo: repo.to_string(),
        }
    }

    fn build(json: &str) -> Build {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn a_build_belongs_to_a_pr_only_when_branch_number_and_repository_agree() {
        let prs = [pr(299533, "me:feature", "me/kibana"), pr(7, "plain", "o/r")];
        let on = |branch: &str, id: &str, repo: &str| {
            is_on(
                &build(&format!(
                    r#"{{"branch": "{branch}", "created_at": "2026-10-01T00:00:00Z",
                        "pull_request": {{"id": "{id}", "repository": "git://github.com/{repo}.git"}}}}"#
                )),
                &prs,
            )
        };
        assert!(on("me:feature", "299533", "Me/Kibana"));
        assert!(on("plain", "7", "o/r"));
        // The same branch name on someone else's PR, or in another repository.
        assert!(!on("me:feature", "1", "me/kibana"));
        assert!(!on("me:feature", "299533", "someone/kibana"));
        assert!(!on("other", "299533", "me/kibana"));
        // A build that isn't of a PR at all.
        assert!(!is_on(
            &build(r#"{"branch": "main", "created_at": "2026-10-01T00:00:00Z"}"#),
            &prs
        ));
    }

    #[test]
    fn reads_a_pr_number_given_as_a_number_too() {
        let prs = [pr(7, "plain", "o/r")];
        let numeric = build(
            r#"{"branch": "plain", "created_at": "2026-10-01T00:00:00Z",
                "pull_request": {"id": 7, "repository": "git://github.com/o/r.git"}}"#,
        );
        assert!(is_on(&numeric, &prs));
    }

    #[test]
    fn counts_builds_in_each_window_and_averages_the_ones_that_finished() {
        let now = at("2026-10-31T00:00:00Z");
        let builds = [
            // In the last 30 days: 10 and 30 minutes, one still unfinished.
            build(
                r#"{"created_at": "2026-10-20T00:00:00Z", "started_at": "2026-10-20T00:00:00Z", "finished_at": "2026-10-20T00:10:00Z"}"#,
            ),
            build(
                r#"{"created_at": "2026-10-25T00:00:00Z", "started_at": "2026-10-25T00:00:00Z", "finished_at": "2026-10-25T00:30:00Z"}"#,
            ),
            build(
                r#"{"created_at": "2026-10-30T00:00:00Z", "started_at": null, "finished_at": null}"#,
            ),
            // The 30 days before: one, 60 minutes.
            build(
                r#"{"created_at": "2026-09-20T00:00:00Z", "started_at": "2026-09-20T00:00:00Z", "finished_at": "2026-09-20T01:00:00Z"}"#,
            ),
            // Older than both.
            build(r#"{"created_at": "2026-08-01T00:00:00Z"}"#),
        ];
        assert_eq!(
            summarize(&builds, now, 30, false),
            CiStats::Ok {
                builds: 3,
                avg_duration_secs: Some(20 * 60),
                duration_sample: 2,
            }
        );
        assert_eq!(
            summarize(&builds, now, 30, true),
            CiStats::Ok {
                builds: 1,
                avg_duration_secs: Some(60 * 60),
                duration_sample: 1,
            }
        );
    }

    #[test]
    fn no_builds_is_zero_with_no_average() {
        assert_eq!(
            summarize(&[], at("2026-10-31T00:00:00Z"), 30, false),
            CiStats::Ok {
                builds: 0,
                avg_duration_secs: None,
                duration_sample: 0,
            }
        );
    }

    #[test]
    fn asks_for_one_pipeline_and_the_hours_ago() {
        let args = list_args("a,b:c", "1440h", "kibana-pull-request");
        for pair in [
            ["--pipeline", "kibana-pull-request"],
            ["--branch", "a,b:c"],
            ["--since", "1440h"],
        ] {
            assert!(args.windows(2).any(|w| w == pair), "{pair:?}");
        }
        assert!(args.contains(&"--no-limit".to_string()));
    }

    #[test]
    fn reads_the_json_past_a_warning() {
        let output = "Warning: BUILDKITE_API_TOKEN is overriding the credential\n[1]";
        assert_eq!(json_part(output, '['), "[1]");
        assert_eq!(json_part("Error: nope", '['), "");
    }

    #[test]
    fn reports_the_last_real_line_of_an_error() {
        assert_eq!(
            last_line("Warning: x\nError: invalid since duration\n\n"),
            "Error: invalid since duration"
        );
        assert_eq!(last_line(""), "bk could not list builds.");
    }

    /// Runs the real CLI and GitHub. Run with
    /// `cargo test -- --ignored --nocapture live_ci_stats`.
    #[test]
    #[ignore = "runs your bk CLI against Buildkite and calls GitHub"]
    fn live_ci_stats() {
        let token = crate::auth::resolve_token(None).expect("gh is logged in");
        let bk = ready().expect("bk is installed and logged in");
        let since = (Utc::now() - chrono::Duration::days(60)).date_naive();
        let prs = tauri::async_runtime::block_on(crate::github::fetch_my_pr_branches(
            &crate::github::http_client(),
            &token.value,
            since,
        ))
        .expect("PRs load");
        let started = Instant::now();
        let builds = my_builds(&bk, &prs, 30, "kibana-pull-request").expect("builds load");
        println!(
            "{} PRs, {} of your builds in 60 days, fetched in {:?}",
            prs.len(),
            builds.len(),
            started.elapsed()
        );
        println!(
            "last 30 days:     {:?}",
            summarize(&builds, Utc::now(), 30, false)
        );
        println!(
            "previous 30 days: {:?}",
            summarize(&builds, Utc::now(), 30, true)
        );
    }

    #[test]
    fn serializes_for_the_ui() {
        let ok = serde_json::to_value(CiStats::Ok {
            builds: 3,
            avg_duration_secs: Some(60),
            duration_sample: 2,
        })
        .unwrap();
        assert_eq!(
            ok,
            serde_json::json!({
                "kind": "ok", "builds": 3, "avgDurationSecs": 60, "durationSample": 2
            })
        );
        assert_eq!(
            serde_json::to_value(CiStats::NotInstalled).unwrap(),
            serde_json::json!({ "kind": "notInstalled" })
        );
    }
}
