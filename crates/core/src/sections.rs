//! Which sections show in "My PRs", and in what order: a user preference,
//! synced like snoozes and Slack channels. Deciding what to fetch from that
//! preference lives here too, since it's pure.

use serde::{Deserialize, Serialize};

/// A section of the "My PRs" tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Section {
    Approved,
    NeedsAction,
    Waiting,
    Snoozed,
    Dormant,
    Draft,
    /// Merged in the last couple of days, or further back via "Load more".
    Merged,
}

impl Section {
    /// Every section, in the order new installs see them.
    pub const ALL: [Section; 7] = [
        Section::Approved,
        Section::NeedsAction,
        Section::Waiting,
        Section::Snoozed,
        Section::Dormant,
        Section::Draft,
        Section::Merged,
    ];

    /// Merged needs an extra query, so it starts off; everything else
    /// matches today's behavior.
    fn enabled_by_default(self) -> bool {
        !matches!(self, Section::Merged)
    }
}

/// Whether a section shows, and where.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionPref {
    pub section: Section,
    pub enabled: bool,
}

/// The order and visibility before any preference is saved.
pub fn defaults() -> Vec<SectionPref> {
    Section::ALL
        .into_iter()
        .map(|section| SectionPref {
            section,
            enabled: section.enabled_by_default(),
        })
        .collect()
}

/// `stored`, kept in the user's order, with any section it doesn't mention
/// (new to this version, or dropped by a hand-edited gist) appended at its
/// default position. Never empty, never missing a section, never two of the
/// same one, so the rest of the app can take the result at face value.
pub fn normalize(stored: Option<&[SectionPref]>) -> Vec<SectionPref> {
    let Some(stored) = stored else {
        return defaults();
    };
    let mut seen = std::collections::HashSet::new();
    let mut sections: Vec<SectionPref> = stored
        .iter()
        .filter(|pref| seen.insert(pref.section))
        .copied()
        .collect();
    for default in defaults() {
        if seen.insert(default.section) {
            sections.push(default);
        }
    }
    sections
}

/// Whether fetching open PRs you authored, and merged PRs you authored, can
/// be skipped: nothing visible would come of either.
pub struct NeedsQuery {
    pub open: bool,
    pub merged: bool,
}

/// What `prefs` (already normalized) need fetched from GitHub.
pub fn needs(prefs: &[SectionPref]) -> NeedsQuery {
    let enabled = |section: Section| prefs.iter().any(|p| p.section == section && p.enabled);
    NeedsQuery {
        open: [
            Section::Approved,
            Section::NeedsAction,
            Section::Waiting,
            Section::Snoozed,
            Section::Dormant,
            Section::Draft,
        ]
        .into_iter()
        .any(enabled),
        merged: enabled(Section::Merged),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_saved_yet_is_todays_order_with_merged_off() {
        let prefs = normalize(None);
        assert_eq!(prefs.len(), 7);
        assert_eq!(prefs[0].section, Section::Approved);
        assert!(
            prefs
                .iter()
                .all(|p| p.enabled || p.section == Section::Merged)
        );
    }

    #[test]
    fn a_saved_order_is_kept_as_is() {
        let saved = vec![
            SectionPref {
                section: Section::Merged,
                enabled: true,
            },
            SectionPref {
                section: Section::Waiting,
                enabled: false,
            },
        ];
        let prefs = normalize(Some(&saved));
        assert_eq!(prefs[0], saved[0]);
        assert_eq!(prefs[1], saved[1]);
        // Everything else saved nothing about: appended at the end, as default.
        assert_eq!(prefs.len(), 7);
        assert_eq!(prefs[2].section, Section::Approved);
    }

    #[test]
    fn duplicates_and_unknown_entries_dont_survive() {
        let saved = vec![
            SectionPref {
                section: Section::Draft,
                enabled: true,
            },
            SectionPref {
                section: Section::Draft,
                enabled: false,
            },
        ];
        let prefs = normalize(Some(&saved));
        assert_eq!(
            prefs.iter().filter(|p| p.section == Section::Draft).count(),
            1
        );
        // The first mention wins.
        assert!(
            prefs
                .iter()
                .find(|p| p.section == Section::Draft)
                .unwrap()
                .enabled
        );
    }

    #[test]
    fn the_open_query_is_skipped_only_when_every_open_section_is_off() {
        let mut prefs = defaults();
        assert!(needs(&prefs).open);
        for pref in &mut prefs {
            if pref.section != Section::Merged {
                pref.enabled = false;
            }
        }
        assert!(!needs(&prefs).open);
    }

    #[test]
    fn the_merged_query_follows_its_own_toggle() {
        assert!(!needs(&defaults()).merged);
        let mut prefs = defaults();
        prefs
            .iter_mut()
            .find(|p| p.section == Section::Merged)
            .unwrap()
            .enabled = true;
        assert!(needs(&prefs).merged);
    }
}
