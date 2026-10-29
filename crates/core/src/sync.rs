//! Keeping snoozes and Slack channels the same on every device, through a
//! secret gist in the user's own GitHub account. This module is the pure
//! part: what the gist holds, how two copies merge, and how to read GitHub's
//! gist responses. Each app does the requests.
//!
//! Every entry carries the time of its last change and the newest change
//! wins, so ending a snooze is a change too: it stays in the document as an
//! entry without a value until it's old enough to forget.

use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::memory::{Memory, PrMemory};
use crate::sections::SectionPref;
use crate::slack;
use crate::views::View;

pub const FILE_NAME: &str = "review-pinger-sync.json";
pub const DESCRIPTION: &str = "Review Pinger sync: snoozes and Slack channels";

/// Entries this old, and no longer in effect, are dropped.
const FORGET_AFTER_DAYS: i64 = 30;

/// Where a gist can be read on GitHub, which redirects to the owner's copy.
pub fn gist_url(id: &str) -> String {
    format!("https://gist.github.com/{id}")
}

/// Whether a token can read and write gists, from the `X-OAuth-Scopes`
/// header of any API response. Fine-grained tokens have no such header and
/// can't use gists at all, so they never qualify.
pub fn can_sync(scopes_header: Option<&str>) -> bool {
    scopes_header.is_some_and(|scopes| scopes.split(',').any(|scope| scope.trim() == "gist"))
}

/// A value and when it last changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stamped<T> {
    pub value: T,
    pub at: DateTime<Utc>,
}

/// What the gist holds.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncDoc {
    pub version: u32,
    /// When each PR is snoozed until, by PR id; `None` once ended.
    pub snoozes: BTreeMap<String, Stamped<Option<DateTime<Utc>>>>,
    /// Slack channel links by lowercase `org/team-slug`; `None` once removed.
    pub team_channels: BTreeMap<String, Stamped<Option<String>>>,
    /// Order and visibility of "My PRs" sections: one whole list, not a map,
    /// since reordering is a single change, not many independent ones.
    #[serde(default)]
    pub sections: Option<Stamped<Vec<SectionPref>>>,
    /// Custom views by id; `None` once removed.
    #[serde(default)]
    pub views: BTreeMap<String, Stamped<Option<ViewDoc>>>,
    /// The Buildkite pipeline the CI statistics count builds in, one value
    /// like the sections; going back to the default is a value too.
    #[serde(default)]
    pub buildkite_pipeline: Option<Stamped<String>>,
}

/// A custom view's definition, as it crosses the gist: the id is the map key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewDoc {
    pub name: String,
    pub query: String,
}

/// What a device remembers about syncing.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncMemory {
    pub enabled: bool,
    /// The gist, once found or created.
    pub gist_id: Option<String>,
    /// When each snooze last changed on this device or was taken from the gist.
    pub snoozes: HashMap<String, DateTime<Utc>>,
    pub team_channels: HashMap<String, DateTime<Utc>>,
    /// When the "My PRs" section order last changed here or was taken from
    /// the gist.
    pub sections_changed_at: Option<DateTime<Utc>>,
    /// When each view last changed here or was taken from the gist.
    pub views: HashMap<String, DateTime<Utc>>,
    /// When the Buildkite pipeline last changed here or was taken from the gist.
    pub buildkite_pipeline_changed_at: Option<DateTime<Utc>>,
}

/// The outcome of merging the gist into a device.
#[derive(Debug, PartialEq, Eq)]
pub struct Reconciled {
    /// Snoozes or channels on this device changed, so the lists need deriving again.
    pub changed: bool,
    /// The merged document, when the gist doesn't have it yet.
    pub upload: Option<SyncDoc>,
}

fn newest<T: Clone>(
    mine: &mut BTreeMap<String, Stamped<T>>,
    theirs: &BTreeMap<String, Stamped<T>>,
) {
    for (key, entry) in theirs {
        // On a tie the other copy stays, so the two never swap places.
        if mine.get(key).is_none_or(|own| entry.at >= own.at) {
            mine.insert(key.clone(), entry.clone());
        }
    }
}

