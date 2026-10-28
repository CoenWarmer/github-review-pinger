//! Background polling. The poller owns the latest snapshot, pushes it to the
//! popover as a `snapshot` event, keeps the tray count in sync, and sends
//! notifications for what changed between polls.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Local, NaiveDate, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use crate::auth::{self, AuthError, TokenSource};
use crate::card;
use crate::directory::Directory;
use crate::engine::{self, Fetched};
use crate::gist;
use crate::github::{self, FetchError};
use crate::memory::{Memory, Theme};
use crate::merged::{self, MergedPrView};
use crate::notify;
use crate::prs::{self, PrView};
use crate::reviews::ReviewView;
use crate::sections::{self, SectionPref};
use crate::settings::{self, Settings, SlackOpensIn};
use crate::slack::{self, Channel};
use crate::sound;
use crate::sync;
use crate::views::View;

const POLL_INTERVAL: Duration = Duration::from_secs(120);
const MAX_BACKOFF: Duration = Duration::from_secs(600);
/// Fetched automatically with every poll, while the Merged section is on.
const MERGED_PAGE_SIZE: u32 = 30;
/// Fetched per "Load more" click.
const MERGED_LOAD_MORE: u32 = 5;
pub const TRAY_ID: &str = "tray";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub status: Status,
    pub refreshing: bool,
    pub viewer: Option<String>,
    pub token_source: Option<TokenSource>,
    /// The source the user picked; `None` until they do.
    pub auth_choice: Option<TokenSource>,
    /// Whether a token is saved in the keychain, used or not.
    pub has_saved_token: bool,
    /// Notification cards are muted.
    pub notifications_muted: bool,
    pub theme: Theme,
    /// The team lookup was refused for lack of the `read:org` scope.
    pub team_lookup_denied: bool,
    /// The first load is under way and only My PRs has arrived, so the lists
    /// that are empty aren't known to be.
    pub partial: bool,
    /// Wall-clock time, so staleness survives the machine sleeping.
    pub fetched_at: Option<DateTime<Utc>>,
    pub sso_partial: bool,
    pub pull_requests: Vec<PrView>,
    pub review_requests: Vec<ReviewView>,
    /// Slack channel links by lowercase `org/team-slug`, from settings and
    /// those saved in the popover.
    pub team_channels: HashMap<String, Channel>,
    pub slack_opens_in: SlackOpensIn,
    pub sync: SyncStatus,
    /// Plays a sound when one of your own PRs is merged.
    pub sound_on_merge: bool,
    /// Order and visibility of "My PRs" sections.
    pub my_prs_sections: Vec<SectionPref>,
    /// Merged in the last couple of days, or further back via "Load more".
    pub merged_pull_requests: Vec<MergedPrView>,
    /// Whether "Load more" would find anything.
    pub merged_can_load_more: bool,
    /// Your custom views: a name and a GitHub search query.
    pub views: Vec<View>,
    /// Each view's matching PRs, by view id.
    pub view_pull_requests: HashMap<String, Vec<PrView>>,
}

/// The automatic page and "Load more" extension of the Merged section, kept
/// apart from `Poller::latest` since they paginate on their own. Not
/// persisted: a restart starts over from the top.
#[derive(Default)]
struct MergedState {
    page: Vec<github::types::MergedPullRequest>,
    loaded_more: Vec<github::types::MergedPullRequest>,
    /// Where the next "Load more" continues from.
    cursor: Option<String>,
    has_more: bool,
}

/// Sharing snoozes and Slack channels with other devices.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub enabled: bool,
    /// Whether the token can use gists; `None` until checked.
    pub available: Option<bool>,
    pub last_synced_at: Option<DateTime<Utc>>,
    /// Where the gist is on GitHub, once there is one.
    pub gist_url: Option<String>,
    /// What went wrong the last time, to show.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Status {
    Loading,
    Ok,
    Error { problem: Problem },
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Problem {
    GhNotInstalled,
    GhNotLoggedIn,
    NoSavedToken,
    TokenRejected { source: TokenSource },
    RateLimited { reset_at: Option<DateTime<Utc>> },
    Network { message: String },
    Api { message: String },
}

pub struct Poller {
    snapshot: Mutex<Snapshot>,
    /// The last successful fetch, kept so snoozes and settings can be
    /// re-applied without another round trip.
    latest: Mutex<Option<Fetched>>,
    memory: Mutex<Memory>,
    memory_path: Option<PathBuf>,
    /// Team members and users' teams, for the reviewer hover cards. Kept
    /// between launches, since memberships rarely change.
    directory: Mutex<Directory>,
    directory_path: Option<PathBuf>,
    /// Pull requests the user opened on GitHub since the popover last
    /// showed; refreshed first when it next opens. Not persisted.
    visited: Mutex<HashSet<String>>,
    first_poll: AtomicBool,
    wake: Notify,
    /// Asks the sync task to run, soon.
    sync_wake: Notify,
    /// Keeps a poll and a change from syncing at the same time.
    sync_lock: tokio::sync::Mutex<()>,
    /// The Merged section's automatic page and "Load more" extension.
    merged: Mutex<MergedState>,
    http: reqwest::Client,
}

