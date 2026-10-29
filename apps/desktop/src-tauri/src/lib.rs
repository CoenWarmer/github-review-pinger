mod auth;
mod buildkite;
mod card;
mod gist;
mod github;
mod poller;
mod settings;
mod sound;

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

// The pure logic lives in its own crate; these keep the old `crate::` paths working.
pub use review_pinger_core::{
    calendar, checks, directory, engine, memory, merged, notify, prs, reviews, sections, slack,
    sync, views,
};

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
fn card_current(app: AppHandle) -> Option<card::Shown> {
    card::current(&app)
}

#[tauri::command]
fn card_resize(app: AppHandle, height: f64) {
    card::resize(&app, height);
}

#[tauri::command]
fn card_hovered(app: AppHandle) -> bool {
    card::hovered(&app)
}

#[tauri::command]
fn card_done(app: AppHandle, seq: u64) {
    card::done(&app, seq);
}

/// A summary card has no PR to open, so clicking it shows the list.
#[tauri::command]
fn card_show_popover(app: AppHandle) {
    show_popover(&app);
}

#[tauri::command]
fn send_test_notification(app: AppHandle) {
    card::send_test(&app);
}

#[tauri::command]
fn set_notifications_muted(app: AppHandle, poller: State<Arc<Poller>>, muted: bool) {
    poller.set_notifications_muted(&app, muted);
}

#[tauri::command]
fn set_theme(app: AppHandle, poller: State<Arc<Poller>>, theme: crate::memory::Theme) {
    poller.set_theme(&app, theme);
}

#[tauri::command]
fn set_sound_on_merge(app: AppHandle, poller: State<Arc<Poller>>, enabled: bool) {
    poller.set_sound_on_merge(&app, enabled);
}

/// Sorts a section's PRs, saved and synced with other devices.
#[tauri::command]
fn set_section_sort(app: AppHandle, poller: State<Arc<Poller>>, id: String, key: String) {
    poller.set_section_sort(&app, &id, &key);
}

#[tauri::command]
fn set_my_prs_sections(
    app: AppHandle,
    poller: State<Arc<Poller>>,
    sections: Vec<sections::SectionPref>,
) {
    poller.set_my_prs_sections(&app, sections);
}

#[tauri::command]
async fn load_more_merged(app: AppHandle, poller: State<'_, Arc<Poller>>) -> Result<(), ()> {
    poller.load_more_merged(&app).await;
    Ok(())
}

#[tauri::command]
async fn search_pull_requests(
    text: String,
    poller: State<'_, Arc<Poller>>,
) -> Result<Vec<review_pinger_core::github::types::FoundPullRequest>, String> {
    poller.search_pull_requests(&text).await
}

#[tauri::command]
async fn my_teams(poller: State<'_, Arc<Poller>>) -> Result<Vec<String>, String> {
    poller.my_teams().await
}

#[tauri::command]
async fn load_stats(
    team: Option<String>,
    days: i64,
    previous: bool,
    poller: State<'_, Arc<Poller>>,
) -> Result<github::StatsData, String> {
    poller.stats(team, days, previous).await
}

#[tauri::command]
async fn load_review_stats(
    team: Option<String>,
    days: i64,
    previous: bool,
    poller: State<'_, Arc<Poller>>,
) -> Result<github::ReviewStatsData, String> {
    poller.review_stats(team, days, previous).await
}

/// Statistics over the builds on PRs you authored, from the Buildkite CLI.
/// Always answers: a missing CLI or login is part of the answer, for the UI to
/// explain.
#[tauri::command]
async fn load_ci_stats(
    days: i64,
    previous: bool,
    poller: State<'_, Arc<Poller>>,
) -> Result<buildkite::CiStats, ()> {
    Ok(poller.ci_stats(days, previous).await)
}

/// Chooses the Buildkite pipeline the CI statistics count builds in.
#[tauri::command]
fn set_buildkite_pipeline(
    app: AppHandle,
    poller: State<Arc<Poller>>,
    name: String,
) -> Result<(), String> {
    poller.set_buildkite_pipeline(&app, &name)
}

#[tauri::command]
fn add_view(app: AppHandle, poller: State<Arc<Poller>>, name: String, query: String) {
    poller.add_view(&app, name, query);
}

#[tauri::command]
fn update_view(
    app: AppHandle,
    poller: State<Arc<Poller>>,
    id: String,
    name: String,
    query: String,
) {
    poller.update_view(&app, &id, name, query);
}

#[tauri::command]
fn remove_view(app: AppHandle, poller: State<Arc<Poller>>, id: String) {
    poller.remove_view(&app, &id);
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
fn remove_team_channel(app: AppHandle, poller: State<Arc<Poller>>, team: String) {
    poller.remove_team_channel(&app, &team);
}

#[tauri::command]
fn refresh(poller: State<Arc<Poller>>) {
    poller.refresh();
}

#[tauri::command]
async fn save_token(
    app: AppHandle,
    token: String,
    sync: bool,
    poller: State<'_, Arc<Poller>>,
) -> Result<(), String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Token is empty".into());
    }
    tauri::async_runtime::spawn_blocking(move || auth::save_pat(&token))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Could not store token in the keychain: {e}"))?;
    if sync {
        poller.set_sync_enabled(&app, true);
    }
    // Pasting a token is a choice to use it.
    poller.set_auth_source(&app, auth::TokenSource::Pat);
    Ok(())
}

/// Whether a token could sync, so the sign-in form can offer it.
#[tauri::command]
async fn token_can_sync(token: String, poller: State<'_, Arc<Poller>>) -> Result<bool, ()> {
    Ok(poller.token_can_sync(token.trim()).await)
}

#[tauri::command]
fn set_sync_enabled(app: AppHandle, poller: State<Arc<Poller>>, enabled: bool) {
    poller.set_sync_enabled(&app, enabled);
}

#[tauri::command]
async fn clear_token(app: AppHandle, poller: State<'_, Arc<Poller>>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(auth::clear_pat)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Could not remove token from the keychain: {e}"))?;
    poller.set_auth_source(&app, auth::TokenSource::Gh);
    Ok(())
}

#[tauri::command]
fn set_auth_source(app: AppHandle, poller: State<Arc<Poller>>, source: auth::TokenSource) {
    poller.set_auth_source(&app, source);
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
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_positioner::init())
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            refresh,
            visit,
            card_current,
            card_resize,
            card_done,
            card_hovered,
            card_show_popover,
            send_test_notification,
            set_notifications_muted,
            set_theme,
            set_sound_on_merge,
            set_my_prs_sections,
            set_section_sort,
            load_more_merged,
            search_pull_requests,
            my_teams,
            load_stats,
            load_review_stats,
            load_ci_stats,
            set_buildkite_pipeline,
            add_view,
            update_view,
            remove_view,
            set_team_channel,
            remove_team_channel,
            save_token,
            token_can_sync,
            set_sync_enabled,
            clear_token,
            set_auth_source,
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

            app.manage(card::Cards::default());
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
