//! Notification cards: a small window next to the tray icon that shows one
//! notification at a time, queueing the rest.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::notify::{Accent, Notification};
use crate::poller::TRAY_ID;

const CARD: &str = "card";
const WIDTH: f64 = 380.0;
/// Gap between the card and the tray icon or screen edge, in logical pixels.
const MARGIN: f64 = 6.0;

#[derive(Default)]
pub struct Cards {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    queue: VecDeque<Notification>,
    current: Option<Shown>,
    /// Numbers the cards, so a late "done" from a card that is already gone
    /// can't dismiss the one that replaced it.
    seq: u64,
}

/// The card on screen.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shown {
    pub seq: u64,
    #[serde(flatten)]
    pub notification: Notification,
}

/// Queues `notifications`, showing the first right away when no card is up.
pub fn enqueue(app: &AppHandle, notifications: Vec<Notification>) {
    if notifications.is_empty() {
        return;
    }
    let idle = {
        let cards = app.state::<Cards>();
        let mut state = cards.state.lock().unwrap();
        state.queue.extend(notifications);
        state.current.is_none()
    };
    if idle {
        show_next(app);
    }
}

/// The card on screen, for a card window that has just loaded.
pub fn current(app: &AppHandle) -> Option<Shown> {
    app.state::<Cards>().state.lock().unwrap().current.clone()
}

/// The card with this number was dismissed or timed out.
pub fn done(app: &AppHandle, seq: u64) {
    {
        let cards = app.state::<Cards>();
        let mut state = cards.state.lock().unwrap();
        match &state.current {
            Some(shown) if shown.seq == seq => state.current = None,
            _ => return,
        }
    }
    show_next(app);
}

/// Drops the card on screen and everything queued.
pub fn clear(app: &AppHandle) {
    {
        let cards = app.state::<Cards>();
        let mut state = cards.state.lock().unwrap();
        state.queue.clear();
        state.current = None;
    }
    hide(app);
}

/// Sizes the window to its content, then shows it. The card calls this after
/// every render, so it appears at its final size and place.
pub fn resize(app: &AppHandle, height: f64) {
    if current(app).is_none() {
        return;
    }
    let Some(window) = app.get_webview_window(CARD) else {
        return;
    };
    let _ = window.set_size(LogicalSize::new(WIDTH, height));
    place(app, &window);
    let _ = window.show();
}

/// Whether the pointer is over the card. Asked of the OS because a window that
/// isn't focused doesn't reliably report the pointer entering or leaving.
pub fn hovered(app: &AppHandle) -> bool {
    let Some(window) = app.get_webview_window(CARD) else {
        return false;
    };
    let (Ok(cursor), Ok(position), Ok(size)) = (
        window.cursor_position(),
        window.outer_position(),
        window.outer_size(),
    ) else {
        return false;
    };
    let (x, y) = (f64::from(position.x), f64::from(position.y));
    (x..x + f64::from(size.width)).contains(&cursor.x)
        && (y..y + f64::from(size.height)).contains(&cursor.y)
}

fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(CARD) {
        let _ = window.hide();
    }
}

fn show_next(app: &AppHandle) {
    let shown = {
        let cards = app.state::<Cards>();
        let mut state = cards.state.lock().unwrap();
        let Some(notification) = state.queue.pop_front() else {
            drop(state);
            hide(app);
            return;
        };
        state.seq += 1;
        let shown = Shown {
            seq: state.seq,
            notification,
        };
        state.current = Some(shown.clone());
        shown
    };

    match app.get_webview_window(CARD) {
        // The card then calls `resize`, which shows the window.
        Some(_) => {
            if let Err(e) = app.emit_to(CARD, "card", &shown) {
                log::warn!("Could not send the card: {e}");
            }
        }
        // A new window asks for the current card once it has loaded.
        None => {
            if let Err(e) = create(app) {
                log::warn!("Could not create the notification card: {e}");
                app.state::<Cards>().state.lock().unwrap().current = None;
            }
        }
    }
}

fn create(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, CARD, WebviewUrl::App("index.html?card".into()))
        .inner_size(WIDTH, 120.0)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .focusable(false)
        .shadow(false)
        .build()
}

