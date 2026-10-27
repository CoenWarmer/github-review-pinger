//! Who is in which team, for the reviewer hover cards. Looked up from GitHub
//! (which needs the `read:org` scope), cached for an hour, and read when the
//! lists are derived.

use std::collections::{BTreeSet, HashMap, HashSet};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

/// How long a lookup is trusted. Memberships rarely change.
const TTL: Duration = Duration::hours(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityKind {
    Approved,
    ChangesRequested,
    Commented,
    Pushed,
}

/// Something a team member did on a pull request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub login: String,
    pub kind: ActivityKind,
    pub at: DateTime<Utc>,
    /// Where to read it: the comment, or the review when it has none.
    pub url: Option<String>,
}

/// The teams still to look up, lowercase `(org, slug)`.
#[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Needs {
    pub teams: BTreeSet<(String, String)>,
}

impl Needs {
    pub fn is_empty(&self) -> bool {
        self.teams.is_empty()
    }
}

/// The result of a lookup: lowercase member logins by team (`org/slug`).
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Found {
    pub teams: HashMap<String, HashSet<String>>,
    /// GitHub refused for lack of the `read:org` scope.
    pub denied: bool,
}

/// A team's members. `None` when GitHub had nothing to say (an organization or
/// team the token can't see), kept so it isn't asked again until it goes stale.
#[derive(Serialize, Deserialize)]
struct Entry {
    members: Option<HashSet<String>>,
    at: DateTime<Utc>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Directory {
    teams: HashMap<String, Entry>,
    /// When the last lookup was refused for lack of the scope, until one works.
    denied_at: Option<DateTime<Utc>>,
}

fn is_fresh(at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    now - at < TTL
}

impl Directory {
    /// Lowercase `org/slug`, how teams are keyed.
    pub fn key(org: &str, slug: &str) -> String {
        format!("{}/{}", org.to_lowercase(), slug.to_lowercase())
    }

    /// The lowercase logins in a team (`org/slug`), if looked up.
    pub fn team_members(&self, team: &str) -> Option<&HashSet<String>> {
        self.teams.get(team)?.members.as_ref()
    }

    /// Whether the last lookup was refused for lack of the scope.
    pub fn is_denied(&self) -> bool {
        self.denied_at.is_some()
    }

    /// What of `needs` isn't cached or has gone stale. Nothing while a recent
    /// lookup was refused, since asking again wouldn't change the answer.
    pub fn missing(&self, needs: &Needs, now: DateTime<Utc>) -> Needs {
        if self.denied_at.is_some_and(|at| is_fresh(at, now)) {
            return Needs::default();
        }
        Needs {
            teams: needs
                .teams
                .iter()
                .filter(|(org, slug)| {
                    !self
                        .teams
                        .get(&Self::key(org, slug))
                        .is_some_and(|entry| is_fresh(entry.at, now))
                })
                .cloned()
                .collect(),
        }
    }

    /// Caches the answer to a lookup of `asked`. Returns whether anything
    /// visible changed.
    pub fn merge(&mut self, asked: &Needs, mut found: Found, now: DateTime<Utc>) -> bool {
        if found.denied {
            let changed = self.denied_at.is_none();
            self.denied_at = Some(now);
            return changed;
        }
        let changed = !found.teams.is_empty() || self.denied_at.is_some();
        self.denied_at = None;
        for (org, slug) in &asked.teams {
            let key = Self::key(org, slug);
            let members = found.teams.remove(&key);
            self.teams.insert(key, Entry { members, at: now });
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    fn needs(teams: &[(&str, &str)]) -> Needs {
        Needs {
            teams: teams
                .iter()
                .map(|&(org, slug)| (org.to_string(), slug.to_string()))
                .collect(),
        }
    }

    fn found(teams: &[(&str, &[&str])]) -> Found {
        Found {
            teams: teams
                .iter()
                .map(|(team, members)| {
                    (
                        team.to_string(),
                        members.iter().map(|m| m.to_string()).collect(),
                    )
                })
                .collect(),
            denied: false,
        }
    }

    #[test]
    fn everything_is_missing_at_first_and_nothing_once_cached() {
        let mut directory = Directory::default();
        let wanted = needs(&[("o", "core")]);
        let now = at("2026-10-01T09:00:00Z");
        assert_eq!(directory.missing(&wanted, now), wanted);

        assert!(directory.merge(&wanted, found(&[("o/core", &["ana"])]), now));

        assert!(directory.missing(&wanted, now).is_empty());
        assert!(directory.team_members("o/core").unwrap().contains("ana"));
    }

    #[test]
    fn lookups_go_stale_after_an_hour() {
        let mut directory = Directory::default();
        let wanted = needs(&[("o", "core")]);
        directory.merge(
            &wanted,
            found(&[("o/core", &[])]),
            at("2026-10-01T09:00:00Z"),
        );

        assert!(
            directory
                .missing(&wanted, at("2026-10-01T09:59:00Z"))
                .is_empty()
        );
        assert_eq!(
            directory.missing(&wanted, at("2026-10-01T10:01:00Z")),
            wanted
        );
    }

    #[test]
    fn a_refusal_stops_asking_for_an_hour_until_a_lookup_works() {
        let mut directory = Directory::default();
        let wanted = needs(&[("o", "core")]);
        let denied = Found {
            denied: true,
            ..Found::default()
        };
        assert!(directory.merge(&wanted, denied, at("2026-10-01T09:00:00Z")));
        assert!(directory.is_denied());
        assert!(
            directory
                .missing(&wanted, at("2026-10-01T09:30:00Z"))
                .is_empty()
        );
        assert_eq!(
            directory.missing(&wanted, at("2026-10-01T10:30:00Z")),
            wanted
        );

        directory.merge(
            &wanted,
            found(&[("o/core", &[])]),
            at("2026-10-01T10:30:00Z"),
        );
        assert!(!directory.is_denied());
    }

    #[test]
    fn what_github_cannot_see_is_not_asked_again_for_an_hour() {
        let mut directory = Directory::default();
        let wanted = needs(&[("hidden", "core")]);
        directory.merge(&wanted, Found::default(), at("2026-10-01T09:00:00Z"));

        assert!(directory.team_members("hidden/core").is_none());
        assert!(
            directory
                .missing(&wanted, at("2026-10-01T09:30:00Z"))
                .is_empty()
        );
    }
}