impl Poller {
    pub fn snapshot(&self) -> Snapshot {
        self.snapshot.lock().unwrap().clone()
    }

    pub fn refresh(&self) {
        self.wake.notify_one();
    }

    /// Refreshes when the popover opens, unless a refresh is already running.
    pub fn refresh_on_open(&self) {
        if !self.snapshot.lock().unwrap().refreshing {
            self.wake.notify_one();
        }
    }

    pub fn set_snooze(&self, app: &AppHandle, id: &str, until: Option<DateTime<Utc>>) {
        {
            let mut memory = self.memory.lock().unwrap();
            memory.set_snooze(id, until, Utc::now());
            self.save(&memory);
        }
        self.rederive(app);
        self.sync_wake.notify_one();
    }

    /// Saves the Slack channel for a team. Fails when the link isn't a
    /// Slack link.
    pub fn set_team_channel(&self, app: &AppHandle, team: &str, link: &str) -> Result<(), String> {
        if !slack::is_valid_link(link) {
            return Err("That doesn't look like a Slack channel link.".to_string());
        }
        let channels = {
            let mut memory = self.memory.lock().unwrap();
            memory.set_team_channel(team, Some(link.to_string()), Utc::now());
            self.save(&memory);
            self.channels(&settings::load(app), &memory)
        };
        self.update(app, |s| s.team_channels = channels);
        self.sync_wake.notify_one();
        Ok(())
    }

    /// Forgets a team's saved channel, so its chip asks again.
    pub fn remove_team_channel(&self, app: &AppHandle, team: &str) {
        let channels = {
            let mut memory = self.memory.lock().unwrap();
            memory.set_team_channel(team, None, Utc::now());
            self.save(&memory);
            self.channels(&settings::load(app), &memory)
        };
        self.update(app, |s| s.team_channels = channels);
        self.sync_wake.notify_one();
    }

    fn channels(&self, settings: &Settings, memory: &Memory) -> HashMap<String, Channel> {
        slack::merged_channels(&memory.team_channels, &settings.team_channels)
    }

    /// Picks which token to use, and refreshes with it.
    pub fn set_auth_source(&self, app: &AppHandle, source: TokenSource) {
        {
            let mut memory = self.memory.lock().unwrap();
            memory.auth_source = Some(source);
            self.save(&memory);
        }
        // Another token may have other scopes.
        self.update(app, |s| {
            s.auth_choice = Some(source);
            s.sync.available = None;
        });
        self.refresh();
    }

    /// Turns syncing on or off. Turning it on syncs right away.
    pub fn set_sync_enabled(&self, app: &AppHandle, enabled: bool) {
        {
            let mut memory = self.memory.lock().unwrap();
            memory.sync.enabled = enabled;
            self.save(&memory);
        }
        self.update(app, |s| {
            s.sync.enabled = enabled;
            s.sync.error = None;
        });
        if enabled {
            self.sync_wake.notify_one();
        }
    }

