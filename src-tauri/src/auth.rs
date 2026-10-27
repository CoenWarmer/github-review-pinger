//! Token resolution. The user picks the source: a PAT they pasted (kept in the
//! OS keychain) or the `gh` CLI token. Until they pick, a saved PAT wins over
//! the CLI, because pasting one is an explicit override, typically for orgs the
//! gh token isn't SSO-authorized for. A chosen source never falls back to the
//! other, so a problem with it is reported rather than hidden.

use std::env;
use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};

const KEYRING_SERVICE: &str = "dev.coenwarmer.reviewpinger";
const KEYRING_USER: &str = "github-token";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TokenSource {
    Pat,
    Gh,
}

pub struct Token {
    pub value: String,
    pub source: TokenSource,
}

#[derive(Debug)]
pub enum AuthError {
    GhNotInstalled,
    GhNotLoggedIn,
    /// The saved token was chosen, but none is saved.
    NoSavedToken,
}

pub fn resolve_token(chosen: Option<TokenSource>) -> Result<Token, AuthError> {
    match chosen {
        Some(TokenSource::Gh) => return gh_token(),
        Some(TokenSource::Pat) => {
            return match stored_pat() {
                Ok(Some(value)) => Ok(Token {
                    value,
                    source: TokenSource::Pat,
                }),
                Ok(None) => Err(AuthError::NoSavedToken),
                Err(e) => {
                    log::warn!("Could not read token from keychain: {e}");
                    Err(AuthError::NoSavedToken)
                }
            };
        }
        None => {}
    }
    match stored_pat() {
        Ok(Some(value)) => {
            return Ok(Token {
                value,
                source: TokenSource::Pat,
            });
        }
        Ok(None) => {}
        Err(e) => log::warn!("Could not read token from keychain: {e}"),
    }
    gh_token()
}

fn keyring_entry() -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
}

fn stored_pat() -> keyring::Result<Option<String>> {
    match keyring_entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Whether a token is in the keychain, whichever source is chosen.
pub fn has_saved_pat() -> bool {
    matches!(stored_pat(), Ok(Some(_)))
}

pub fn save_pat(token: &str) -> keyring::Result<()> {
    keyring_entry()?.set_password(token)
}

pub fn clear_pat() -> keyring::Result<()> {
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e),
    }
}

fn gh_token() -> Result<Token, AuthError> {
    let gh = find_gh().ok_or(AuthError::GhNotInstalled)?;
    let mut command = Command::new(gh);
    command.args(["auth", "token", "--hostname", "github.com"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command.output().map_err(|_| AuthError::GhNotInstalled)?;
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || value.is_empty() {
        return Err(AuthError::GhNotLoggedIn);
    }
    Ok(Token {
        value,
        source: TokenSource::Gh,
    })
}

/// Apps launched from Finder or as a login item don't inherit the shell's
/// PATH, so common install locations are checked explicitly.
fn find_gh() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "gh.exe" } else { "gh" };
    let fallbacks: &[&str] = if cfg!(windows) {
        &[r"C:\Program Files\GitHub CLI"]
    } else {
        &[
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/home/linuxbrew/.linuxbrew/bin",
            "/usr/bin",
            "/snap/bin",
        ]
    };

    env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .chain(fallbacks.iter().map(PathBuf::from))
        .map(|dir| dir.join(exe))
        .find(|candidate| candidate.is_file())
}
