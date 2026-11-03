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

/// Where the popover goes: the middle it's centered on, and the work area it
/// has to stay inside, as its left edge and width.
#[derive(Clone, Copy)]
struct Anchor {
    center: f64,
    start: f64,
    length: f64,
}

/// Slows down towards the end. `t` runs from 0 to 1.
fn ease_out(t: f64) -> f64 {
    1.0 - (1.0 - t).powi(3)
}

/// The left edge that centers a `width` window on the anchor, inside the screen.
fn centered_x(anchor: Anchor, width: f64) -> f64 {
    (anchor.center - width / 2.0)
        .min(anchor.start + anchor.length - width)
        .max(anchor.start)
}

/// Part of the way from `from` to `to`.
fn between(from: f64, to: f64, part: f64) -> f64 {
    from + (to - from) * part
}

/// Under the tray icon where its position is known, otherwise (Linux) wherever
/// the window's middle is now.
fn anchor(app: &AppHandle, window: &WebviewWindow) -> Option<Anchor> {
    let scale = window.scale_factor().ok()?;
    let tray = app
        .tray_by_id(TRAY_ID)
        .and_then(|tray| tray.rect().ok().flatten())
        .map(|rect| {
            let position = rect.position.to_physical::<f64>(scale);
            let size = rect.size.to_physical::<f64>(scale);
            (position.x, position.y, position.x + size.width / 2.0)
        });
    let monitor = tray
        .and_then(|(x, y, _)| app.monitor_from_point(x, y).ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())?;
    let work = monitor.work_area();
    let center = match tray {
        Some((_, _, center)) => center,
        None => {
            let at = window.outer_position().ok()?;
            let size = window.outer_size().ok()?;
            f64::from(at.x) + f64::from(size.width) / 2.0
        }
    };
    Some(Anchor {
        center,
        start: work.position.x.into(),
        length: work.size.width.into(),
    })
}

/// Animates on its own thread, since commands wait on the main one that does
/// the resizing.
pub fn set_wide(app: &AppHandle, wide: bool, animated: bool) {
    let Some(window) = app.get_webview_window(POPOVER) else {
        return;
    };
    let (Ok(size), Ok(at), Ok(scale)) = (
        window.outer_size(),
        window.outer_position(),
        window.scale_factor(),
    ) else {
        return;
    };
    let anchor = anchor(app, &window);
    let logical = if wide { WIDE } else { NARROW } * scale;
    // Never wider than the screen it's on.
    let target = anchor.map_or(logical, |anchor| logical.min(anchor.length));
    let from = f64::from(size.width);
    let run = LATEST.fetch_add(1, Ordering::SeqCst) + 1;
    if (from - target).abs() < 1.0 {
        return;
    }
    let from_x = f64::from(at.x);
    let to_x = anchor.map_or(from_x, |anchor| centered_x(anchor, target));
    let (height, y) = (size.height, at.y);
    let steps = if animated { STEPS } else { 1 };
    std::thread::spawn(move || {
        for step in 1..=steps {
            if LATEST.load(Ordering::SeqCst) != run {
                return;
            }
            let part = ease_out(f64::from(step) / f64::from(steps));
            let width = between(from, target, part);
            let x = between(from_x, to_x, part);
            // On the main thread both apply at once. Sent from here they'd be
            // separate messages, with a paint between that shows it growing from
            // the left edge and then jumping back.
            let frame = window.clone();
            let _ = window.run_on_main_thread(move || {
                let _ = frame.set_size(PhysicalSize::new(width.round() as u32, height));
                let _ = frame.set_position(PhysicalPosition::new(x.round() as i32, y));
            });
            if step < steps {
                std::thread::sleep(STEP_TIME);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(center: f64, start: f64, length: f64) -> Anchor {
        Anchor {
            center,
            start,
            length,
        }
    }

    #[test]
    fn eases_from_start_to_end() {
        assert_eq!(ease_out(0.0), 0.0);
        assert_eq!(ease_out(1.0), 1.0);
        assert!(ease_out(0.5) > 0.5);
    }

    #[test]
    fn centers_on_the_tray_icon_where_there_is_room() {
        assert_eq!(centered_x(screen(1000.0, 0.0, 2000.0), 800.0), 600.0);
    }

    #[test]
    fn stays_on_the_screen_near_its_edges() {
        assert_eq!(centered_x(screen(1900.0, 0.0, 2000.0), 800.0), 1200.0);
        assert_eq!(centered_x(screen(100.0, 0.0, 2000.0), 800.0), 0.0);
        // A second screen, to the left of the main one.
        assert_eq!(centered_x(screen(-100.0, -1000.0, 1000.0), 800.0), -800.0);
    }

    #[test]
    fn grows_evenly_from_the_center_at_every_step() {
        let anchor = screen(1000.0, 0.0, 2000.0);
        let (from, to) = (380.0, 800.0);
        let (from_x, to_x) = (centered_x(anchor, from), centered_x(anchor, to));
        for step in 0..=12 {
            let part = ease_out(f64::from(step) / 12.0);
            let middle = between(from_x, to_x, part) + between(from, to, part) / 2.0;
            assert!((middle - 1000.0).abs() < 1e-9);
        }
    }

    #[test]
    fn near_the_edge_both_sides_still_move_together() {
        // There's room for the narrow window, but not for half of the wide one.
        let anchor = screen(1700.0, 0.0, 2000.0);
        let (from, to) = (380.0, 800.0);
        let (from_x, to_x) = (centered_x(anchor, from), centered_x(anchor, to));
        let (x, width) = (between(from_x, to_x, 0.5), between(from, to, 0.5));
        assert!(x < from_x);
        assert!(x + width > from_x + from);
        assert!(x + width <= 2000.0);
    }
}