    /// Searches GitHub for PRs matching `text`, for the search box. Rejects
    /// with a message to show.
    pub async fn search_pull_requests(
        &self,
        text: &str,
    ) -> Result<Vec<review_pinger_core::github::types::FoundPullRequest>, String> {
        let chosen = self.auth_source();
        let token = tauri::async_runtime::spawn_blocking(move || auth::resolve_token(chosen))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|_| "Could not get a GitHub token to search with.".to_string())?;
        github::search_pull_requests(&self.http, &token.value, text)
            .await
            .map_err(|e| match e {
                github::FetchError::RateLimited { .. } => "GitHub's rate limit was reached.".into(),
                github::FetchError::Unauthorized => "GitHub rejected the token.".into(),
                github::FetchError::Network(m) | github::FetchError::Api(m) => m,
            })
    }

    /// Whether a token pasted but not yet saved can use gists.
    pub async fn token_can_sync(&self, token: &str) -> bool {
        match gist::can_sync(&self.http, token).await {
            Ok(can) => can,
            Err(e) => {
                log::warn!("Could not check the token's scopes: {e}");
                false
            }
        }
    }

    /// Merges snoozes and channels with the sync gist, if syncing is on and
    /// the token can use gists, and shows the result. Never fails: problems
    /// are shown in the settings and the next sync tries again.
    async fn sync(&self, app: &AppHandle, token: &str) {
        let _one_at_a_time = self.sync_lock.lock().await;
        let mut available = self.snapshot.lock().unwrap().sync.available;
        if available.is_none() {
            available = gist::can_sync(&self.http, token).await.ok();
            self.update(app, |s| s.sync.available = available);
        }
        if available != Some(true) || !self.memory.lock().unwrap().sync.enabled {
            return;
        }
        let result = self.sync_gist(token).await;
        let changed = *result.as_ref().unwrap_or(&false);
        let gist_url = self
            .memory
            .lock()
            .unwrap()
            .sync
            .gist_id
            .as_deref()
            .map(sync::gist_url);
        self.update(app, |s| {
            s.sync.gist_url = gist_url;
            match &result {
                Ok(_) => {
                    s.sync.last_synced_at = Some(Utc::now());
                    s.sync.error = None;
                }
                Err(e) => s.sync.error = Some(e.clone()),
            }
        });
        if changed {
            self.rederive(app);
        }
    }

    /// Returns whether snoozes or channels here changed.
    async fn sync_gist(&self, token: &str) -> Result<bool, String> {
        let mut id = self.memory.lock().unwrap().sync.gist_id.clone();
        if id.is_none() {
            id = gist::find(&self.http, token).await?;
        }
        let mut remote = None;
        if let Some(found) = &id {
            remote = gist::read(&self.http, token, found).await?;
            if remote.is_none() {
                // Deleted, so a new one is made from what's here.
                id = None;
            }
        }

        let result = {
            let mut memory = self.memory.lock().unwrap();
            let doc = remote.as_deref().and_then(sync::read_gist);
            let result = sync::reconcile(&mut memory, doc, Utc::now());
            memory.sync.gist_id = id.clone();
            self.save(&memory);
            result
        };
        if let Some(doc) = result.upload {
            match id {
                Some(id) => gist::update(&self.http, token, &id, sync::update_body(&doc)).await?,
                None => {
                    let created = gist::create(&self.http, token, sync::create_body(&doc)).await?;
                    let mut memory = self.memory.lock().unwrap();
                    memory.sync.gist_id = Some(created);
                    self.save(&memory);
                }
            }
        }
        Ok(result.changed)
    }

    /// Mutes or unmutes the notification cards. Muting drops those showing
    /// and queued.
    pub fn set_notifications_muted(&self, app: &AppHandle, muted: bool) {
        {
            let mut memory = self.memory.lock().unwrap();
            memory.notifications_muted = muted;
            self.save(&memory);
        }
        if muted {
            card::clear(app);
        }
        self.update(app, |s| s.notifications_muted = muted);
    }

    /// Switches between the light, dark and system appearance.
    pub fn set_theme(&self, app: &AppHandle, theme: Theme) {
        {
            let mut memory = self.memory.lock().unwrap();
            memory.theme = theme;
            self.save(&memory);
        }
        self.update(app, |s| s.theme = theme);
    }

    /// Turns the "PR merged" sound on or off.
    pub fn set_sound_on_merge(&self, app: &AppHandle, enabled: bool) {
        {
            let mut memory = self.memory.lock().unwrap();
            memory.sound.pr_merged = enabled;
            self.save(&memory);
        }
        self.update(app, |s| s.sound_on_merge = enabled);
    }

    fn auth_source(&self) -> Option<TokenSource> {
        self.memory.lock().unwrap().auth_source
    }

    /// Remembers that the user opened this PR on GitHub, so it's refreshed
    /// first the next time the popover shows.
    pub fn visit(&self, id: &str) {
        self.visited.lock().unwrap().insert(id.to_string());
    }

    /// Updates the snapshot from the last fetch, after snoozes or a single
    /// PR changed.
    fn rederive(&self, app: &AppHandle) {
        let (sections, views) = {
            let memory = self.memory.lock().unwrap();
            (memory.my_prs_sections(), memory.views.clone())
        };
        self.update(app, |s| {
            s.my_prs_sections = sections;
            s.views = views;
        });
        let latest = self.latest.lock().unwrap();
        if let Some(fetched) = latest.as_ref() {
            let now = Utc::now();
            let (views, review_views) = self.derive(app, fetched, now);
            let view_pull_requests = self.derive_views(app, fetched, now);
            let denied = self.directory.lock().unwrap().is_denied();
            self.update(app, |s| {
                s.pull_requests = views;
                s.review_requests = review_views;
                s.view_pull_requests = view_pull_requests;
                s.team_lookup_denied = denied;
            });
        }
    }

    /// Saves the order and visibility of "My PRs" sections, and refreshes
    /// right away in case a section just turned on needs fetching.
    pub fn set_my_prs_sections(&self, app: &AppHandle, prefs: Vec<SectionPref>) {
        let effective = {
            let mut memory = self.memory.lock().unwrap();
            memory.set_my_prs_sections(prefs, Utc::now());
            self.save(&memory);
            memory.my_prs_sections()
        };
        self.update(app, |s| s.my_prs_sections = effective);
        self.sync_wake.notify_one();
        self.refresh();
    }

    /// Adds a view and refreshes right away, so it shows without waiting for
    /// the next poll.
    pub fn add_view(&self, app: &AppHandle, name: String, query: String) {
        let (views, sections) = {
            let mut memory = self.memory.lock().unwrap();
            memory.add_view(name, query, Utc::now());
            self.save(&memory);
            (memory.views.clone(), memory.my_prs_sections())
        };
        self.update(app, |s| {
            s.views = views;
            s.my_prs_sections = sections;
        });
        self.sync_wake.notify_one();
        self.refresh();
    }

    pub fn update_view(&self, app: &AppHandle, id: &str, name: String, query: String) {
        let views = {
            let mut memory = self.memory.lock().unwrap();
            memory.update_view(id, name, query, Utc::now());
            self.save(&memory);
            memory.views.clone()
        };
        self.update(app, |s| s.views = views);
        self.sync_wake.notify_one();
        self.refresh();
    }

    pub fn remove_view(&self, app: &AppHandle, id: &str) {
        let (views, sections) = {
            let mut memory = self.memory.lock().unwrap();
            memory.remove_view(id, Utc::now());
            self.save(&memory);
            (memory.views.clone(), memory.my_prs_sections())
        };
        self.update(app, |s| {
            s.views = views;
            s.my_prs_sections = sections;
            s.view_pull_requests.remove(id);
        });
        self.sync_wake.notify_one();
    }

    /// Each custom view's PRs, derived the same way as your own.
    fn derive_views(
        &self,
        app: &AppHandle,
        fetched: &Fetched,
        now: DateTime<Utc>,
    ) -> HashMap<String, Vec<PrView>> {
        let settings = settings::load(app);
        let memory = self.memory.lock().unwrap();
        let directory = self.directory.lock().unwrap();
        engine::derive_views(fetched, &settings, &memory, &directory, now)
    }

    /// Fetches further merged PRs, older than what's already shown. Errors
    /// are only logged: the button stays put, so trying again costs a click.
    pub async fn load_more_merged(&self, app: &AppHandle) {
        let cursor = {
            let state = self.merged.lock().unwrap();
            if !state.has_more {
                return;
            }
            state.cursor.clone()
        };
        let chosen = self.auth_source();
        let Ok(Ok(token)) =
            tauri::async_runtime::spawn_blocking(move || auth::resolve_token(chosen)).await
        else {
            return;
        };
        match github::fetch_merged_page(&self.http, &token.value, cursor, MERGED_LOAD_MORE).await {
            Ok(page) => {
                let (views, can_load_more) = {
                    let mut state = self.merged.lock().unwrap();
                    state.loaded_more.extend(page.items);
                    state.cursor = page.end_cursor;
                    state.has_more = page.has_next_page;
                    (
                        merged::derive(&state.page, &state.loaded_more, Utc::now()),
                        state.has_more,
                    )
                };
                self.update(app, |s| {
                    s.merged_pull_requests = views;
                    s.merged_can_load_more = can_load_more;
                });
            }
            Err(e) => log::warn!("Could not load more merged PRs: {e:?}"),
        }
    }

    /// Returns true exactly once per install, so autostart can default to on
    /// without overriding a later opt-out.
    pub fn claim_first_launch(&self) -> bool {
        let mut memory = self.memory.lock().unwrap();
        if memory.autostart_initialized {
            return false;
        }
        memory.autostart_initialized = true;
        self.save(&memory);
        true
    }

    fn derive(
        &self,
        app: &AppHandle,
        fetched: &Fetched,
        now: DateTime<Utc>,
    ) -> (Vec<PrView>, Vec<ReviewView>) {
        let settings = settings::load(app);
        let memory = self.memory.lock().unwrap();
        let directory = self.directory.lock().unwrap();
        engine::derive(fetched, &settings, &memory, &directory, now)
    }

    fn save(&self, memory: &Memory) {
        let Some(path) = &self.memory_path else {
            return;
        };
        if let Err(e) = memory.save(path) {
            log::warn!("Could not save {}: {e}", path.display());
        }
    }

    fn update(&self, app: &AppHandle, change: impl FnOnce(&mut Snapshot)) {
        let snapshot = {
            let mut snapshot = self.snapshot.lock().unwrap();
            change(&mut snapshot);
            snapshot.clone()
        };
        update_tray(app, &snapshot);
        if let Err(e) = app.emit("snapshot", &snapshot) {
            log::warn!("Could not emit snapshot: {e}");
        }
    }
}