impl SyncDoc {
    /// Takes the newer entry for every key.
    fn merge(&mut self, other: &SyncDoc) {
        newest(&mut self.snoozes, &other.snoozes);
        newest(&mut self.team_channels, &other.team_channels);
        newest(&mut self.views, &other.views);
        if let Some(theirs) = &other.sections
            && self
                .sections
                .as_ref()
                .is_none_or(|ours| theirs.at >= ours.at)
        {
            self.sections = Some(theirs.clone());
        }
        if let Some(theirs) = &other.buildkite_pipeline
            && self
                .buildkite_pipeline
                .as_ref()
                .is_none_or(|ours| theirs.at >= ours.at)
        {
            self.buildkite_pipeline = Some(theirs.clone());
        }
    }

    fn forget_old(&mut self, now: DateTime<Utc>) {
        let cutoff = now - Duration::days(FORGET_AFTER_DAYS);
        self.snoozes
            .retain(|_, entry| entry.at > cutoff || entry.value.is_some_and(|until| until > now));
        self.team_channels
            .retain(|_, entry| entry.at > cutoff || entry.value.is_some());
        self.views
            .retain(|_, entry| entry.at > cutoff || entry.value.is_some());
    }
}

/// The document for this device's snoozes and channels. Entries from before
/// syncing was on get the current time as their change.
fn local_doc(memory: &mut Memory, now: DateTime<Utc>) -> SyncDoc {
    let mut doc = SyncDoc {
        version: 1,
        ..SyncDoc::default()
    };
    for (id, pr) in &memory.pull_requests {
        if let Some(until) = pr.snoozed_until {
            let at = *memory.sync.snoozes.entry(id.clone()).or_insert(now);
            doc.snoozes.insert(
                id.clone(),
                Stamped {
                    value: Some(until),
                    at,
                },
            );
        } else if let Some(at) = memory.sync.snoozes.get(id) {
            // Ended here. Ids with no memory left are PRs that closed, which
            // nobody needs to hear about.
            doc.snoozes.insert(
                id.clone(),
                Stamped {
                    value: None,
                    at: *at,
                },
            );
        }
    }
    for (team, link) in &memory.team_channels {
        let at = *memory.sync.team_channels.entry(team.clone()).or_insert(now);
        doc.team_channels.insert(
            team.clone(),
            Stamped {
                value: Some(link.clone()),
                at,
            },
        );
    }
    for (team, at) in &memory.sync.team_channels {
        doc.team_channels.entry(team.clone()).or_insert(Stamped {
            value: None,
            at: *at,
        });
    }
    if let Some(sections) = &memory.my_prs_sections {
        let at = *memory.sync.sections_changed_at.get_or_insert(now);
        doc.sections = Some(Stamped {
            value: sections.clone(),
            at,
        });
    }
    if let Some(pipeline) = &memory.buildkite_pipeline {
        let at = *memory.sync.buildkite_pipeline_changed_at.get_or_insert(now);
        doc.buildkite_pipeline = Some(Stamped {
            value: pipeline.clone(),
            at,
        });
    }
    for view in &memory.views {
        let at = *memory.sync.views.entry(view.id.clone()).or_insert(now);
        doc.views.insert(
            view.id.clone(),
            Stamped {
                value: Some(ViewDoc {
                    name: view.name.clone(),
                    query: view.query.clone(),
                }),
                at,
            },
        );
    }
    for (id, at) in &memory.sync.views {
        doc.views.entry(id.clone()).or_insert(Stamped {
            value: None,
            at: *at,
        });
    }
    doc
}

