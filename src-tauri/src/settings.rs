use std::fs;

use serde::Deserialize;
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
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ignored_logins: Vec::new(),
            dormant_after_days: 30,
            nudge_after_hours: 24,
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
