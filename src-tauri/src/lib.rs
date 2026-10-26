mod auth;
mod github;
mod poller;
mod prs;
mod settings;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};
use tauri_plugin_positioner::{Position, WindowExt};

use poller::{Poller, Snapshot};

const POPOVER: &str = "main";

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
        poller.refresh_if_stale();
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_positioner::init())
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            refresh,
            save_token,
            clear_token
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
                .icon(app.default_window_icon().unwrap().clone())
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