/// Takes what is newer in `merged` into the device. Returns whether anything
/// visible changed.
fn apply(memory: &mut Memory, merged: &SyncDoc, now: DateTime<Utc>) -> bool {
    let mut changed = false;
    for (id, entry) in &merged.snoozes {
        let own = memory.sync.snoozes.get(id).copied();
        let current = memory.pull_requests.get(id).and_then(|pr| pr.snoozed_until);
        // A snooze this device lost after recording it, because its PR dropped
        // out of a poll, comes back while it still runs.
        let lost = own == Some(entry.at)
            && current.is_none()
            && entry.value.is_some_and(|until| until > now);
        if own.is_some_and(|own| entry.at <= own) && !lost {
            continue;
        }
        memory.sync.snoozes.insert(id.clone(), entry.at);
        if current == entry.value {
            continue;
        }
        match (memory.pull_requests.get_mut(id), entry.value) {
            (Some(pr), until) => pr.snoozed_until = until,
            (None, Some(until)) => {
                let mut pr = PrMemory::new(now);
                pr.snoozed_until = Some(until);
                memory.pull_requests.insert(id.clone(), pr);
            }
            (None, None) => continue,
        }
        changed = true;
    }
    for (team, entry) in &merged.team_channels {
        if memory
            .sync
            .team_channels
            .get(team)
            .is_some_and(|own| entry.at <= *own)
        {
            continue;
        }
        let link = match &entry.value {
            // A hand-edited gist shouldn't put anything else in a chip.
            Some(link) if !slack::is_valid_link(link) => continue,
            other => other.clone(),
        };
        memory.sync.team_channels.insert(team.clone(), entry.at);
        if memory.team_channels.get(team) != link.as_ref() {
            match link {
                Some(link) => memory.team_channels.insert(team.clone(), link),
                None => memory.team_channels.remove(team),
            };
            changed = true;
        }
    }
    if let Some(entry) = &merged.sections {
        let is_newer = memory
            .sync
            .sections_changed_at
            .is_none_or(|own| entry.at > own);
        if is_newer {
            memory.sync.sections_changed_at = Some(entry.at);
            if memory.my_prs_sections.as_ref() != Some(&entry.value) {
                memory.my_prs_sections = Some(entry.value.clone());
                changed = true;
            }
        }
    }
    if let Some(entry) = &merged.buildkite_pipeline
        && memory
            .sync
            .buildkite_pipeline_changed_at
            .is_none_or(|own| entry.at > own)
        // A hand-edited gist shouldn't put anything but a pipeline name on a command line.
        && let Some(slug) = crate::memory::clean_pipeline(&entry.value)
    {
        memory.sync.buildkite_pipeline_changed_at = Some(entry.at);
        if memory.buildkite_pipeline() != slug {
            memory.buildkite_pipeline = Some(slug);
            changed = true;
        }
    }
    for (id, entry) in &merged.views {
        if memory
            .sync
            .views
            .get(id)
            .is_some_and(|own| entry.at <= *own)
        {
            continue;
        }
        memory.sync.views.insert(id.clone(), entry.at);
        let current = memory.views.iter().find(|v| &v.id == id);
        let same = current.map(|v| (v.name.as_str(), v.query.as_str()))
            == entry
                .value
                .as_ref()
                .map(|v| (v.name.as_str(), v.query.as_str()));
        if same {
            continue;
        }
        memory.views.retain(|v| &v.id != id);
        if let Some(doc) = &entry.value {
            memory.views.push(View {
                id: id.clone(),
                name: doc.name.clone(),
                query: doc.query.clone(),
            });
        }
        changed = true;
    }
    changed
}

/// Merges the gist's document (`None` when it has none) with this device's
/// snoozes and channels. The device takes what is newer, and the merged
/// document is returned for upload when the gist lacks any of it.
pub fn reconcile(memory: &mut Memory, remote: Option<SyncDoc>, now: DateTime<Utc>) -> Reconciled {
    let mut merged = local_doc(memory, now);
    let remote_doc = remote.clone().unwrap_or_default();
    merged.merge(&remote_doc);
    merged.forget_old(now);
    memory
        .sync
        .snoozes
        .retain(|id, _| merged.snoozes.contains_key(id));
    memory
        .sync
        .team_channels
        .retain(|team, _| merged.team_channels.contains_key(team));
    memory
        .sync
        .views
        .retain(|id, _| merged.views.contains_key(id));

    let changed = apply(memory, &merged, now);
    let current = remote.is_some_and(|doc| doc == merged);
    Reconciled {
        changed,
        upload: (!current).then_some(merged),
    }
}

/// The request body for creating the gist.
pub fn create_body(doc: &SyncDoc) -> String {
    json!({
        "description": DESCRIPTION,
        "public": false,
        "files": { FILE_NAME: { "content": content(doc) } },
    })
    .to_string()
}