pub fn start(app: &AppHandle) -> Arc<Poller> {
    let memory_path = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("state.json"));
    let memory = memory_path.as_deref().map(Memory::load).unwrap_or_default();
    let directory_path = memory_path
        .as_deref()
        .map(|path| path.with_file_name("directory.json"));
    let directory = directory_path
        .as_deref()
        .map(Directory::load)
        .unwrap_or_default();

    let poller = Arc::new(Poller {
        snapshot: Mutex::new(Snapshot {
            status: Status::Loading,
            refreshing: false,
            viewer: None,
            token_source: None,
            auth_choice: None,
            has_saved_token: false,
            notifications_muted: memory.notifications_muted,
            theme: memory.theme,
            team_lookup_denied: directory.is_denied(),
            partial: false,
            fetched_at: None,
            sso_partial: false,
            pull_requests: Vec::new(),
            review_requests: Vec::new(),
            team_channels: HashMap::new(),
            slack_opens_in: SlackOpensIn::default(),
            sync: SyncStatus {
                enabled: memory.sync.enabled,
                available: None,
                last_synced_at: None,
                gist_url: memory.sync.gist_id.as_deref().map(sync::gist_url),
                error: None,
            },
            sound_on_merge: memory.sound.pr_merged,
            my_prs_sections: memory.my_prs_sections(),
            merged_pull_requests: Vec::new(),
            merged_can_load_more: false,
            views: memory.views.clone(),
            view_pull_requests: HashMap::new(),
        }),
        latest: Mutex::new(None),
        memory: Mutex::new(memory),
        memory_path,
        directory: Mutex::new(directory),
        directory_path,
        visited: Mutex::new(HashSet::new()),
        first_poll: AtomicBool::new(true),
        wake: Notify::new(),
        sync_wake: Notify::new(),
        sync_lock: tokio::sync::Mutex::new(()),
        merged: Mutex::new(MergedState::default()),
        http: github::http_client(),
    });
    tauri::async_runtime::spawn(run(app.clone(), poller.clone()));
    tauri::async_runtime::spawn(sync_on_change(app.clone(), poller.clone()));
    poller
}

