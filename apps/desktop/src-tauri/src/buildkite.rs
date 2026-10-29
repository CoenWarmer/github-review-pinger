//! CI build statistics from the Buildkite CLI (`bk`), for Settings. Desktop
//! only: the CLI is local, uses whatever login it already has, and the app
//! stores nothing for it. Without the CLI, or without a login, the answer says
//! so and the UI explains how to set it up.

use std::env;
use std::path::PathBuf;
use std::process::Command;
use std::sync::mpsc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// How long to wait for the CLI before giving up on it.
const TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Debug, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CiStats {
    /// Builds you created in the window, and how long the finished ones took.
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
fn run(bk: &PathBuf, args: &[String]) -> Result<(bool, String, String), String> {
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

/// The email of the Buildkite user `bk` is logged in as.
fn user_email(output: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Status {
        token: Token,
    }
    #[derive(Deserialize)]
    struct Token {
        user: User,
    }
    #[derive(Deserialize)]
    struct User {
        email: String,
    }
    let status: Status = serde_json::from_str(json_part(output, '{')).ok()?;
    Some(status.token.user.email).filter(|email| !email.is_empty())
}

#[derive(Deserialize)]
struct Build {
    started_at: Option<DateTime<Utc>>,
    finished_at: Option<DateTime<Utc>>,
}

/// The count of builds in `output` (`bk build list --json`) and the average
/// time the ones with a start and a finish took.
fn summarize(output: &str) -> Result<CiStats, String> {
    let builds: Vec<Build> = serde_json::from_str(json_part(output, '['))
        .map_err(|e| format!("Unexpected output from bk: {e}"))?;
    let durations: Vec<i64> = builds
        .iter()
        .filter_map(|build| Some((build.finished_at? - build.started_at?).num_seconds()))
        .filter(|seconds| *seconds >= 0)
        .collect();
    Ok(CiStats::Ok {
        builds: builds.len(),
        avg_duration_secs: (!durations.is_empty())
            .then(|| (durations.iter().sum::<i64>() / durations.len() as i64) as u64),
        duration_sample: durations.len(),
    })
}

/// `bk build list` arguments for builds created by `email` in the last
/// `days`, or with `previous` in the same number of days before those.
fn list_args(email: &str, days: i64, previous: bool) -> Vec<String> {
    let hours = days * 24;
    let mut args: Vec<String> = ["build", "list", "--creator", email, "--no-limit", "--json"]
        .map(String::from)
        .into();
    // `--since` and `--until` are how long ago, in Go durations, which have no days.
    if previous {
        args.extend(["--since".into(), format!("{}h", 2 * hours)]);
        args.extend(["--until".into(), format!("{hours}h")]);
    } else {
        args.extend(["--since".into(), format!("{hours}h")]);
    }
    args
}

/// The statistics over builds you created. Blocking: it runs the CLI.
pub fn ci_stats(days: i64, previous: bool) -> CiStats {
    let Some(bk) = find_bk() else {
        return CiStats::NotInstalled;
    };
    let status = match run(&bk, &["auth".into(), "status".into()]) {
        Ok(result) => result,
        Err(message) => return CiStats::Error { message },
    };
    let Some(email) = status.0.then(|| user_email(&status.1)).flatten() else {
        return CiStats::NotLoggedIn;
    };
    match run(&bk, &list_args(&email, days, previous)) {
        Ok((true, stdout, _)) => {
            summarize(&stdout).unwrap_or_else(|message| CiStats::Error { message })
        }
        Ok((false, _, stderr)) => CiStats::Error {
            message: stderr
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty() && !line.starts_with("Warning"))
                .unwrap_or("bk could not list builds.")
                .trim()
                .to_string(),
        },
        Err(message) => CiStats::Error { message },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn averages_the_builds_that_have_a_start_and_a_finish() {
        let output = r#"Warning: BUILDKITE_API_TOKEN is overriding the credential
[
  {"started_at": "2026-10-01T10:00:00Z", "finished_at": "2026-10-01T10:10:00Z"},
  {"started_at": "2026-10-02T10:00:00Z", "finished_at": "2026-10-02T10:30:00Z"},
  {"started_at": null, "finished_at": null},
  {"started_at": "2026-10-03T10:00:00Z", "finished_at": null}
]"#;
        assert_eq!(
            summarize(output),
            Ok(CiStats::Ok {
                builds: 4,
                avg_duration_secs: Some(20 * 60),
                duration_sample: 2,
            })
        );
    }

    #[test]
    fn no_builds_is_zero_with_no_average() {
        assert_eq!(
            summarize("[]"),
            Ok(CiStats::Ok {
                builds: 0,
                avg_duration_secs: None,
                duration_sample: 0,
            })
        );
    }

    #[test]
    fn output_that_isnt_a_list_is_an_error() {
        assert!(summarize("Error: nope").is_err());
    }

    #[test]
    fn reads_the_logged_in_users_email_past_a_warning() {
        let output = "Warning: BUILDKITE_API_TOKEN is overriding the credential\n{\"organization_slug\": \"elastic\", \"token\": {\"user\": {\"name\": \"A\", \"email\": \"a@b.c\"}}}";
        assert_eq!(user_email(output).as_deref(), Some("a@b.c"));
        assert_eq!(user_email("not json"), None);
    }

    #[test]
    fn asks_for_the_right_hours_ago() {
        let current = list_args("a@b.c", 30, false);
        assert_eq!(current[..4], ["build", "list", "--creator", "a@b.c"]);
        assert!(current.windows(2).any(|w| w == ["--since", "720h"]));
        assert!(!current.contains(&"--until".to_string()));

        let earlier = list_args("a@b.c", 30, true);
        assert!(earlier.windows(2).any(|w| w == ["--since", "1440h"]));
        assert!(earlier.windows(2).any(|w| w == ["--until", "720h"]));
    }

    /// Runs the real CLI. Run with `cargo test -- --ignored --nocapture live_ci_stats`.
    #[test]
    #[ignore = "runs your bk CLI against Buildkite"]
    fn live_ci_stats() {
        println!("last 30 days:     {:?}", ci_stats(30, false));
        println!("previous 30 days: {:?}", ci_stats(30, true));
        // Where there are builds to average, if the recent months have none.
        println!("last 365 days:    {:?}", ci_stats(365, false));
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
