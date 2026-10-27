mod auth;
mod calendar;
mod checks;
mod github;
mod memory;
mod notify;
mod poller;
mod prs;
mod reviews;
mod settings;
mod slack;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
#[cfg(not(target_os = "linux"))]
use tauri_plugin_positioner::{Position, WindowExt};

use poller::{Poller, Snapshot};

const POPOVER: &str = "main";

// macOS tints a black template image to match the menu bar. Windows and Linux
// get a white glyph, matching their default dark taskbars and panels.
#[cfg(target_os = "macos")]
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray/tray-template@2x.png");
#[cfg(not(target_os = "macos"))]
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray/tray-white.png");

// Clicking the tray icon while the popover is open first blurs (and hides) the
// popover, then delivers the click. Without this guard the click would reopen it.
const REOPEN_GUARD_MS: u64 = 250;
static LAST_HIDDEN_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn show_popover(app: &AppHandle) {
    let Some(window) = app.get_webview_window(POPOVER) else {
        return;
    };
    if let Some(poller) = app.try_state::<Arc<Poller>>() {
        poller::on_popover_open(app, poller.inner().clone());
    }
    #[cfg(not(target_os = "linux"))]
    let _ = window.move_window(Position::TrayBottomCenter);
    let _ = window.show();
    let _ = window.set_focus();
}

fn toggle_popover(app: &AppHandle) {
    let Some(window) = app.get_webview_window(POPOVER) else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else if now_ms() - LAST_HIDDEN_MS.load(Ordering::Relaxed) > REOPEN_GUARD_MS {
        show_popover(app);
    }
}

#[tauri::command]
fn get_snapshot(poller: State<Arc<Poller>>) -> Snapshot {
    poller.snapshot()
}

#[tauri::command]
fn visit(poller: State<Arc<Poller>>, id: String) {
    poller.visit(&id);
}

#[tauri::command]
fn set_team_channel(
    app: AppHandle,
    poller: State<Arc<Poller>>,
    team: String,
    link: String,
) -> Result<(), String> {
    poller.set_team_channel(&app, &team, link.trim())
}

#[tauri::command]
fn refresh(poller: State<Arc<Poller>>) {
    poller.refresh();
}

#[tauri::command]
async fn save_token(token: String, poller: State<'_, Arc<Poller>>) -> Result<(), String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Token is empty".into());
    }
    tauri::async_runtime::spawn_blocking(move || auth::save_pat(&token))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Could not store token in the keychain: {e}"))?;
    poller.refresh();
    Ok(())
}

#[tauri::command]
async fn clear_token(poller: State<'_, Arc<Poller>>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(auth::clear_pat)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Could not remove token from the keychain: {e}"))?;
    poller.refresh();
    Ok(())
}

#[tauri::command]
fn snooze(app: AppHandle, poller: State<Arc<Poller>>, id: String, days: u32) {
    let until = chrono::Utc::now() + chrono::Duration::days(days.into());
    poller.set_snooze(&app, &id, Some(until));
}

#[tauri::command]
fn unsnooze(app: AppHandle, poller: State<Arc<Poller>>, id: String) {
    poller.set_snooze(&app, &id, None);
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    let result = if enabled {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    };
    result.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_positioner::init())
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            refresh,
            visit,
            set_team_channel,
            save_token,
            clear_token,
            snooze,
            unsnooze,
            get_autostart,
            set_autostart
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // On Linux the tray can only open a menu, so the PR list lives in a
            // regular window instead of a popover.
            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window(POPOVER) {
                window.set_decorations(true)?;
                window.set_skip_taskbar(false)?;
                window.set_always_on_top(false)?;
            }

            let open = MenuItem::with_id(app, "open", "Open PR list", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            TrayIconBuilder::with_id(poller::TRAY_ID)
                .icon(Image::from_bytes(TRAY_ICON)?)
                .icon_as_template(cfg!(target_os = "macos"))
                .tooltip("Review Pinger")
                .menu(&menu)
                .show_menu_on_left_click(cfg!(target_os = "linux"))
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_popover(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_popover(tray.app_handle());
                    }
                })
                .build(app)?;

            let poller = poller::start(app.handle());
            // Launch at login defaults to on, but a dev build shouldn't
            // register itself as a login item.
            if !cfg!(debug_assertions)
                && poller.claim_first_launch()
                && let Err(e) = app.autolaunch().enable()
            {
                log::warn!("Could not enable launch at login: {e}");
            }
            app.manage(poller);

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != POPOVER {
                return;
            }
            match event {
                // Keep the app alive in the tray when the window is closed.
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                #[cfg(not(target_os = "linux"))]
                WindowEvent::Focused(false) => {
                    LAST_HIDDEN_MS.store(now_ms(), Ordering::Relaxed);
                    let _ = window.hide();
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
