//! State that survives restarts: which responses and review requests have been
//! notified, which quiet and waiting periods have been nudged, and snoozes.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    /// The last successful poll; `None` before the first one ever.
    pub last_poll_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub pull_requests: HashMap<String, PrMemory>,
    #[serde(default)]
    pub autostart_initialized: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrMemory {
    /// Responses at or before this time have been notified (or predate tracking).
    pub seen_until: DateTime<Utc>,
    /// The `quiet_since` of the quiet period that has already been nudged.
    #[serde(default)]
    pub nudged_for: Option<DateTime<Utc>>,
    #[serde(default)]
    pub snoozed_until: Option<DateTime<Utc>>,
    /// Review requests at or before this time have been notified; `None`
    /// falls back to `seen_until`.
    #[serde(default)]
    pub requested_seen_until: Option<DateTime<Utc>>,
}

impl PrMemory {
    pub fn new(seen_until: DateTime<Utc>) -> Self {
        Self {
            seen_until,
            nudged_for: None,
            snoozed_until: None,
            requested_seen_until: None,
        }
    }
}

impl Memory {
    pub fn load(path: &Path) -> Self {
        match fs::read_to_string(path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_else(|e| {
                log::warn!("Starting fresh, {} is invalid: {e}", path.display());
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    /// Writes via a temporary file so a crash mid-write can't corrupt the state.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        fs::rename(tmp, path)
    }

    pub fn snoozes(&self) -> HashMap<String, DateTime<Utc>> {
        self.pull_requests
            .iter()
            .filter_map(|(id, pr)| pr.snoozed_until.map(|until| (id.clone(), until)))
            .collect()
    }

    pub fn set_snooze(&mut self, id: &str, until: Option<DateTime<Utc>>, now: DateTime<Utc>) {
        self.pull_requests
            .entry(id.to_string())
            .or_insert_with(|| PrMemory::new(now))
            .snoozed_until = until;
    }
}