/// Called when the popover opens. PRs the user visited on GitHub since last
/// time are refreshed alone first, so what they changed shows up quickly,
/// and then the whole list is refreshed.
pub fn on_popover_open(app: &AppHandle, poller: Arc<Poller>) {
    let visited: Vec<String> = poller.visited.lock().unwrap().drain().collect();
    if visited.is_empty() {
        poller.refresh_on_open();
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        refresh_visited(&app, &poller, visited).await;
        poller.refresh_on_open();
    });
}

/// Refetches just `ids` and patches them into the last fetch. Notifications
/// are left to the full poll that follows, which compares against memory this
/// leaves untouched. Failures are only logged, since the full refresh reports
/// problems.
async fn refresh_visited(app: &AppHandle, poller: &Poller, ids: Vec<String>) {
    let chosen = poller.auth_source();
    let Ok(Ok(token)) =
        tauri::async_runtime::spawn_blocking(move || auth::resolve_token(chosen)).await
    else {
        return;
    };
    let result = async {
        let mut fresh = github::fetch_details(&poller.http, &token.value, &ids).await?;
        // Only the viewer's own PRs need the expensive merge state.
        let authored: HashSet<String> = match poller.latest.lock().unwrap().as_ref() {
            Some(fetched) => fetched
                .pull_requests
                .iter()
                .map(|pr| pr.id.clone())
                .collect(),
            None => return Ok(()),
        };
        let (mut own, others): (Vec<_>, Vec<_>) =
            fresh.drain(..).partition(|pr| authored.contains(&pr.id));
        github::add_merge_states(&poller.http, &token.value, &mut own).await?;
        own.extend(others);

        if let Some(fetched) = poller.latest.lock().unwrap().as_mut() {
            engine::apply_refresh(fetched, own);
        }
        Ok::<(), FetchError>(())
    }
    .await;

    match result {
        Ok(()) => poller.rederive(app),
        Err(e) => log::warn!("Could not refresh visited pull requests: {e:?}"),
    }
}

