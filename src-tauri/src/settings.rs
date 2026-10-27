use std::collections::HashMap;
use std::fs;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// User settings, read from `settings.json` in the app config directory on
/// every poll so edits apply without a restart.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Accounts whose activity doesn't count as a human response, for bots
    /// that post as regular users rather than GitHub Apps.
    pub ignored_logins: Vec<String>,
    /// PRs without human activity or pushes for this long are dormant: listed
    /// separately and left out of the tray count.
    pub dormant_after_days: u32,
    /// Nudge about a PR waiting on review after this much weekday time
    /// without a response.
    pub nudge_after_hours: u32,
    /// Nudge about a PR waiting on your review after this much weekday time.
    pub review_nudge_after_hours: u32,
    /// How many minutes checks usually take, by `owner/repo`, until enough
    /// runs have been timed to learn it.
    pub check_durations: HashMap<String, u32>,
    /// Slack channel links by lowercase `org/team-slug`.
    pub team_channels: HashMap<String, String>,
    pub slack_opens_in: SlackOpensIn,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SlackOpensIn {
    #[default]
    App,
    Browser,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ignored_logins: Vec::new(),
            dormant_after_days: 30,
            nudge_after_hours: 24,
            review_nudge_after_hours: 24,
            check_durations: HashMap::new(),
            team_channels: HashMap::new(),
            slack_opens_in: SlackOpensIn::default(),
        }
    }
}

pub fn load(app: &AppHandle) -> Settings {
    let Ok(dir) = app.path().app_config_dir() else {
        return Settings::default();
    };
    let path = dir.join("settings.json");
    match fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_else(|e| {
            log::warn!("Ignoring invalid {}: {e}", path.display());
            Settings::default()
        }),
        Err(_) => Settings::default(),
    }
}
