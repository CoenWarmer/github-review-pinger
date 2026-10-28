//! What a browser needs from the core, held between calls the way the desktop
//! poller holds it: the state kept across polls, the team directory, the
//! settings, and the last fetch. The page does the fetching and storage;
//! everything crosses as JSON.

use std::collections::HashMap;

use chrono::{DateTime, Duration, FixedOffset, Utc};
use review_pinger_core::auth::TokenSource;
use review_pinger_core::directory::{Directory, Found, Needs};
use review_pinger_core::engine::{self, Fetched};
use review_pinger_core::github::types::MergedPullRequest;
use review_pinger_core::github::types::PullRequest;
use review_pinger_core::memory::Memory;
use review_pinger_core::merged;
use review_pinger_core::notify::Notification;
use review_pinger_core::prs::{self, PrView};
use review_pinger_core::reviews::ReviewView;
use review_pinger_core::sections::SectionPref;
use review_pinger_core::settings::Settings;
use review_pinger_core::slack::{self, Channel};
use review_pinger_core::sync;
use serde::{Deserialize, Serialize};

/// What is kept between visits.
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Persisted {
    memory: Memory,
    directory: Directory,
}

/// A fetch, as the page assembles it from GraphQL responses.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FetchedInput {
    viewer: String,
    #[serde(default)]
    sso_partial: bool,
    pull_requests: Vec<PullRequest>,
    review_pull_requests: Vec<PullRequest>,
}

/// What the lists look like after a poll or a change.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Update {
    pull_requests: Vec<PrView>,
    review_requests: Vec<ReviewView>,
    /// New since the last poll. Empty after anything but a poll.
    notifications: Vec<Notification>,
    team_channels: HashMap<String, Channel>,
}

pub struct PingerState {
    settings: Settings,
    memory: Memory,
    directory: Directory,
    latest: Option<Fetched>,
    first_poll: bool,
}

fn time(s: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(s)
        .map(|t| t.with_timezone(&Utc))
        .map_err(|e| format!("Not a time: {s} ({e})"))
}

fn json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}

impl PingerState {
    /// Restores what `state` returned earlier. Anything unreadable starts fresh.
    pub fn new(saved: Option<&str>) -> Self {
        let persisted: Persisted = saved
            .and_then(|saved| serde_json::from_str(saved).ok())
            .unwrap_or_default();
        Self {
            settings: Settings::default(),
            memory: persisted.memory,
            directory: persisted.directory,
            latest: None,
            first_poll: true,
        }
    }