/// A pixel rectangle: left, top, width, height.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Area {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// Where the top-left of a `w` x `h` card goes. Next to the tray icon, towards
/// the middle of the screen: below it when the icon is in the top half of the
/// work area, above it when in the bottom half. Without a tray position
/// (Linux) the card goes in the top-right corner. Always inside the work area.
fn position(tray: Option<Area>, work: Area, w: f64, h: f64, margin: f64) -> (f64, f64) {
    let clamp = |value: f64, start: f64, length: f64, size: f64| {
        value.min(start + length - size).max(start)
    };
    let (x, y) = match tray {
        Some(tray) => {
            let x = tray.x + tray.w / 2.0 - w / 2.0;
            let in_top_half = tray.y + tray.h / 2.0 < work.y + work.h / 2.0;
            let y = if in_top_half {
                tray.y + tray.h + margin
            } else {
                tray.y - h - margin
            };
            (x, y)
        }
        None => (work.x + work.w - w - margin * 2.0, work.y + margin * 2.0),
    };
    (clamp(x, work.x, work.w, w), clamp(y, work.y, work.h, h))
}

fn place(app: &AppHandle, window: &WebviewWindow) {
    let tray = app
        .tray_by_id(TRAY_ID)
        .and_then(|tray| tray.rect().ok().flatten())
        .map(|rect| {
            let scale = window.scale_factor().unwrap_or(1.0);
            let position = rect.position.to_physical::<f64>(scale);
            let size = rect.size.to_physical::<f64>(scale);
            Area {
                x: position.x,
                y: position.y,
                w: size.width,
                h: size.height,
            }
        });
    let monitor = tray
        .and_then(|t| app.monitor_from_point(t.x, t.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let work = monitor.work_area();
    let work = Area {
        x: work.position.x.into(),
        y: work.position.y.into(),
        w: work.size.width.into(),
        h: work.size.height.into(),
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let scale = monitor.scale_factor();
    let (x, y) = position(
        tray,
        work,
        size.width.into(),
        size.height.into(),
        MARGIN * scale,
    );
    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

static NEXT_SAMPLE: AtomicUsize = AtomicUsize::new(0);

/// One sample card per call, rotating through the event types.
pub fn send_test(app: &AppHandle) {
    let sample = |accent, label: &str, title: &str, detail: &str| Notification {
        accent,
        label: label.to_string(),
        title: title.to_string(),
        meta: Some("elastic/kibana#12345".to_string()),
        detail: Some(detail.to_string()),
        pr_id: None,
        url: Some("https://github.com/elastic/kibana/pull/12345".to_string()),
    };
    let samples = [
        sample(
            Accent::Info,
            "Review requested",
            "Add a progress bar to checks",
            "ana requested your review",
        ),
        sample(
            Accent::Info,
            "Re-requested",
            "Add a progress bar to checks",
            "ana re-requested your review",
        ),
        sample(
            Accent::Success,
            "Approved",
            "Fix the flaky tray test",
            "bo approved",
        ),
        sample(
            Accent::Danger,
            "Changes requested",
            "Fix the flaky tray test",
            "cy requested changes",
        ),
        sample(
            Accent::Info,
            "New feedback",
            "Fix the flaky tray test",
            "di commented",
        ),
        sample(
            Accent::Warning,
            "Waiting on your review",
            "Add a progress bar to checks",
            "Still waiting on your review",
        ),
    ];
    let index = NEXT_SAMPLE.fetch_add(1, Ordering::Relaxed) % samples.len();
    enqueue(app, vec![samples[index].clone()]);
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Area = Area {
        x: 0.0,
        y: 25.0,
        w: 1440.0,
        h: 875.0,
    };

    fn tray(x: f64, y: f64) -> Area {
        Area {
            x,
            y,
            w: 24.0,
            h: 24.0,
        }
    }

    #[test]
    fn sits_below_a_tray_at_the_top() {
        let (x, y) = position(Some(tray(1000.0, 0.0)), SCREEN, 380.0, 100.0, 6.0);
        assert_eq!(x, 1000.0 + 12.0 - 190.0);
        assert_eq!(y, 24.0 + 6.0);
    }

    #[test]
    fn sits_above_a_tray_at_the_bottom() {
        let (_, y) = position(Some(tray(1000.0, 876.0)), SCREEN, 380.0, 100.0, 6.0);
        assert_eq!(y, 876.0 - 100.0 - 6.0);
    }

    #[test]
    fn stays_inside_the_work_area() {
        let (x, _) = position(Some(tray(1430.0, 0.0)), SCREEN, 380.0, 100.0, 6.0);
        assert_eq!(x, 1440.0 - 380.0);
        let (x, _) = position(Some(tray(0.0, 0.0)), SCREEN, 380.0, 100.0, 6.0);
        assert_eq!(x, 0.0);
    }

    #[test]
    fn without_a_tray_goes_top_right() {
        assert_eq!(
            position(None, SCREEN, 380.0, 100.0, 6.0),
            (1440.0 - 380.0 - 12.0, 25.0 + 12.0)
        );
    }
}
