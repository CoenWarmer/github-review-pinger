//! Looks for a newer release on GitHub now and then, and installs it when
//! asked. The UI shows a banner for what's found; nothing installs by itself.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Let the app settle before the first look.
const FIRST_CHECK: Duration = Duration::from_secs(30);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// Sent to the UI when a newer version is found.
const FOUND_EVENT: &str = "update-available";

/// What the banner shows.
#[derive(Clone, Serialize)]
pub struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// The newest update found, kept to install when the user says so.
#[derive(Default)]
pub struct Updates {
    found: Mutex<Option<(Update, UpdateInfo)>>,
}

/// Whether this build can replace itself: not a dev build, and on Linux only
/// the AppImage, since a .deb or .rpm belongs to the package manager.
pub fn enabled() -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    !cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_some()
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            check(&app).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

async fn check(app: &AppHandle) {
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(e) => {
            log::warn!("Update checking is unavailable: {e}");
            return;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let info = UpdateInfo {
                version: update.version.clone(),
                notes: update.body.clone(),
            };
            log::info!("Version {} is available", info.version);
            *app.state::<Updates>().found.lock().unwrap() = Some((update, info.clone()));
            if let Err(e) = app.emit(FOUND_EVENT, &info) {
                log::warn!("Could not announce the update: {e}");
            }
        }
        Ok(None) => {}
        Err(e) => log::warn!("Could not check for updates: {e}"),
    }
}

/// The update found before the UI started listening, if any.
#[tauri::command]
pub fn pending_update(updates: State<Updates>) -> Option<UpdateInfo> {
    updates
        .found
        .lock()
        .unwrap()
        .as_ref()
        .map(|(_, info)| info.clone())
}

/// Downloads and installs the update found, then restarts into it.
#[tauri::command]
pub async fn install_update(app: AppHandle, updates: State<'_, Updates>) -> Result<(), String> {
    let update = updates
        .found
        .lock()
        .unwrap()
        .as_ref()
        .map(|(update, _)| update.clone())
        .ok_or("No update is waiting.")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart()
}