    /// What to keep until the next visit.
    pub fn state(&self) -> Result<String, String> {
        // Serialized by reference, to avoid cloning the whole state.
        #[derive(Serialize)]
        struct Out<'a> {
            memory: &'a Memory,
            directory: &'a Directory,
        }
        json(&Out {
            memory: &self.memory,
            directory: &self.directory,
        })
    }

    /// Replaces the settings with `settings.json`-style JSON.
    pub fn set_settings(&mut self, settings: &str) -> Result<(), String> {
        self.settings = serde_json::from_str(settings).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Oldest update that still counts for PRs the viewer reviewed, as a date.
    pub fn reviewed_since(&self, now: &str) -> Result<String, String> {
        let since = time(now)? - engine::dormant_after(&self.settings);
        Ok(since.date_naive().to_string())
    }

    /// Takes a full fetch and returns the lists and what to notify about.
    /// `tz_offset_minutes` is the local time east of UTC, which the weekday
    /// nudges count in.
    pub fn poll(
        &mut self,
        fetched: &str,
        now: &str,
        tz_offset_minutes: i32,
    ) -> Result<String, String> {
        let input: FetchedInput = serde_json::from_str(fetched).map_err(|e| e.to_string())?;
        let now = time(now)?;
        let tz = FixedOffset::east_opt(tz_offset_minutes.saturating_mul(60))
            .ok_or("Time zone out of range")?;
        let fetched = Fetched {
            viewer: input.viewer,
            token_source: TokenSource::Pat,
            sso_partial: input.sso_partial,
            pull_requests: input.pull_requests,
            review_pull_requests: input.review_pull_requests,
        };
        let (pull_requests, review_requests) =
            engine::derive(&fetched, &self.settings, &self.memory, &self.directory, now);
        let first_poll = std::mem::replace(&mut self.first_poll, false);
        let notifications = engine::record_poll(
            &pull_requests,
            &review_requests,
            &fetched.pull_requests,
            &self.settings,
            &mut self.memory,
            now,
            first_poll,
            &tz,
        );
        self.latest = Some(fetched);
        json(&Update {
            pull_requests,
            review_requests,
            notifications,
            team_channels: self.channels(),
        })
    }

    /// The lists again from the last fetch, after something changed. `None`
    /// before the first poll.
    pub fn derived(&self, now: &str) -> Result<Option<String>, String> {
        let Some(fetched) = &self.latest else {
            return Ok(None);
        };
        let (pull_requests, review_requests) = engine::derive(
            fetched,
            &self.settings,
            &self.memory,
            &self.directory,
            time(now)?,
        );
        json(&Update {
            pull_requests,
            review_requests,
            notifications: Vec::new(),
            team_channels: self.channels(),
        })
        .map(Some)
    }

    /// Patches refreshed PRs (raw GraphQL nodes) into the last fetch.
    pub fn apply_refresh(&mut self, fresh: &str) -> Result<(), String> {
        let fresh: Vec<PullRequest> = serde_json::from_str(fresh).map_err(|e| e.to_string())?;
        if let Some(fetched) = &mut self.latest {
            engine::apply_refresh(fetched, fresh);
        }
        Ok(())
    }

    /// Snoozes a PR for `days`, or ends its snooze with `None`.
    pub fn set_snooze(&mut self, id: &str, days: Option<u32>, now: &str) -> Result<(), String> {
        let now = time(now)?;
        let until = days.map(|days| now + Duration::days(days.into()));
        self.memory.set_snooze(id, until, now);
        Ok(())
    }

    /// The teams, as `[org, slug]`, whose members still have to be looked up.
    pub fn directory_needs(&self, now: &str) -> Result<String, String> {
        let Some(fetched) = &self.latest else {
            return json(&Needs::default());
        };
        let needs = prs::directory_needs(
            fetched
                .pull_requests
                .iter()
                .chain(&fetched.review_pull_requests),
        );
        json(&self.directory.missing(&needs, time(now)?))
    }

    /// Stores the answer to a lookup of `asked` (the JSON from `directory_needs`).
    /// Returns whether anything changed, so the lists should be derived again.
    pub fn merge_directory(&mut self, asked: &str, found: &str, now: &str) -> Result<bool, String> {
        let asked: Needs = serde_json::from_str(asked).map_err(|e| e.to_string())?;
        let found: Found = serde_json::from_str(found).map_err(|e| e.to_string())?;
        Ok(self.directory.merge(&asked, found, time(now)?))
    }

    /// The team lookup was refused for lack of the `read:org` scope.
    pub fn directory_denied(&self) -> bool {
        self.directory.is_denied()
    }

    /// Saves a Slack channel link for a team. Fails for anything that isn't one.
    pub fn set_team_channel(&mut self, team: &str, link: &str, now: &str) -> Result<(), String> {
        if !slack::is_valid_link(link) {
            return Err("That doesn't look like a Slack channel link.".to_string());
        }
        self.memory
            .set_team_channel(team, Some(link.to_string()), time(now)?);
        Ok(())
    }

    pub fn remove_team_channel(&mut self, team: &str, now: &str) -> Result<(), String> {
        self.memory.set_team_channel(team, None, time(now)?);
        Ok(())
    }

    fn channels(&self) -> HashMap<String, Channel> {
        slack::merged_channels(&self.memory.team_channels, &self.settings.team_channels)
    }

    pub fn team_channels(&self) -> Result<String, String> {
        json(&self.channels())
    }

    pub fn set_notifications_muted(&mut self, muted: bool) {
        self.memory.notifications_muted = muted;
    }

    pub fn notifications_muted(&self) -> bool {
        self.memory.notifications_muted
    }

    pub fn sync_enabled(&self) -> bool {
        self.memory.sync.enabled
    }

    pub fn set_sync_enabled(&mut self, enabled: bool) {
        self.memory.sync.enabled = enabled;
    }

    /// The gist that holds the synced snoozes and channels, once known.
    pub fn sync_gist(&self) -> Option<String> {
        self.memory.sync.gist_id.clone()
    }

    pub fn set_sync_gist(&mut self, id: Option<String>) {
        self.memory.sync.gist_id = id;
    }

    /// Where the sync gist is on GitHub, once there is one.
    pub fn sync_gist_url(&self) -> Option<String> {
        self.memory.sync.gist_id.as_deref().map(sync::gist_url)
    }

    /// Whether a token can use gists, from its `X-OAuth-Scopes` header.
    pub fn can_sync(&self, scopes: Option<String>) -> bool {
        sync::can_sync(scopes.as_deref())
    }

    /// The id of the sync gist in a list of the user's gists.
    pub fn find_sync_gist(&self, list: &str) -> Option<String> {
        sync::find_gist(list)
    }

    /// Merges the sync gist (as GitHub returned it; `None` when there is
    /// none yet) into the snoozes and channels. Returns
    /// `{ changed, createBody, updateBody }`: whether the lists need deriving
    /// again, and the request bodies for the gist when it lacks something.
    pub fn sync_reconcile(&mut self, gist: Option<&str>, now: &str) -> Result<String, String> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Out {
            changed: bool,
            create_body: Option<String>,
            update_body: Option<String>,
        }
        let remote = gist.and_then(sync::read_gist);
        let result = sync::reconcile(&mut self.memory, remote, time(now)?);
        json(&Out {
            changed: result.changed,
            create_body: result.upload.as_ref().map(sync::create_body),
            update_body: result.upload.as_ref().map(sync::update_body),
        })
    }

    /// The order and visibility of "My PRs" sections: what was saved,
    /// completed with any section it's missing.
    pub fn my_prs_sections(&self) -> Result<String, String> {
        json(&self.memory.my_prs_sections())
    }

    pub fn set_my_prs_sections(&mut self, sections: &str, now: &str) -> Result<(), String> {
        let sections: Vec<SectionPref> =
            serde_json::from_str(sections).map_err(|e| e.to_string())?;
        self.memory.set_my_prs_sections(sections, time(now)?);
        Ok(())
    }

    /// The Merged section: `page` is the latest automatic fetch, `loaded_more`
    /// whatever "Load more" has fetched this session (both raw GraphQL
    /// nodes), merged within the window plus loaded more, newest first.
    pub fn merged_derive(
        &self,
        page: &str,
        loaded_more: &str,
        now: &str,
    ) -> Result<String, String> {
        let page: Vec<MergedPullRequest> = serde_json::from_str(page).map_err(|e| e.to_string())?;
        let loaded_more: Vec<MergedPullRequest> =
            serde_json::from_str(loaded_more).map_err(|e| e.to_string())?;
        json(&merged::derive(&page, &loaded_more, time(now)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn pr(id: &str, overrides: Value) -> Value {
        let mut pr = json!({
            "id": id,
            "number": 1,
            "title": "Fix it",
            "url": "https://github.com/o/r/pull/1",
            "isDraft": false,
            "createdAt": "2026-10-01T09:00:00Z",
            "reviewDecision": null,
            "mergeable": "MERGEABLE",
            "autoMergeRequest": null,
            "repository": { "nameWithOwner": "o/r" },
            "commits": { "nodes": [] },
            "timelineItems": { "nodes": [] },
        });
        for (key, value) in overrides.as_object().unwrap() {
            pr[key] = value.clone();
        }
        pr
    }

    fn fetch(prs: Vec<Value>, reviews: Vec<Value>) -> String {
        json!({ "viewer": "me", "pullRequests": prs, "reviewPullRequests": reviews }).to_string()
    }

    fn update(raw: &str) -> Value {
        serde_json::from_str(raw).unwrap()
    }

    const NOW: &str = "2026-10-02T10:00:00Z";

    #[test]
    fn a_poll_returns_both_lists() {
        let mut pinger = PingerState::new(None);
        let out = pinger
            .poll(
                &fetch(
                    vec![pr("mine", json!({}))],
                    vec![pr("theirs", json!({ "reviewRequested": true, "author": { "__typename": "User", "login": "ana" } }))],
                ),
                NOW,
                120,
            )
            .unwrap();
        let out = update(&out);
        assert_eq!(out["pullRequests"].as_array().unwrap().len(), 1);
        assert_eq!(out["reviewRequests"].as_array().unwrap().len(), 1);
        assert_eq!(out["reviewRequests"][0]["group"], "needsReview");
        // The first poll after install is silent.
        assert!(out["notifications"].as_array().unwrap().is_empty());
    }

    #[test]
    fn snoozing_moves_a_pr_and_it_is_remembered() {
        let mut pinger = PingerState::new(None);
        pinger
            .poll(&fetch(vec![pr("mine", json!({}))], vec![]), NOW, 0)
            .unwrap();
        pinger.set_snooze("mine", Some(3), NOW).unwrap();

        let out = update(&pinger.derived(NOW).unwrap().unwrap());
        assert_eq!(out["pullRequests"][0]["group"], "snoozed");

        // Kept across visits.
        let restored = PingerState::new(Some(&pinger.state().unwrap()));
        assert_eq!(restored.memory.snoozes().len(), 1);

        pinger.set_snooze("mine", None, NOW).unwrap();
        let out = update(&pinger.derived(NOW).unwrap().unwrap());
        assert_ne!(out["pullRequests"][0]["group"], "snoozed");
    }

    #[test]
    fn a_snooze_survives_a_poll_that_misses_the_pr() {
        let mut pinger = PingerState::new(None);
        pinger.set_snooze("mine", Some(5), NOW).unwrap();
        let group = |out: String| update(&out)["pullRequests"][0]["group"].clone();
        let with = fetch(vec![pr("mine", json!({}))], vec![]);

        assert_eq!(group(pinger.poll(&with, NOW, 120).unwrap()), "snoozed");
        // GitHub's search sometimes leaves a PR out for a poll.
        pinger.poll(&fetch(vec![], vec![]), NOW, 120).unwrap();

        assert_eq!(group(pinger.poll(&with, NOW, 120).unwrap()), "snoozed");
    }

    #[test]
    fn nothing_is_derived_before_the_first_poll() {
        assert_eq!(PingerState::new(None).derived(NOW).unwrap(), None);
    }

    #[test]
    fn only_slack_links_are_saved_as_team_channels() {
        let mut pinger = PingerState::new(None);
        assert!(
            pinger
                .set_team_channel("O/Core", "https://example.com/x", NOW)
                .is_err()
        );
        pinger
            .set_team_channel("O/Core", "https://app.slack.com/client/T1/C1", NOW)
            .unwrap();
        let channels: Value = serde_json::from_str(&pinger.team_channels().unwrap()).unwrap();
        assert_eq!(channels["o/core"]["source"], "saved");
        pinger.remove_team_channel("o/CORE", NOW).unwrap();
        assert_eq!(pinger.team_channels().unwrap(), "{}");
    }

    #[test]
    fn a_snooze_made_on_one_device_reaches_another_through_the_gist() {
        let mut desktop = PingerState::new(None);
        desktop.set_snooze("pr1", Some(5), NOW).unwrap();
        let first: Value =
            serde_json::from_str(&desktop.sync_reconcile(None, NOW).unwrap()).unwrap();
        let create: Value = serde_json::from_str(first["createBody"].as_str().unwrap()).unwrap();
        let content = create["files"][review_pinger_core::sync::FILE_NAME]["content"].clone();
        let gist =
            json!({ "files": { review_pinger_core::sync::FILE_NAME: { "content": content } } });

        let mut web = PingerState::new(None);
        let second: Value =
            serde_json::from_str(&web.sync_reconcile(Some(&gist.to_string()), NOW).unwrap())
                .unwrap();

        assert_eq!(second["changed"], true);
        assert!(second["updateBody"].is_null());
        assert!(web.state().unwrap().contains("pr1"));
    }

    #[test]
    fn sync_is_off_until_turned_on_and_remembers_its_gist() {
        let mut pinger = PingerState::new(None);
        assert!(!pinger.sync_enabled());
        pinger.set_sync_enabled(true);
        pinger.set_sync_gist(Some("abc".into()));

        let restored = PingerState::new(Some(&pinger.state().unwrap()));

        assert!(restored.sync_enabled());
        assert_eq!(restored.sync_gist().as_deref(), Some("abc"));
        assert!(restored.can_sync(Some("repo, gist".into())));
        assert!(!restored.can_sync(None));
    }

    #[test]
    fn sections_are_saved_and_restored_with_todays_defaults_filled_in() {
        let mut pinger = PingerState::new(None);
        let defaults: Value = serde_json::from_str(&pinger.my_prs_sections().unwrap()).unwrap();
        assert_eq!(defaults.as_array().unwrap().len(), 7);

        pinger
            .set_my_prs_sections(
                r#"[{"section":"merged","enabled":true},{"section":"draft","enabled":false}]"#,
                NOW,
            )
            .unwrap();
        let restored = PingerState::new(Some(&pinger.state().unwrap()));
        let sections: Value = serde_json::from_str(&restored.my_prs_sections().unwrap()).unwrap();
        assert_eq!(sections[0]["section"], "merged");
        assert_eq!(sections[0]["enabled"], true);
        assert_eq!(sections[1]["section"], "draft");
        assert_eq!(sections[1]["enabled"], false);
        // Everything else, not mentioned, keeps today's default.
        assert_eq!(sections.as_array().unwrap().len(), 7);
    }

    #[test]
    fn the_merged_section_combines_the_page_with_what_was_loaded_more() {
        let pinger = PingerState::new(None);
        let pr = |id: &str, merged_at: &str| {
            json!({
                "id": id, "number": 1, "title": "Fix it", "url": "u",
                "mergedAt": merged_at, "repository": { "nameWithOwner": "o/r" },
            })
        };
        let page = json!([pr("recent", "2026-10-27T12:00:00Z")]).to_string();
        let loaded_more = json!([pr("old", "2026-10-01T12:00:00Z")]).to_string();

        let views: Value =
            serde_json::from_str(&pinger.merged_derive(&page, &loaded_more, NOW).unwrap()).unwrap();

        assert_eq!(views.as_array().unwrap().len(), 2);
        assert_eq!(views[0]["id"], "recent");
        assert_eq!(views[1]["id"], "old");
    }

    #[test]
    fn the_team_directory_is_asked_for_then_remembered() {
        let team = json!({ "__typename": "Team", "slug": "core", "combinedSlug": "o/core" });
        let mut pinger = PingerState::new(None);
        pinger
            .poll(
                &fetch(
                    vec![pr(
                        "mine",
                        json!({ "reviewRequests": { "nodes": [{ "requestedReviewer": team }] } }),
                    )],
                    vec![],
                ),
                NOW,
                0,
            )
            .unwrap();

        let asked = pinger.directory_needs(NOW).unwrap();
        assert_eq!(update(&asked)["teams"], json!([["o", "core"]]));

        let found = json!({ "teams": { "o/core": ["ana"] } }).to_string();
        assert!(pinger.merge_directory(&asked, &found, NOW).unwrap());
        assert_eq!(
            update(&pinger.directory_needs(NOW).unwrap())["teams"],
            json!([])
        );
        assert!(!pinger.directory_denied());

        // Survives a reload.
        let restored = PingerState::new(Some(&pinger.state().unwrap()));
        assert!(
            restored
                .directory
                .team_members("o/core")
                .unwrap()
                .contains("ana")
        );
    }

    #[test]
    fn a_refused_lookup_is_reported() {
        let mut pinger = PingerState::new(None);
        assert!(
            pinger
                .merge_directory(
                    &json!({ "teams": [] }).to_string(),
                    &json!({ "denied": true }).to_string(),
                    NOW
                )
                .unwrap()
        );
        assert!(pinger.directory_denied());
    }

    #[test]
    fn the_reviewed_since_date_follows_the_dormancy_setting() {
        let mut pinger = PingerState::new(None);
        assert_eq!(
            pinger.reviewed_since("2026-10-31T10:00:00Z").unwrap(),
            "2026-10-01"
        );
        pinger
            .set_settings(&json!({ "dormantAfterDays": 10 }).to_string())
            .unwrap();
        assert_eq!(
            pinger.reviewed_since("2026-10-31T10:00:00Z").unwrap(),
            "2026-10-21"
        );
    }

    #[test]
    fn bad_input_is_an_error_not_a_panic() {
        let mut pinger = PingerState::new(Some("not json"));
        assert!(pinger.poll("{", NOW, 0).is_err());
        assert!(pinger.poll(&fetch(vec![], vec![]), "yesterday", 0).is_err());
        assert!(pinger.poll(&fetch(vec![], vec![]), NOW, 100_000).is_err());
        assert!(pinger.set_settings("\"nope\"").is_err());
    }
}
