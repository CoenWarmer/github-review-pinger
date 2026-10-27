use std::fs;

use tauri::{AppHandle, Manager};

pub use review_pinger_core::settings::{Settings, SlackOpensIn};

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
