//! Review Pinger's pull request logic for the browser. A thin layer over
//! [`PingerState`], which does the work and is tested natively.

mod state;

use state::PingerState;
use wasm_bindgen::prelude::*;

fn js<T>(result: Result<T, String>) -> Result<T, JsError> {
    result.map_err(|message| JsError::new(&message))
}

/// The state of one open page. Every method that takes or returns data uses
/// JSON, and times are RFC 3339 strings.
#[wasm_bindgen]
pub struct Pinger(PingerState);

#[wasm_bindgen]
impl Pinger {
    /// Restores what `state` returned on an earlier visit.
    #[wasm_bindgen(constructor)]
    pub fn new(saved: Option<String>) -> Pinger {
        Pinger(PingerState::new(saved.as_deref()))
    }

    /// What to keep until the next visit.
    pub fn state(&self) -> Result<String, JsError> {
        js(self.0.state())
    }

    #[wasm_bindgen(js_name = setSettings)]
    pub fn set_settings(&mut self, settings: &str) -> Result<(), JsError> {
        js(self.0.set_settings(settings))
    }

    /// The date to bound the search for PRs you reviewed, `YYYY-MM-DD`.
    #[wasm_bindgen(js_name = reviewedSince)]
    pub fn reviewed_since(&self, now: &str) -> Result<String, JsError> {
        js(self.0.reviewed_since(now))
    }

    /// Takes a full fetch: `{ viewer, ssoPartial, pullRequests, reviewPullRequests }`
    /// with raw GraphQL nodes. Returns the lists and what to notify about.
    /// `tz_offset_minutes` is local time east of UTC.
    pub fn poll(
        &mut self,
        fetched: &str,
        now: &str,
        tz_offset_minutes: i32,
    ) -> Result<String, JsError> {
        js(self.0.poll(fetched, now, tz_offset_minutes))
    }

    /// The lists again after a change, or nothing before the first poll.
    pub fn derived(&self, now: &str) -> Result<Option<String>, JsError> {
        js(self.0.derived(now))
    }

    /// Patches refreshed PRs (an array of raw GraphQL nodes) into the last fetch.
    #[wasm_bindgen(js_name = applyRefresh)]
    pub fn apply_refresh(&mut self, fresh: &str) -> Result<(), JsError> {
        js(self.0.apply_refresh(fresh))
    }

    /// Snoozes a PR for `days`, or ends the snooze when `days` is missing.
    #[wasm_bindgen(js_name = setSnooze)]
    pub fn set_snooze(&mut self, id: &str, days: Option<u32>, now: &str) -> Result<(), JsError> {
        js(self.0.set_snooze(id, days, now))
    }

    /// The teams, `{ teams: [[org, slug], …] }`, whose members to look up.
    #[wasm_bindgen(js_name = directoryNeeds)]
    pub fn directory_needs(&self, now: &str) -> Result<String, JsError> {
        js(self.0.directory_needs(now))
    }

    /// Stores the answer to a lookup: `asked` is what `directoryNeeds` returned,
    /// `found` is `{ teams: { "org/slug": [logins] }, denied }`. Returns whether
    /// the lists should be derived again.
    #[wasm_bindgen(js_name = mergeDirectory)]
    pub fn merge_directory(
        &mut self,
        asked: &str,
        found: &str,
        now: &str,
    ) -> Result<bool, JsError> {
        js(self.0.merge_directory(asked, found, now))
    }

    #[wasm_bindgen(js_name = directoryDenied)]
    pub fn directory_denied(&self) -> bool {
        self.0.directory_denied()
    }

    #[wasm_bindgen(js_name = setTeamChannel)]
    pub fn set_team_channel(&mut self, team: &str, link: &str) -> Result<(), JsError> {
        js(self.0.set_team_channel(team, link))
    }

    #[wasm_bindgen(js_name = removeTeamChannel)]
    pub fn remove_team_channel(&mut self, team: &str) {
        self.0.remove_team_channel(team);
    }

    #[wasm_bindgen(js_name = teamChannels)]
    pub fn team_channels(&self) -> Result<String, JsError> {
        js(self.0.team_channels())
    }

    #[wasm_bindgen(js_name = setNotificationsMuted)]
    pub fn set_notifications_muted(&mut self, muted: bool) {
        self.0.set_notifications_muted(muted);
    }

    #[wasm_bindgen(js_name = notificationsMuted)]
    pub fn notifications_muted(&self) -> bool {
        self.0.notifications_muted()
    }
}