async fn run(app: AppHandle, poller: Arc<Poller>) {
    let mut consecutive_failures = 0;
    loop {
        let delay = match poll_once(&app, &poller).await {
            Ok(()) => {
                consecutive_failures = 0;
                POLL_INTERVAL
            }
            Err(Problem::RateLimited { reset_at }) => reset_at
                .and_then(|at| (at - Utc::now()).to_std().ok())
                .unwrap_or(POLL_INTERVAL)
                .max(Duration::from_secs(60)),
            Err(Problem::Network { .. } | Problem::Api { .. }) => {
                consecutive_failures += 1;
                backoff(consecutive_failures)
            }
            // The user has to act (log in, paste a token); keep checking at the normal pace.
            Err(_) => POLL_INTERVAL,
        };

        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = poller.wake.notified() => {}
        }
    }
}

fn backoff(failures: u32) -> Duration {
    let seconds = 30u64.saturating_mul(1 << failures.min(5));
    Duration::from_secs(seconds).min(MAX_BACKOFF)
}

async fn poll_once(app: &AppHandle, poller: &Poller) -> Result<(), Problem> {
    let has_saved_token = tauri::async_runtime::spawn_blocking(auth::has_saved_pat)
        .await
        .unwrap_or(false);
    let auth_choice = poller.auth_source();
    poller.update(app, |s| {
        s.refreshing = true;
        s.has_saved_token = has_saved_token;
        s.auth_choice = auth_choice;
    });

    let settings = settings::load(app);
    let reviewed_since = (Utc::now() - engine::dormant_after(&settings)).date_naive();
    // With nothing to show yet, My PRs is fetched and shown first.
    let first_load = poller.snapshot.lock().unwrap().fetched_at.is_none();
    let fetched = match fetch_and_sync(app, poller, reviewed_since, first_load).await {
        Ok(fetched) => fetched,
        Err(problem) => {
            // Keep showing the last good data alongside the problem.
            log::warn!("Refresh failed: {problem:?}");
            poller.update(app, |s| {
                s.refreshing = false;
                s.status = Status::Error {
                    problem: problem.clone(),
                };
            });
            return Err(problem);
        }
    };

    let now = Utc::now();
    let (views, review_views) = poller.derive(app, &fetched, now);
    let view_pull_requests = poller.derive_views(app, &fetched, now);
    let channels = poller.channels(&settings, &poller.memory.lock().unwrap());
    // Computed before `record_poll` prunes PRs no longer open.
    let vanished_own = notify::vanished_own_prs(&views, &poller.memory.lock().unwrap());
    // Views are informational: they don't notify or count toward the tray,
    // but a snoozed view-only PR still needs pruning once it stops matching.
    let other_ids: Vec<String> = fetched
        .view_pull_requests
        .values()
        .flatten()
        .map(|pr| pr.id.clone())
        .collect();
    let notifications = {
        let mut memory = poller.memory.lock().unwrap();
        let first_poll = poller.first_poll.swap(false, Ordering::Relaxed);
        let notifications = engine::record_poll(
            &views,
            &review_views,
            &other_ids,
            &fetched.pull_requests,
            &settings,
            &mut memory,
            now,
            first_poll,
            &Local,
        );
        poller.save(&memory);
        notifications
    };
    // The list already shows what changed while it's open, and muting drops
    // the cards, but both still count the events as seen.
    let popover_open = app
        .get_webview_window("main")
        .is_some_and(|window| window.is_visible().unwrap_or(false));
    if !popover_open && !poller.memory.lock().unwrap().notifications_muted {
        card::enqueue(app, notifications);
    }

    poller.update(app, |s| {
        s.refreshing = false;
        s.partial = false;
        s.status = Status::Ok;
        s.viewer = Some(fetched.viewer.clone());
        s.token_source = Some(fetched.token_source);
        s.fetched_at = Some(now);
        s.sso_partial = fetched.sso_partial;
        s.pull_requests = views;
        s.review_requests = review_views;
        s.view_pull_requests = view_pull_requests;
        s.team_channels = channels;
        s.slack_opens_in = settings.slack_opens_in;
    });
    *poller.latest.lock().unwrap() = Some(fetched);
    refresh_directory(app, poller).await;
    check_merged(poller, vanished_own).await;
    refresh_merged_section(app, poller, now).await;
    Ok(())
}

/// Refreshes the Merged section's automatic page, if it's on. Skipped, with
/// no request at all, while it's off. Errors are only logged: the last good
/// page (if any) stays shown.
async fn refresh_merged_section(app: &AppHandle, poller: &Poller, now: DateTime<Utc>) {
    let sections = poller.memory.lock().unwrap().my_prs_sections();
    if !sections::needs(&sections).merged {
        return;
    }
    let chosen = poller.auth_source();
    let Ok(Ok(token)) =
        tauri::async_runtime::spawn_blocking(move || auth::resolve_token(chosen)).await
    else {
        return;
    };
    match github::fetch_merged_page(&poller.http, &token.value, None, MERGED_PAGE_SIZE).await {
        Ok(page) => {
            let (views, can_load_more) = {
                let mut state = poller.merged.lock().unwrap();
                state.page = page.items;
                state.cursor = page.end_cursor;
                state.has_more = page.has_next_page;
                (
                    merged::derive(&state.page, &state.loaded_more, now),
                    state.has_more,
                )
            };
            poller.update(app, |s| {
                s.merged_pull_requests = views;
                s.merged_can_load_more = can_load_more;
            });
        }
        Err(e) => log::warn!("Could not fetch merged PRs: {e:?}"),
    }
}

