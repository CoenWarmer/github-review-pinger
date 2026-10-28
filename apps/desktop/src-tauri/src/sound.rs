//! Sounds for events the user opts into in Settings. Bundled into the
//! binary, so there's nothing to find on disk at runtime.

use std::io::Cursor;

use rodio::DeviceSinkBuilder;

const PR_MERGED: &[u8] = include_bytes!("../sounds/pr-merged.wav");

/// Plays the "PR merged" sound on its own thread, so a slow audio device
/// never holds up polling. Failures are only logged.
pub fn play_pr_merged() {
    std::thread::spawn(|| {
        if let Err(e) = play(PR_MERGED) {
            log::warn!("Could not play the PR-merged sound: {e}");
        }
    });
}

/// The device sink has to live until playback ends, so this blocks the
/// thread it's called on.
///
/// Opened with the OS's own buffer size rather than `open_default_sink`'s
/// fixed default, which some devices (reporting a narrower supported range)
/// refuse outright.
fn play(bytes: &'static [u8]) -> Result<(), String> {
    let mut device = DeviceSinkBuilder::from_default_device()
        .map_err(|e| e.to_string())?
        .with_buffer_size(rodio::cpal::BufferSize::Default)
        .open_stream()
        .map_err(|e| e.to_string())?;
    device.log_on_drop(false);
    let player = rodio::play(device.mixer(), Cursor::new(bytes)).map_err(|e| e.to_string())?;
    player.sleep_until_end();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Opens the real output device, so it's excluded from the default run.
    #[test]
    #[ignore]
    fn the_bundled_sound_plays() {
        play(PR_MERGED).unwrap();
    }
}
