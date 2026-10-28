//! State that survives restarts: which responses and review requests have been
//! notified, which quiet and waiting periods have been nudged, and snoozes.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::auth::TokenSource;
use crate::sections::{self, SectionPref};
use crate::sync::SyncMemory;
use crate::views::View;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    /// The last successful poll; `None` before the first one ever.
    pub last_poll_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub pull_requests: HashMap<String, PrMemory>,
    #[serde(default)]
    pub autostart_initialized: bool,
    /// How long recent successful check runs took, in seconds, by repo,
    /// oldest first.
    #[serde(default)]
    pub check_durations: HashMap<String, Vec<u64>>,
    /// Slack channel links pasted into the popover, by lowercase
    /// `org/team-slug`.
    #[serde(default)]
    pub team_channels: HashMap<String, String>,
    /// Which token to use, once the user has picked.
    #[serde(default)]
    pub auth_source: Option<TokenSource>,
    /// Notification cards are muted.
    #[serde(default)]
    pub notifications_muted: bool,
    /// Light or dark appearance, or follow the system. Per device, so never
    /// synced.
    #[serde(default)]
    pub theme: Theme,
    /// Whether and how snoozes and channels are shared with other devices.
    #[serde(default)]
    pub sync: SyncMemory,
    /// Which events play a sound.
    #[serde(default)]
    pub sound: SoundMemory,
    /// Order and visibility of "My PRs" sections. `None` is today's default
    /// order with everything but Merged shown; read through
    /// [`Memory::my_prs_sections`], never directly.
    #[serde(default)]
    pub my_prs_sections: Option<Vec<SectionPref>>,
    /// Custom "My PRs" sections backed by your own GitHub search queries.
    #[serde(default)]
    pub views: Vec<View>,
}

/// How the UI looks: a fixed light or dark appearance, or the system's.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

impl Theme {
    pub fn as_str(self) -> &'static str {
        match self {
            Theme::System => "system",
            Theme::Light => "light",
            Theme::Dark => "dark",
        }
    }

    /// Anything unknown means the system's.
    pub fn parse(text: &str) -> Self {
        match text {
            "light" => Theme::Light,
            "dark" => Theme::Dark,
            _ => Theme::System,
        }
    }
}

/// Which events play a sound. Opt-in, off by default.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SoundMemory {
    /// One of your own PRs was merged.
    pub pr_merged: bool,
}

/// How many durations are kept per repo.
const MAX_DURATIONS: usize = 10;

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
    /// The checks of the head commit being timed.
    #[serde(default)]
    pub checks_run: Option<ChecksRun>,
    /// One of your own PRs, rather than one you were asked to review. Set by
    /// `notify::diff`; tells `notify::vanished_own_prs` which disappearances
    /// are worth checking for a merge.
    #[serde(default)]
    pub is_own: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecksRun {
    /// The head commit the checks run on.
    pub oid: String,
    pub started_at: DateTime<Utc>,
    /// Done, so a still-pending status afterwards is a re-run.
    #[serde(default)]
    pub finished: bool,
}

impl PrMemory {
    pub fn new(seen_until: DateTime<Utc>) -> Self {
        Self {
            seen_until,
            nudged_for: None,
            snoozed_until: None,
            requested_seen_until: None,
            checks_run: None,
            is_own: false,
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

    pub fn record_check_duration(&mut self, repo: &str, secs: u64) {
        let durations = self.check_durations.entry(repo.to_string()).or_default();
        durations.push(secs);
        if durations.len() > MAX_DURATIONS {
            durations.remove(0);
        }
    }

    pub fn set_snooze(&mut self, id: &str, until: Option<DateTime<Utc>>, now: DateTime<Utc>) {
        self.pull_requests
            .entry(id.to_string())
            .or_insert_with(|| PrMemory::new(now))
            .snoozed_until = until;
        self.sync.snoozes.insert(id.to_string(), now);
    }

    /// Saves a team's Slack channel link, or forgets it with `None`.
    pub fn set_team_channel(&mut self, team: &str, link: Option<String>, now: DateTime<Utc>) {
        let team = team.to_lowercase();
        match link {
            Some(link) => self.team_channels.insert(team.clone(), link),
            None => self.team_channels.remove(&team),
        };
        self.sync.team_channels.insert(team, now);
    }

    /// The order and visibility of "My PRs" sections: what was saved,
    /// completed with any section it's missing.
    pub fn my_prs_sections(&self) -> Vec<SectionPref> {
        sections::normalize(self.my_prs_sections.as_deref(), &self.views)
    }

    pub fn set_my_prs_sections(&mut self, sections: Vec<SectionPref>, now: DateTime<Utc>) {
        self.my_prs_sections = Some(sections::normalize(Some(&sections), &self.views));
        self.sync.sections_changed_at = Some(now);
    }

    /// Adds a custom view and returns it, so the caller can show it right away.
    pub fn add_view(&mut self, name: String, query: String, now: DateTime<Utc>) -> &View {
        let id = format!("v{}", now.timestamp_nanos_opt().unwrap_or_default());
        self.views.push(View {
            id: id.clone(),
            name,
            query,
        });
        self.sync.views.insert(id, now);
        self.views.last().expect("just pushed")
    }

    pub fn update_view(&mut self, id: &str, name: String, query: String, now: DateTime<Utc>) {
        if let Some(view) = self.views.iter_mut().find(|v| v.id == id) {
            view.name = name;
            view.query = query;
        }
        self.sync.views.insert(id.to_string(), now);
    }

    /// Removes a view, and its entry in the section order, if any.
    pub fn remove_view(&mut self, id: &str, now: DateTime<Utc>) {
        self.views.retain(|v| v.id != id);
        if let Some(sections) = &mut self.my_prs_sections {
            sections.retain(|pref| {
                !matches!(&pref.kind, crate::sections::SectionKind::View { id: vid } if vid == id)
            });
        }
        self.sync.views.insert(id.to_string(), now);
    }
}