/// Looks up whatever the hover cards still need to know about teams and
/// users, and redraws the lists when something arrived. Failures are only
/// logged: the cards then show what they can, and the next poll tries again.
/// Checks `ids` (your own PRs that just dropped out of the open search) for
/// a merge, and plays the sound if one did. Skipped, with no request at all,
/// while the sound is off. Failures are only logged.
async fn check_merged(poller: &Poller, ids: Vec<String>) {
    if ids.is_empty() || !poller.memory.lock().unwrap().sound.pr_merged {
        return;
    }
    let chosen = poller.auth_source();
    let Ok(Ok(token)) =
        tauri::async_runtime::spawn_blocking(move || auth::resolve_token(chosen)).await
    else {
        return;
    };
    match github::fetch_merged(&poller.http, &token.value, &ids).await {
        Ok(merged) if !merged.is_empty() => sound::play_pr_merged(),
        Ok(_) => {}
        Err(e) => log::warn!("Could not check merged status: {e:?}"),
    }
}

async fn refresh_directory(app: &AppHandle, poller: &Poller) {
    let needs = match poller.latest.lock().unwrap().as_ref() {
        Some(fetched) => prs::directory_needs(
            fetched
                .pull_requests
                .iter()
                .chain(&fetched.review_pull_requests),
        ),
        None => return,
    };
    let missing = poller.directory.lock().unwrap().missing(&needs, Utc::now());
    if missing.is_empty() {
        return;
    }

    let chosen = poller.auth_source();
    let Ok(Ok(token)) =
        tauri::async_runtime::spawn_blocking(move || auth::resolve_token(chosen)).await
    else {
        return;
    };
    match github::fetch_directory(&poller.http, &token.value, &missing).await {
        Ok(found) => {
            let changed = {
                let mut directory = poller.directory.lock().unwrap();
                let changed = directory.merge(&missing, found, Utc::now());
                if let Some(path) = &poller.directory_path
                    && let Err(e) = directory.save(path)
                {
                    log::warn!("Could not save {}: {e}", path.display());
                }
                changed
            };
            if changed {
                poller.rederive(app);
            }
        }
        Err(e) => log::warn!("Could not look up teams: {e:?}"),
    }
}

/// Fetches the PRs while the snoozes and channels sync, so the lists are
/// derived with both. On the first load, My PRs is shown as soon as it's in,
/// ahead of the rest. That's display only: notifications and what's
/// remembered wait for the complete fetch.
async fn fetch_and_sync(
    app: &AppHandle,
    poller: &Poller,
    reviewed_since: NaiveDate,
    first_load: bool,
) -> Result<Fetched, Problem> {
    let token = resolve_token(poller).await?;
    let show_partial = |partial: Fetched| {
        let now = Utc::now();
        let (views, _) = poller.derive(app, &partial, now);
        poller.update(app, |s| {
            s.partial = true;
            s.status = Status::Ok;
            s.viewer = Some(partial.viewer);
            s.token_source = Some(partial.token_source);
            s.fetched_at = Some(now);
            s.sso_partial = partial.sso_partial;
            s.pull_requests = views;
        });
    };
    let (fetched, ()) = tokio::join!(
        fetch(
            poller,
            &token,
            reviewed_since,
            first_load.then_some(&show_partial as &(dyn Fn(Fetched) + Send + Sync)),
        ),
        poller.sync(app, &token.value)
    );
    fetched
}

/// Waits for a snooze or channel to change, then shares it.
async fn sync_on_change(app: AppHandle, poller: Arc<Poller>) {
    loop {
        poller.sync_wake.notified().await;
        // Several changes in a row go out together.
        tokio::time::sleep(Duration::from_secs(1)).await;
        let chosen = poller.auth_source();
        if let Ok(Ok(token)) =
            tauri::async_runtime::spawn_blocking(move || auth::resolve_token(chosen)).await
        {
            poller.sync(&app, &token.value).await;
        }
    }
}

