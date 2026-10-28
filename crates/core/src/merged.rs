//! The "Merged" section: your own PRs that have merged. Separate from
//! `prs`, since none of the open-PR machinery (actions, checks, reviewers,
//! snoozes) applies once a PR is merged.

use std::collections::HashSet;

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;

use crate::github::types::MergedPullRequest;

/// How far back the automatic (non-"Load more") view reaches.
pub const WINDOW: Duration = Duration::days(2);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedPrView {
    pub id: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub repo: String,
    pub merged_at: DateTime<Utc>,
}

fn view(pr: &MergedPullRequest) -> MergedPrView {
    MergedPrView {
        id: pr.id.clone(),
        number: pr.number,
        title: pr.title.clone(),
        url: pr.url.clone(),
        repo: pr.repository.name_with_owner.clone(),
        merged_at: pr.merged_at,
    }
}

/// `page` is the latest fetch of your most recently merged PRs; `loaded_more`
/// is what "Load more" has fetched beyond it this session. Returns PRs merged
/// within [`WINDOW`], plus whatever was loaded more, newest first, deduped.
pub fn derive(
    page: &[MergedPullRequest],
    loaded_more: &[MergedPullRequest],
    now: DateTime<Utc>,
) -> Vec<MergedPrView> {
    let cutoff = now - WINDOW;
    let mut seen = HashSet::new();
    let mut views: Vec<MergedPrView> = page
        .iter()
        .filter(|pr| pr.merged_at >= cutoff)
        .chain(loaded_more)
        .filter(|pr| seen.insert(pr.id.clone()))
        .map(view)
        .collect();
    views.sort_by_key(|v| std::cmp::Reverse(v.merged_at));
    views
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    const NOW: &str = "2026-10-28T12:00:00Z";

    fn pr(id: &str, merged_at: &str) -> MergedPullRequest {
        MergedPullRequest {
            id: id.to_string(),
            number: 1,
            title: "Fix it".to_string(),
            url: format!("https://github.com/o/r/pull/{id}"),
            repository: crate::github::types::Repository {
                name_with_owner: "o/r".to_string(),
            },
            merged_at: at(merged_at),
        }
    }

    #[test]
    fn only_whats_within_the_window_shows_without_loading_more() {
        let page = [
            pr("recent", "2026-10-27T12:00:00Z"),
            pr("old", "2026-10-20T12:00:00Z"),
        ];
        let views = derive(&page, &[], at(NOW));
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].id, "recent");
    }

    #[test]
    fn loaded_more_items_show_regardless_of_the_window() {
        let page = [pr("recent", "2026-10-27T12:00:00Z")];
        let loaded_more = [pr("old", "2026-10-20T12:00:00Z")];
        let views = derive(&page, &loaded_more, at(NOW));
        assert_eq!(views.len(), 2);
        // Newest first.
        assert_eq!(views[0].id, "recent");
        assert_eq!(views[1].id, "old");
    }

    #[test]
    fn an_id_in_both_lists_is_not_duplicated() {
        let page = [pr("a", "2026-10-27T12:00:00Z")];
        let loaded_more = [pr("a", "2026-10-27T12:00:00Z")];
        assert_eq!(derive(&page, &loaded_more, at(NOW)).len(), 1);
    }
}
