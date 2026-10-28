//! Custom views: a user-defined "My PRs" section backed by a GitHub search
//! query, the same syntax github.com's own saved views use. Unlike those,
//! Review Pinger has no way to read them, so a view defined here is its own,
//! separate thing.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// Stable regardless of renames, so the section order and sync don't break.
    pub id: String,
    pub name: String,
    /// GitHub issue-search qualifiers. `is:pr` is always added, so a view
    /// can't accidentally return issues.
    pub query: String,
}

impl View {
    /// The text to actually search: `is:pr`, then whatever the view asks for.
    pub fn search(&self) -> String {
        let query = self.query.trim();
        if query.is_empty() {
            "is:pr".to_string()
        } else {
            format!("is:pr {query}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_pr_is_always_in_the_search_even_over_an_empty_query() {
        let view = |query: &str| View {
            id: "v1".into(),
            name: "Mine".into(),
            query: query.to_string(),
        };
        assert_eq!(
            view("label:p1 author:ana").search(),
            "is:pr label:p1 author:ana"
        );
        assert_eq!(view("").search(), "is:pr");
        assert_eq!(view("   ").search(), "is:pr");
        // Typing it too is harmless, not doubled up into something invalid.
        assert_eq!(view("is:pr label:p1").search(), "is:pr is:pr label:p1");
    }
}
