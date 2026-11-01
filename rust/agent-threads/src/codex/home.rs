//! The app's own CODEX_HOME: where Codex keeps the app's sessions (which thread/resume needs), with
//! none of the user's config, MCP servers, skills or history, but with their login linked in.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The user's own CODEX_HOME.
pub(crate) fn user_codex_home() -> PathBuf {
    match std::env::var("CODEX_HOME") {
        Ok(h) if !h.is_empty() => PathBuf::from(h),
        _ => home_dir().join(".codex"),
    }
}

/// The app's CODEX_HOME when it doesn't name one.
pub(crate) fn default_codex_home() -> PathBuf {
    home_dir().join(".agent-threads").join("codex")
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// Makes the app's CODEX_HOME, with the login (auth.json) from `login` linked in if it has none of
/// its own (or copied, where links can't be made). A link keeps it the user's login: when Codex
/// refreshes its tokens, the user's own Codex sees them.
pub(crate) fn prepare_codex_home(home: &Path, login: Option<&Path>) -> io::Result<PathBuf> {
    let dir = std::path::absolute(home)?;
    fs::create_dir_all(&dir)?;
    let Some(login) = login else { return Ok(dir) };
    let from = std::path::absolute(login)?.join("auth.json");
    let to = dir.join("auth.json");
    if from == to || !from.exists() {
        return Ok(dir);
    }
    // A link whose login has gone is made again; a login of the app's own is left alone.
    if let Ok(meta) = fs::symlink_metadata(&to) {
        if to.exists() || !meta.file_type().is_symlink() {
            return Ok(dir);
        }
        fs::remove_file(&to)?;
    }
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&from, &to);
    #[cfg(not(unix))]
    let linked: io::Result<()> = Err(io::Error::other("no links"));
    if linked.is_err() {
        fs::copy(&from, &to)?;
    }
    Ok(dir)
}

/// Codex's token totals for a session.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Totals {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub cached_input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_input_tokens: Option<u64>,
}

/// What the driver keeps about a Codex session, next to Codex's own record of it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionState {
    /// The dynamic tools the session was started with, which Codex keeps for it.
    pub dynamic_tools: Vec<Value>,
    /// Codex's token totals for the session after its last turn.
    pub totals: Option<Totals>,
}

fn state_path(home: &Path, session: &str) -> PathBuf {
    let mut name = String::new();
    for b in session.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            name.push(b as char);
        } else {
            name.push_str(&format!("%{b:02X}"));
        }
    }
    home.join("agent-threads").join("sessions").join(format!("{name}.json"))
}

/// The session's state, or none (it was started elsewhere, or by an older driver).
pub(crate) fn read_session_state(home: &Path, session: &str) -> Option<SessionState> {
    let text = fs::read_to_string(state_path(home, session)).ok()?;
    serde_json::from_str(&text).ok()
}

pub(crate) fn write_session_state(home: &Path, session: &str, state: &SessionState) -> io::Result<()> {
    let path = state_path(home, session);
    fs::create_dir_all(path.parent().unwrap())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec(state)?)?;
    fs::rename(tmp, path)
}