/// The request body for updating the gist.
pub fn update_body(doc: &SyncDoc) -> String {
    json!({ "files": { FILE_NAME: { "content": content(doc) } } }).to_string()
}

fn content(doc: &SyncDoc) -> String {
    serde_json::to_string_pretty(doc).expect("a document is always valid JSON")
}

/// The id of the gist that holds the document, from the response to listing
/// the user's gists.
pub fn find_gist(list: &str) -> Option<String> {
    let gists: Vec<Value> = serde_json::from_str(list).ok()?;
    gists
        .iter()
        .find(|gist| gist["files"].get(FILE_NAME).is_some())
        .and_then(|gist| gist["id"].as_str())
        .map(str::to_string)
}

/// The document in a gist, or `None` when the gist doesn't have the file or
/// it isn't a document.
pub fn read_gist(gist: &str) -> Option<SyncDoc> {
    let gist: Value = serde_json::from_str(gist).ok()?;
    let file = gist["files"].get(FILE_NAME)?;
    serde_json::from_str(file["content"].as_str()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    const NOW: &str = "2026-10-28T12:00:00Z";

    fn snoozed(id: &str, until: &str, memory: &mut Memory) {
        memory.set_snooze(id, Some(at(until)), at(NOW));
    }

    fn doc_with_snooze(id: &str, until: Option<&str>, changed: &str) -> SyncDoc {
        SyncDoc {
            version: 1,
            snoozes: BTreeMap::from([(
                id.to_string(),
                Stamped {
                    value: until.map(at),
                    at: at(changed),
                },
            )]),
            ..SyncDoc::default()
        }
    }

    #[test]
    fn only_tokens_with_the_gist_scope_can_sync() {
        assert!(can_sync(Some("repo, read:org, gist")));
        assert!(can_sync(Some("gist")));
        assert!(!can_sync(Some("repo, read:org")));
        assert!(!can_sync(Some("")));
        // Fine-grained tokens send no header.
        assert!(!can_sync(None));
    }

    #[test]
    fn a_new_device_takes_the_snoozes_of_the_gist() {
        let mut memory = Memory::default();
        let remote = doc_with_snooze("pr1", Some("2026-11-02T09:00:00Z"), "2026-10-27T09:00:00Z");

        let result = reconcile(&mut memory, Some(remote), at(NOW));

        assert!(result.changed);
        assert_eq!(
            memory.snoozes().get("pr1"),
            Some(&at("2026-11-02T09:00:00Z"))
        );
        assert_eq!(result.upload, None);
    }

    #[test]
    fn the_first_device_uploads_what_it_has() {
        let mut memory = Memory::default();
        snoozed("pr1", "2026-11-02T09:00:00Z", &mut memory);
        memory
            .team_channels
            .insert("o/t".into(), "https://o.slack.com/archives/C1".into());

        let result = reconcile(&mut memory, None, at(NOW));

        assert!(!result.changed);
        let doc = result.upload.expect("the gist has nothing yet");
        assert_eq!(doc.snoozes["pr1"].value, Some(at("2026-11-02T09:00:00Z")));
        assert_eq!(
            doc.team_channels["o/t"].value.as_deref(),
            Some("https://o.slack.com/archives/C1")
        );
    }

    #[test]
    fn snoozes_from_before_syncing_count_as_changed_now() {
        let mut memory = Memory::default();
        memory.pull_requests.insert("pr1".into(), {
            let mut pr = PrMemory::new(at("2026-10-01T00:00:00Z"));
            pr.snoozed_until = Some(at("2026-11-02T09:00:00Z"));
            pr
        });

        let doc = reconcile(&mut memory, None, at(NOW)).upload.unwrap();

        assert_eq!(doc.snoozes["pr1"].at, at(NOW));
    }

    #[test]
    fn the_newer_change_wins() {
        let mut memory = Memory::default();
        snoozed("pr1", "2026-11-02T09:00:00Z", &mut memory);
        // Ended on the other device after it was set here.
        let remote = doc_with_snooze("pr1", None, "2026-10-28T13:00:00Z");

        let result = reconcile(&mut memory, Some(remote), at("2026-10-28T14:00:00Z"));

        assert!(result.changed);
        assert!(memory.snoozes().is_empty());
        assert_eq!(result.upload, None);
    }

    #[test]
    fn the_older_change_loses() {
        let mut memory = Memory::default();
        snoozed("pr1", "2026-11-02T09:00:00Z", &mut memory);
        let remote = doc_with_snooze("pr1", None, "2026-10-28T11:00:00Z");

        let result = reconcile(&mut memory, Some(remote), at(NOW));

        assert!(!result.changed);
        assert!(memory.snoozes().contains_key("pr1"));
        let doc = result.upload.expect("the gist is out of date");
        assert_eq!(doc.snoozes["pr1"].value, Some(at("2026-11-02T09:00:00Z")));
    }

    #[test]
    fn ending_a_snooze_here_reaches_the_gist() {
        let mut memory = Memory::default();
        snoozed("pr1", "2026-11-02T09:00:00Z", &mut memory);
        let remote = reconcile(&mut memory, None, at(NOW)).upload.unwrap();
        memory.set_snooze("pr1", None, at("2026-10-28T13:00:00Z"));

        let doc = reconcile(&mut memory, Some(remote), at("2026-10-28T13:00:00Z"))
            .upload
            .unwrap();

        assert_eq!(doc.snoozes["pr1"].value, None);
    }

    #[test]
    fn two_devices_settle_on_the_same_document() {
        let mut a = Memory::default();
        let mut b = Memory::default();
        snoozed("pr1", "2026-11-02T09:00:00Z", &mut a);
        b.set_snooze(
            "pr2",
            Some(at("2026-11-03T09:00:00Z")),
            at("2026-10-28T12:30:00Z"),
        );

        let gist = reconcile(&mut a, None, at(NOW)).upload.unwrap();
        let gist = reconcile(&mut b, Some(gist), at("2026-10-28T13:00:00Z"))
            .upload
            .unwrap();
        let again = reconcile(&mut a, Some(gist.clone()), at("2026-10-28T14:00:00Z"));

        assert!(again.changed);
        assert_eq!(again.upload, None);
        assert_eq!(a.snoozes().len(), 2);
        assert_eq!(b.snoozes().len(), 2);
    }

    #[test]
    fn a_pr_that_closed_here_is_not_ended_for_everyone() {
        let mut memory = Memory::default();
        snoozed("pr1", "2026-11-02T09:00:00Z", &mut memory);
        let remote = reconcile(&mut memory, None, at(NOW)).upload.unwrap();
        // The PR closed, so the poll forgot it.
        memory.pull_requests.clear();

        let result = reconcile(&mut memory, Some(remote), at("2026-10-29T12:00:00Z"));

        assert_eq!(result.upload, None);
    }

    #[test]
    fn a_snooze_lost_here_comes_back_from_the_gist() {
        let mut memory = Memory::default();
        snoozed("pr1", "2026-11-02T09:00:00Z", &mut memory);
        let remote = reconcile(&mut memory, None, at(NOW)).upload.unwrap();
        // Forgotten after a poll missed the PR, though the change is recorded.
        memory.pull_requests.clear();

        let result = reconcile(&mut memory, Some(remote), at("2026-10-28T12:05:00Z"));

        assert!(result.changed);
        assert!(memory.snoozes().contains_key("pr1"));
        assert_eq!(result.upload, None);
    }

    #[test]
    fn old_entries_are_forgotten_once_they_no_longer_matter() {
        let mut memory = Memory::default();
        let remote = SyncDoc {
            version: 1,
            snoozes: BTreeMap::from([
                (
                    "ended".to_string(),
                    Stamped {
                        value: Some(at("2026-09-02T09:00:00Z")),
                        at: at("2026-08-30T09:00:00Z"),
                    },
                ),
                (
                    "long".to_string(),
                    Stamped {
                        value: Some(at("2026-12-02T09:00:00Z")),
                        at: at("2026-08-30T09:00:00Z"),
                    },
                ),
            ]),
            ..SyncDoc::default()
        };

        let doc = reconcile(&mut memory, Some(remote), at(NOW))
            .upload
            .unwrap();

        assert!(!doc.snoozes.contains_key("ended"));
        assert!(doc.snoozes.contains_key("long"));
    }

    #[test]
    fn channels_sync_and_removals_stick() {
        let mut a = Memory::default();
        a.team_channels
            .insert("o/t".into(), "https://o.slack.com/archives/C1".into());
        let gist = reconcile(&mut a, None, at(NOW)).upload.unwrap();

        let mut b = Memory::default();
        assert!(reconcile(&mut b, Some(gist.clone()), at(NOW)).changed);
        assert_eq!(b.team_channels.len(), 1);

        b.set_team_channel("o/t", None, at("2026-10-28T13:00:00Z"));
        let gist = reconcile(&mut b, Some(gist), at("2026-10-28T13:00:00Z"))
            .upload
            .unwrap();
        assert!(reconcile(&mut a, Some(gist), at("2026-10-28T14:00:00Z")).changed);
        assert!(a.team_channels.is_empty());
    }

    #[test]
    fn a_channel_that_isnt_a_slack_link_is_ignored() {
        let mut memory = Memory::default();
        let remote = SyncDoc {
            version: 1,
            team_channels: BTreeMap::from([(
                "o/t".to_string(),
                Stamped {
                    value: Some("javascript:alert(1)".to_string()),
                    at: at("2026-10-27T09:00:00Z"),
                },
            )]),
            ..SyncDoc::default()
        };

        reconcile(&mut memory, Some(remote), at(NOW));

        assert!(memory.team_channels.is_empty());
    }

    fn builtin(section: crate::sections::Section, enabled: bool) -> SectionPref {
        SectionPref {
            kind: crate::sections::SectionKind::Builtin { section },
            enabled,
        }
    }

    #[test]
    fn sections_sync_as_one_whole_list() {
        use crate::sections::Section;

        let mut a = Memory::default();
        a.set_my_prs_sections(
            vec![
                builtin(Section::Merged, true),
                builtin(Section::Draft, false),
            ],
            at(NOW),
        );
        let gist = reconcile(&mut a, None, at(NOW)).upload.unwrap();

        let mut b = Memory::default();
        let result = reconcile(&mut b, Some(gist.clone()), at(NOW));
        assert!(result.changed);
        assert_eq!(
            b.my_prs_sections.as_ref().unwrap()[0],
            a.my_prs_sections.as_ref().unwrap()[0]
        );

        // An older reorder on b loses to a's newer one already in the gist,
        // which replaces it (so b's list does change, back to a's).
        b.set_my_prs_sections(vec![], at("2026-10-27T09:00:00Z"));
        let result = reconcile(&mut b, Some(gist), at(NOW));
        assert!(result.changed);
        assert_eq!(b.my_prs_sections, a.my_prs_sections);
    }

    #[test]
    fn the_buildkite_pipeline_syncs_as_one_value_and_the_newest_wins() {
        let mut a = Memory::default();
        a.set_buildkite_pipeline("kibana-on-merge", at("2026-10-27T09:00:00Z"));
        let gist = reconcile(&mut a, None, at(NOW)).upload.unwrap();

        // A device that never chose one takes the gist's.
        let mut b = Memory::default();
        assert_eq!(b.buildkite_pipeline(), "kibana-pull-request");
        assert!(reconcile(&mut b, Some(gist.clone()), at(NOW)).changed);
        assert_eq!(b.buildkite_pipeline(), "kibana-on-merge");

        // An older choice on another device loses to the newer one in the gist.
        let mut c = Memory::default();
        c.set_buildkite_pipeline("older", at("2026-10-26T09:00:00Z"));
        reconcile(&mut c, Some(gist), at(NOW));
        assert_eq!(c.buildkite_pipeline(), "kibana-on-merge");

        // And going back to the default is a change that syncs too.
        let mut d = Memory::default();
        d.set_buildkite_pipeline("other", at("2026-10-27T09:00:00Z"));
        let first = reconcile(&mut d, None, at(NOW)).upload.unwrap();
        d.set_buildkite_pipeline("kibana-pull-request", at("2026-10-28T09:00:00Z"));
        let upload = reconcile(&mut d, Some(first), at(NOW)).upload.unwrap();
        assert_eq!(
            upload.buildkite_pipeline.map(|p| p.value).as_deref(),
            Some("kibana-pull-request")
        );
    }

    #[test]
    fn a_pipeline_that_isnt_a_slug_is_ignored() {
        let mut memory = Memory::default();
        let remote = SyncDoc {
            version: 1,
            buildkite_pipeline: Some(Stamped {
                value: "$(rm -rf ~)".to_string(),
                at: at("2026-10-27T09:00:00Z"),
            }),
            ..SyncDoc::default()
        };

        reconcile(&mut memory, Some(remote), at(NOW));

        assert_eq!(memory.buildkite_pipeline, None);
        assert_eq!(memory.sync.buildkite_pipeline_changed_at, None);
    }

    #[test]
    fn a_new_device_takes_views_from_the_gist() {
        let mut a = Memory::default();
        a.add_view("P1 bugs".to_string(), "label:p1".to_string(), at(NOW));
        let gist = reconcile(&mut a, None, at(NOW)).upload.unwrap();

        let mut b = Memory::default();
        let result = reconcile(&mut b, Some(gist), at(NOW));

        assert!(result.changed);
        assert_eq!(b.views.len(), 1);
        assert_eq!(b.views[0].name, "P1 bugs");
        assert_eq!(b.views[0].query, "label:p1");
    }

    #[test]
    fn renaming_a_view_reaches_other_devices() {
        let mut a = Memory::default();
        let id = a
            .add_view("P1".to_string(), "label:p1".to_string(), at(NOW))
            .id
            .clone();
        let gist = reconcile(&mut a, None, at(NOW)).upload.unwrap();
        let mut b = Memory::default();
        reconcile(&mut b, Some(gist), at(NOW));

        a.update_view(
            &id,
            "P1 bugs".to_string(),
            "label:p1 is:open".to_string(),
            at("2026-10-28T13:00:00Z"),
        );
        let gist = reconcile(&mut a, None, at("2026-10-28T13:00:00Z"))
            .upload
            .unwrap();
        let result = reconcile(&mut b, Some(gist), at("2026-10-28T14:00:00Z"));

        assert!(result.changed);
        assert_eq!(b.views[0].name, "P1 bugs");
        assert_eq!(b.views[0].query, "label:p1 is:open");
    }

    #[test]
    fn deleting_a_view_removes_it_and_its_place_in_the_order_everywhere() {
        let mut a = Memory::default();
        let id = a
            .add_view("P1".to_string(), "label:p1".to_string(), at(NOW))
            .id
            .clone();
        let gist = reconcile(&mut a, None, at(NOW)).upload.unwrap();
        let mut b = Memory::default();
        reconcile(&mut b, Some(gist), at(NOW));
        assert_eq!(b.my_prs_sections().len(), 8); // 7 built in, plus the view

        a.remove_view(&id, at("2026-10-28T13:00:00Z"));
        let gist = reconcile(&mut a, None, at("2026-10-28T13:00:00Z"))
            .upload
            .unwrap();
        let result = reconcile(&mut b, Some(gist), at("2026-10-28T14:00:00Z"));

        assert!(result.changed);
        assert!(b.views.is_empty());
        assert_eq!(b.my_prs_sections().len(), 7);
    }

    #[test]
    fn gists_are_found_and_read() {
        let doc = doc_with_snooze("pr1", Some("2026-11-02T09:00:00Z"), "2026-10-27T09:00:00Z");
        let list = json!([
            { "id": "other", "files": { "notes.md": {} } },
            { "id": "mine", "files": { FILE_NAME: {} } },
        ])
        .to_string();
        let gist = json!({
            "id": "mine",
            "files": { FILE_NAME: { "content": content(&doc) } },
        })
        .to_string();

        assert_eq!(find_gist(&list).as_deref(), Some("mine"));
        assert_eq!(find_gist("[]"), None);
        assert_eq!(read_gist(&gist), Some(doc));
        assert_eq!(read_gist(r#"{"files":{}}"#), None);
    }

    #[test]
    fn bodies_hold_the_document_in_a_secret_gist() {
        let doc = SyncDoc::default();
        let create: Value = serde_json::from_str(&create_body(&doc)).unwrap();
        assert_eq!(create["public"], false);
        assert!(create["files"][FILE_NAME]["content"].is_string());
        let update: Value = serde_json::from_str(&update_body(&doc)).unwrap();
        assert!(update.get("public").is_none());
    }
}
