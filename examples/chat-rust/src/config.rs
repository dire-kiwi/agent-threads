//! What the server runs with, from its environment (see the README), as chat-node's
//! server/config.ts has it:
//!
//!   PORT                 the port, 3001 by default (on 127.0.0.1)
//!   CHAT_DATA            where threads, runs and the agents' workspace go; ./data by default
//!   CHAT_HARNESSES       the harnesses to offer, `claude,codex` by default
//!   CHAT_CLAUDE_MODEL    the default model for new threads on Claude Code (haiku)
//!   CHAT_CODEX_MODEL     and on Codex (gpt-5.6-luna, with effort CHAT_CODEX_EFFORT, low)
//!   CHAT_SHIM            run the harnesses under agent-threads-shim, so they outlive the server:
//!                        `1` for the one `make shim` builds, or the binary's path
//!   CHAT_FAKE_CLAUDE     replay a recorded session (a spec/fixtures directory) with the fake CLI
//!   CHAT_FAKE_CODEX      in place of the real one: for the tests, with no login needed
//!   CHAT_FAKE_STATE      where the fake CLIs keep their state, kept across restarts
//!   CHAT_WEB             the built frontend, ../chat-node/web/dist by default

use std::path::{Path, PathBuf};

use serde_json::Value;

/// examples/chat-rust.
pub fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The repository.
pub fn repo() -> PathBuf {
    root().join("../..")
}

#[derive(Clone, Debug)]
pub struct HarnessInfo {
    pub name: String,
    pub label: String,
    /// The default model for new threads.
    pub model: String,
    /// Models to suggest.
    pub models: Vec<String>,
    /// The default effort, if the harness takes one.
    pub effort: Option<String>,
    /// The fixture to replay instead of running the real CLI.
    pub fake: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub data: PathBuf,
    pub web: PathBuf,
    pub harnesses: Vec<HarnessInfo>,
    /// The agent-threads-shim binary, when runs should outlive the server.
    pub shim: Option<PathBuf>,
    /// Replaying fixtures: no MCP server or skill, as they were recorded without them, and the
    /// app's tool only if they were recorded with it (the fake CLI checks what the backend says it
    /// has).
    pub fake: Option<bool>,
    /// Where the fake CLIs keep their state across restarts.
    pub fake_state: Option<PathBuf>,
    /// Started by `chat-rust supervise`, which starts it again when it exits for a restart.
    pub supervised: bool,
}

/// Vite's dev server's port, whose pages may use the server too.
pub const DEV_PORT: u16 = 5173;

/// The exit code that asks `chat-rust supervise` to start the server again.
pub const RESTART_CODE: i32 = 75;

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn absolute(p: impl AsRef<Path>) -> PathBuf {
    std::path::absolute(p.as_ref()).unwrap_or_else(|_| p.as_ref().to_path_buf())
}

pub fn config() -> Result<Config, String> {
    let fakes = [("claude", var("CHAT_FAKE_CLAUDE")), ("codex", var("CHAT_FAKE_CODEX"))];
    let fake = fakes.iter().any(|(_, f)| f.is_some());
    let wanted: Vec<String> = if fake {
        fakes
            .iter()
            .filter(|(_, f)| f.is_some())
            .map(|(n, _)| n.to_string())
            .collect()
    } else {
        var("CHAT_HARNESSES")
            .unwrap_or("claude,codex".into())
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    };
    let mut fake_tools = true;
    let mut harnesses = Vec::new();
    for name in wanted {
        let mut h = match name.as_str() {
            "claude" => HarnessInfo {
                name,
                label: "Claude Code".into(),
                model: var("CHAT_CLAUDE_MODEL").unwrap_or("haiku".into()),
                models: vec!["haiku".into(), "sonnet".into(), "opus".into()],
                effort: None,
                fake: None,
            },
            "codex" => HarnessInfo {
                name,
                label: "Codex".into(),
                model: var("CHAT_CODEX_MODEL").unwrap_or("gpt-5.6-luna".into()),
                models: vec!["gpt-5.6-luna".into(), "gpt-5.6".into()],
                effort: Some(var("CHAT_CODEX_EFFORT").unwrap_or("low".into())),
                fake: None,
            },
            other => {
                return Err(format!(
                    "CHAT_HARNESSES: there's no harness {other} (there's claude and codex)"
                ));
            }
        };
        if let Some(dir) = fakes.iter().find(|(n, _)| *n == h.name).and_then(|(_, f)| f.clone()) {
            // The model and effort the session was recorded with, which the fake CLI checks.
            let dir = absolute(dir);
            let text =
                std::fs::read_to_string(dir.join("fixture.json")).map_err(|e| format!("{}: {e}", dir.display()))?;
            let fixture: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            if !fixture["tools"]
                .as_array()
                .is_some_and(|t| t.iter().any(|t| t["name"] == "lookup_order"))
            {
                fake_tools = false;
            }
            h.model = fixture["thread"]["model"].as_str().unwrap_or("").into();
            h.models = vec![h.model.clone()];
            h.effort = fixture["thread"]["effort"].as_str().map(String::from);
            h.fake = Some(dir);
        }
        harnesses.push(h);
    }
    let shim = match var("CHAT_SHIM").filter(|s| s != "0") {
        None => None,
        Some(s) => {
            let path = if s == "1" {
                repo().join("shim/target/debug/agent-threads-shim")
            } else {
                absolute(s)
            };
            if !path.exists() {
                return Err(format!(
                    "CHAT_SHIM: there's no {} (run make shim in the repository first)",
                    path.display()
                ));
            }
            Some(path)
        }
    };
    Ok(Config {
        port: var("PORT")
            .map(|p| p.parse().map_err(|_| format!("PORT: {p} isn't a port")))
            .transpose()?
            .unwrap_or(3001),
        data: absolute(
            var("CHAT_DATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| root().join("data")),
        ),
        web: absolute(
            var("CHAT_WEB")
                .map(PathBuf::from)
                .unwrap_or_else(|| root().join("../chat-node/web/dist")),
        ),
        harnesses,
        shim,
        fake: fake.then_some(fake_tools),
        fake_state: var("CHAT_FAKE_STATE").map(absolute),
        supervised: var("CHAT_SUPERVISED").as_deref() == Some("1"),
    })
}
