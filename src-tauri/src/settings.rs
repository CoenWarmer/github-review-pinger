use std::fs;

use serde::Deserialize;
use tauri::{AppHandle, Manager};

/// User settings, read from `settings.json` in the app config directory on
/// every poll so edits apply without a restart.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Accounts whose activity doesn't count as a human response, for bots
    /// that post as regular users rather than GitHub Apps.
    pub ignored_logins: Vec<String>,
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
