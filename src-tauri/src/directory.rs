//! Who is in which team, for the reviewer hover cards. Looked up from GitHub
//! (which needs the `read:org` scope), cached for an hour, and read when the
//! lists are derived.

use std::collections::{BTreeSet, HashMap, HashSet};

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;

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
}

/// What still has to be looked up, lowercase: teams as `(org, slug)`, users as
/// `(org, login)`.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Needs {
    pub teams: BTreeSet<(String, String)>,
    pub users: BTreeSet<(String, String)>,
}

impl Needs {
    pub fn is_empty(&self) -> bool {
        self.teams.is_empty() && self.users.is_empty()
    }
}

/// The result of a lookup, keyed like [`Directory`]: teams by `org/slug`
/// with their members' logins, users by `org/login` with their team slugs.
#[derive(Debug, Default)]
pub struct Found {
    pub teams: HashMap<String, HashSet<String>>,
    pub users: HashMap<String, Vec<String>>,
    /// GitHub refused for lack of the `read:org` scope.
    pub denied: bool,
}

/// A lookup result. `None` when GitHub had nothing to say (an organization or
/// team the token can't see), kept so it isn't asked again until it goes stale.
struct Entry<T> {
    value: Option<T>,
    at: DateTime<Utc>,
}

#[derive(Default)]
pub struct Directory {
    teams: HashMap<String, Entry<HashSet<String>>>,
    users: HashMap<String, Entry<Vec<String>>>,
    /// When the last lookup was refused for lack of the scope, until one works.
    denied_at: Option<DateTime<Utc>>,
}

fn is_fresh(at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    now - at < TTL
}

impl Directory {
    /// Lowercase `org/name`, how teams and users are keyed.
    pub fn key(org: &str, name: &str) -> String {
        format!("{}/{}", org.to_lowercase(), name.to_lowercase())
    }

    /// The lowercase logins in a team (`org/slug`), if looked up.
    pub fn team_members(&self, team: &str) -> Option<&HashSet<String>> {
        self.teams.get(team)?.value.as_ref()
    }

    /// The slugs of the teams a user belongs to in an organization.
    pub fn user_teams(&self, org: &str, login: &str) -> Option<&[String]> {
        self.users.get(&Self::key(org, login))?.value.as_deref()
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
        let stale = |at: Option<DateTime<Utc>>| !at.is_some_and(|at| is_fresh(at, now));
        Needs {
            teams: needs
                .teams
                .iter()
                .filter(|(org, slug)| {
                    stale(self.teams.get(&Self::key(org, slug)).map(|entry| entry.at))
                })
                .cloned()
                .collect(),
            users: needs
                .users
                .iter()
                .filter(|(org, login)| {
                    stale(self.users.get(&Self::key(org, login)).map(|entry| entry.at))
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
        let changed =
            !found.teams.is_empty() || !found.users.is_empty() || self.denied_at.is_some();
        self.denied_at = None;
        for (org, slug) in &asked.teams {
            let key = Self::key(org, slug);
            let value = found.teams.remove(&key);
            self.teams.insert(key, Entry { value, at: now });
        }
        for (org, login) in &asked.users {
            let key = Self::key(org, login);
            let value = found.users.remove(&key).map(|mut slugs| {
                slugs.sort();
                slugs
            });
            self.users.insert(key, Entry { value, at: now });
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

    fn needs(teams: &[(&str, &str)], users: &[(&str, &str)]) -> Needs {
        let pair = |&(a, b): &(&str, &str)| (a.to_string(), b.to_string());
        Needs {
            teams: teams.iter().map(pair).collect(),
            users: users.iter().map(pair).collect(),
        }
    }

    #[test]
    fn everything_is_missing_at_first_and_nothing_once_cached() {
        let mut directory = Directory::default();
        let wanted = needs(&[("o", "core")], &[("o", "ana")]);
        let now = at("2026-10-01T09:00:00Z");
        assert_eq!(directory.missing(&wanted, now), wanted);

        let mut found = Found::default();
        found
            .teams
            .insert("o/core".into(), ["ana".to_string()].into());
        found
            .users
            .insert("o/ana".into(), vec!["web".into(), "core".into()]);
        assert!(directory.merge(&wanted, found, now));

        assert!(directory.missing(&wanted, now).is_empty());
        assert!(directory.team_members("o/core").unwrap().contains("ana"));
        // Teams come back sorted.
        assert_eq!(directory.user_teams("O", "ANA").unwrap(), ["core", "web"]);
    }

    #[test]
    fn lookups_go_stale_after_an_hour() {
        let mut directory = Directory::default();
        let mut found = Found::default();
        found.teams.insert("o/core".into(), HashSet::new());
        let wanted = needs(&[("o", "core")], &[]);
        directory.merge(&wanted, found, at("2026-10-01T09:00:00Z"));

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
        let wanted = needs(&[("o", "core")], &[]);
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

        let mut found = Found::default();
        found.teams.insert("o/core".into(), HashSet::new());
        directory.merge(&wanted, found, at("2026-10-01T10:30:00Z"));
        assert!(!directory.is_denied());
    }

    #[test]
    fn what_github_cannot_see_is_not_asked_again_for_an_hour() {
        let mut directory = Directory::default();
        let wanted = needs(&[("hidden", "core")], &[("hidden", "ana")]);
        directory.merge(&wanted, Found::default(), at("2026-10-01T09:00:00Z"));

        assert!(directory.team_members("hidden/core").is_none());
        assert!(directory.user_teams("hidden", "ana").is_none());
        assert!(
            directory
                .missing(&wanted, at("2026-10-01T09:30:00Z"))
                .is_empty()
        );
    }
}
