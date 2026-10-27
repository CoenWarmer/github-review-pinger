//! Slack channel links for team chips: which links are acceptable, and the
//! mapping from teams to channels.

use std::collections::HashMap;

/// Slack channel links we'll store and open: `slack://` links, and https
/// links on `slack.com`. Anything else is rejected so a settings file or a
/// pasted value can't make the app open an arbitrary URL.
pub fn is_valid_link(link: &str) -> bool {
    if let Some(rest) = link.strip_prefix("slack://") {
        return !rest.is_empty();
    }
    let Some(rest) = link.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    // A userinfo part (`slack.com@evil.example`) would hide the real host.
    !host.contains('@') && (host == "slack.com" || host.ends_with(".slack.com"))
}

/// The channels to offer: those saved from the popover, overridden by
/// `settings.json`. Teams are matched case-insensitively. Invalid links are
/// dropped.
pub fn merged_channels(
    saved: &HashMap<String, String>,
    configured: &HashMap<String, String>,
) -> HashMap<String, String> {
    saved
        .iter()
        .chain(configured)
        .filter(|(_, link)| is_valid_link(link))
        .map(|(team, link)| (team.to_lowercase(), link.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_slack_channel_links() {
        for link in [
            "https://app.slack.com/client/T0123/C0456",
            "https://elastic.slack.com/archives/C0456",
            "https://slack.com/app_redirect?channel=C0456",
            "slack://channel?team=T0123&id=C0456",
        ] {
            assert!(is_valid_link(link), "{link}");
        }
    }

    #[test]
    fn rejects_everything_else() {
        for link in [
            "",
            "slack://",
            "http://app.slack.com/client/T/C",
            "https://evil.example/slack.com",
            "https://notslack.com/archives/C1",
            "https://slack.com.evil.example/archives/C1",
            "https://slack.com@evil.example/archives/C1",
            "file:///etc/passwd",
            "javascript:alert(1)",
        ] {
            assert!(!is_valid_link(link), "{link}");
        }
    }

    #[test]
    fn settings_override_saved_channels_and_invalid_ones_are_dropped() {
        let saved = HashMap::from([
            (
                "Elastic/Ops".to_string(),
                "https://a.slack.com/archives/C1".to_string(),
            ),
            (
                "elastic/ui".to_string(),
                "https://a.slack.com/archives/C2".to_string(),
            ),
        ]);
        let configured = HashMap::from([
            (
                "elastic/ops".to_string(),
                "https://a.slack.com/archives/C9".to_string(),
            ),
            (
                "elastic/bad".to_string(),
                "https://evil.example".to_string(),
            ),
        ]);
        let merged = merged_channels(&saved, &configured);
        assert_eq!(merged["elastic/ops"], "https://a.slack.com/archives/C9");
        assert_eq!(merged["elastic/ui"], "https://a.slack.com/archives/C2");
        assert!(!merged.contains_key("elastic/bad"));
    }
}
