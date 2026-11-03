//! The popover's width: narrow for the lists, wide for what needs the room.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::POPOVER;
use crate::poller::TRAY_ID;

/// Logical pixels. The narrow one matches `tauri.conf.json`.
const NARROW: f64 = 380.0;
const WIDE: f64 = 800.0;

const STEPS: u32 = 12;
const STEP_TIME: Duration = Duration::from_millis(16);

/// Numbers the resizes, so a newer one stops an animation still running.
static LATEST: AtomicU64 = AtomicU64::new(0);

/// Slows down towards the end. `t` runs from 0 to 1.
fn ease_out(t: f64) -> f64 {
    1.0 - (1.0 - t).powi(3)
}

/// The left edge that centers a `width` window on `center`, inside the screen
/// span from `start` that's `length` long.
fn centered_x(center: f64, width: f64, start: f64, length: f64) -> f64 {
    (center - width / 2.0)
        .min(start + length - width)
        .max(start)
}

/// The middle of the tray icon, and the work area's left edge and width: where
/// the popover has to fit. `None` where there's no tray position (Linux), whose
/// window isn't anchored to the tray.
fn anchor(app: &AppHandle, window: &WebviewWindow) -> Option<(f64, f64, f64)> {
    let rect = app.tray_by_id(TRAY_ID)?.rect().ok()??;
    let scale = window.scale_factor().ok()?;
    let position = rect.position.to_physical::<f64>(scale);
    let size = rect.size.to_physical::<f64>(scale);
    let monitor = app.monitor_from_point(position.x, position.y).ok()??;
    let work = monitor.work_area();
    Some((
        position.x + size.width / 2.0,
        work.position.x.into(),
        work.size.width.into(),
    ))
}

/// Sets the width, keeping the height and top edge, and moves the window so it
/// stays under the tray icon.
fn apply(window: &WebviewWindow, width: f64, height: u32, anchor: Option<(f64, f64, f64)>) {
    let _ = window.set_size(PhysicalSize::new(width.round() as u32, height));
    if let (Some((center, start, length)), Ok(at)) = (anchor, window.outer_position()) {
        let x = centered_x(center, width, start, length);
        let _ = window.set_position(PhysicalPosition::new(x.round() as i32, at.y));
    }
}

/// Moves the popover sideways if it reaches past the edge of the screen.
pub fn keep_on_screen(app: &AppHandle, window: &WebviewWindow) {
    if let (Some(anchor), Ok(size)) = (anchor(app, window), window.outer_size()) {
        apply(window, size.width.into(), size.height, Some(anchor));
    }
}

/// Runs on its own thread, since commands wait on the main one that does the
/// resizing.
pub fn set_wide(app: &AppHandle, wide: bool, animated: bool) {
    let Some(window) = app.get_webview_window(POPOVER) else {
        return;
    };
    let (Ok(size), Ok(scale)) = (window.outer_size(), window.scale_factor()) else {
        return;
    };
    let anchor = anchor(app, &window);
    let logical = if wide { WIDE } else { NARROW };
    // Never wider than the screen it's on.
    let target = anchor.map_or(logical * scale, |(_, _, length)| {
        (logical * scale).min(length)
    });
    let from = f64::from(size.width);
    let run = LATEST.fetch_add(1, Ordering::SeqCst) + 1;
    if (from - target).abs() < 1.0 {
        return;
    }
    let steps = if animated { STEPS } else { 1 };
    std::thread::spawn(move || {
        for step in 1..=steps {
            if LATEST.load(Ordering::SeqCst) != run {
                return;
            }
            let eased = ease_out(f64::from(step) / f64::from(steps));
            apply(&window, from + (target - from) * eased, size.height, anchor);
            if step < steps {
                std::thread::sleep(STEP_TIME);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eases_from_start_to_end() {
        assert_eq!(ease_out(0.0), 0.0);
        assert_eq!(ease_out(1.0), 1.0);
        assert!(ease_out(0.5) > 0.5);
    }

    #[test]
    fn centers_on_the_tray_icon_where_there_is_room() {
        assert_eq!(centered_x(1000.0, 800.0, 0.0, 2000.0), 600.0);
    }

    #[test]
    fn stays_on_the_screen_near_its_edges() {
        assert_eq!(centered_x(1900.0, 800.0, 0.0, 2000.0), 1200.0);
        assert_eq!(centered_x(100.0, 800.0, 0.0, 2000.0), 0.0);
        // A second screen, to the left of the main one.
        assert_eq!(centered_x(-100.0, 800.0, -1000.0, 1000.0), -800.0);
    }
}
