use serde::{Deserialize, Serialize};

/// Where the GitHub token comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TokenSource {
    Pat,
    Gh,
}