async fn resolve_token(poller: &Poller) -> Result<auth::Token, Problem> {
    let chosen = poller.auth_source();
    tauri::async_runtime::spawn_blocking(move || auth::resolve_token(chosen))
        .await
        .map_err(|e| Problem::Api {
            message: e.to_string(),
        })?
        .map_err(|e| match e {
            AuthError::GhNotInstalled => Problem::GhNotInstalled,
            AuthError::GhNotLoggedIn => Problem::GhNotLoggedIn,
            AuthError::NoSavedToken => Problem::NoSavedToken,
        })
}

async fn fetch(
    poller: &Poller,
    token: &auth::Token,
    reviewed_since: NaiveDate,
    on_partial: Option<&(dyn Fn(Fetched) + Send + Sync)>,
) -> Result<Fetched, Problem> {
    let (include_authored, view_queries) = {
        let memory = poller.memory.lock().unwrap();
        let needs = sections::needs(&memory.my_prs_sections());
        let queries: Vec<(String, String)> = needs
            .view_ids
            .iter()
            .filter_map(|id| memory.views.iter().find(|v| &v.id == id))
            .map(|view| (view.id.clone(), view.search()))
            .collect();
        (needs.open, queries)
    };
    let adapter = on_partial.map(|show| {
        move |partial: &github::Fetched| {
            show(Fetched {
                viewer: partial.viewer.clone(),
                token_source: token.source,
                sso_partial: partial.sso_partial,
                pull_requests: partial.pull_requests.clone(),
                review_pull_requests: Vec::new(),
                view_pull_requests: HashMap::new(),
            })
        }
    });
    let fetched = github::fetch_open_pull_requests(
        &poller.http,
        &token.value,
        reviewed_since,
        include_authored,
        &view_queries,
        adapter
            .as_ref()
            .map(|adapter| adapter as &(dyn Fn(&github::Fetched) + Send + Sync)),
    )
    .await
    .map_err(|e| match e {
        FetchError::Unauthorized => Problem::TokenRejected {
            source: token.source,
        },
        FetchError::RateLimited { reset_at } => Problem::RateLimited { reset_at },
        FetchError::Network(message) => Problem::Network { message },
        FetchError::Api(message) => Problem::Api { message },
    })?;

    Ok(Fetched {
        viewer: fetched.viewer,
        token_source: token.source,
        sso_partial: fetched.sso_partial,
        pull_requests: fetched.pull_requests,
        review_pull_requests: fetched.review_pull_requests,
        view_pull_requests: fetched.view_pull_requests,
    })
}

fn update_tray(app: &AppHandle, snapshot: &Snapshot) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let needs_action = snapshot
        .pull_requests
        .iter()
        .filter(|pr| pr.needs_author())
        .count();
    let needs_review = snapshot
        .review_requests
        .iter()
        .filter(|pr| pr.needs_review())
        .count();
    let failed_without_data =
        matches!(snapshot.status, Status::Error { .. }) && snapshot.fetched_at.is_none();

    let (title, tooltip) = tray_text(failed_without_data, needs_action, needs_review);
    let _ = tray.set_title(title);
    let _ = tray.set_tooltip(Some(tooltip));
}

/// The title shows next to the icon on macOS and Linux; Windows only has the
/// tooltip. Both numbers show whenever either is nonzero, so the position is
/// what tells them apart.
fn tray_text(
    failed_without_data: bool,
    needs_action: usize,
    needs_review: usize,
) -> (Option<String>, String) {
    if failed_without_data {
        return (
            Some("!".to_string()),
            "Review Pinger: needs setup".to_string(),
        );
    }
    if needs_action == 0 && needs_review == 0 {
        return (None, "Review Pinger: nothing needs your action".to_string());
    }
    let prs = if needs_action == 1 {
        "1 PR needs"
    } else {
        &format!("{needs_action} PRs need")
    };
    let reviews = if needs_review == 1 {
        "1 review is".to_string()
    } else {
        format!("{needs_review} reviews are")
    };
    (
        Some(format!("{needs_action} · {needs_review}")),
        format!("Review Pinger: {prs} your action, {reviews} waiting on you"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tray_shows_both_numbers() {
        assert_eq!(tray_text(false, 3, 0).0.as_deref(), Some("3 · 0"));
        assert_eq!(tray_text(false, 0, 2).0.as_deref(), Some("0 · 2"));
        assert_eq!(tray_text(false, 0, 0).0, None);
        assert_eq!(tray_text(true, 0, 0).0.as_deref(), Some("!"));
    }

    #[test]
    fn the_tooltip_spells_both_out() {
        assert_eq!(
            tray_text(false, 3, 1).1,
            "Review Pinger: 3 PRs need your action, 1 review is waiting on you"
        );
        assert_eq!(
            tray_text(false, 1, 2).1,
            "Review Pinger: 1 PR needs your action, 2 reviews are waiting on you"
        );
    }
}
