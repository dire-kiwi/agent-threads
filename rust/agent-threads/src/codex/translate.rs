//! Codex's items, plans, questions and usage in the protocol's terms (spec/fixtures/README.md,
//! "Codex").

use serde_json::{Map, Value, json};

use super::home::Totals;
use crate::claude::{result_text, slim};
use crate::harness::McpServer;
use crate::ids::unix_time;
use crate::protocol::{PermissionMode, RateLimit, RateLimitStatus};

/// The MCP server that serves a thread's app tools when Codex can't take them as dynamic tools.
pub(crate) const APP_SERVER: &str = "app";

pub(crate) fn is_tool_item(item: &Value) -> bool {
    matches!(
        item["type"].as_str(),
        Some("commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall" | "webSearch" | "imageView")
    )
}

/// Codex wraps commands in a login shell: `/usr/bin/bash -lc 'cmd'` is shown as cmd.
pub(crate) fn unwrap_command(command: &str) -> String {
    let mut rest = command;
    // An optional directory, then bash, zsh or sh.
    let word_end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let program = &rest[..word_end];
    let base = program.rsplit('/').next().unwrap_or(program);
    if !matches!(base, "bash" | "zsh" | "sh") || program.contains(char::is_whitespace) {
        return command.to_string();
    }
    rest = &rest[word_end..];
    let Some(r) = rest.strip_prefix(" -lc ") else {
        return command.to_string();
    };
    if let Some(inner) = r.strip_prefix('\'').and_then(|r| r.strip_suffix('\'')) {
        // '...' with '\'' for each quote inside.
        let mut ok = true;
        let mut chars = inner.char_indices().peekable();
        while let Some((i, c)) = chars.next() {
            if c == '\'' {
                if inner[i..].starts_with("'\\''") {
                    for _ in 0..3 {
                        chars.next();
                    }
                } else {
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            return inner.replace("'\\''", "'");
        }
        return command.to_string();
    }
    if let Some(inner) = r.strip_prefix('"').and_then(|r| r.strip_suffix('"')) {
        let mut out = String::new();
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            match c {
                '\\' => match chars.next() {
                    Some(n) => out.push(n),
                    None => return command.to_string(),
                },
                '"' => return command.to_string(),
                c => out.push(c),
            }
        }
        return out;
    }
    command.to_string()
}

fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(o) => o,
        _ => Map::new(),
    }
}

/// A tool item's tool_call fields (all but id, status and the item's own). `mcp_app`: app tools
/// are on the app MCP server.
pub(crate) fn codex_tool(item: &Value, mcp_app: bool) -> Map<String, Value> {
    let args = || {
        if item["arguments"].is_null() {
            json!({})
        } else {
            item["arguments"].clone()
        }
    };
    obj(match item["type"].as_str().unwrap_or("") {
        "commandExecution" => {
            let command = item["command"].as_str().unwrap_or("");
            json!({"name": "commandExecution", "kind": "shell", "input": {"command": item["command"], "cwd": item["cwd"]}, "command": unwrap_command(command)})
        }
        "fileChange" => {
            json!({"name": "fileChange", "kind": "edit", "input": {"changes": item["changes"]}, "changes": file_changes(&item["changes"])})
        }
        "mcpToolCall" => {
            if mcp_app && item["server"] == APP_SERVER {
                json!({"name": item["tool"], "kind": "app", "input": args()})
            } else {
                json!({"name": item["tool"], "kind": "mcp", "input": args(), "server": item["server"]})
            }
        }
        "dynamicToolCall" => json!({"name": item["tool"], "kind": "app", "input": args()}),
        "webSearch" => {
            let mut input = json!({"query": item["query"]});
            if !item["action"].is_null() {
                input["action"] = item["action"].clone();
            }
            let mut t = json!({"name": "webSearch", "kind": "web", "input": input});
            for (k, v) in web_fields(item) {
                t[k] = v;
            }
            t
        }
        "imageView" => {
            json!({"name": "imageView", "kind": "read", "input": {"path": item["path"]}, "path": item["path"]})
        }
        _ => json!({}),
    })
}

fn web_fields(item: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    let action = &item["action"];
    let query = item["query"]
        .as_str()
        .filter(|q| !q.is_empty())
        .or_else(|| action["query"].as_str())
        .unwrap_or("");
    if !query.is_empty() {
        out.insert("query".into(), json!(query));
    }
    if let Some(url) = action["url"].as_str().filter(|u| !u.is_empty()) {
        out.insert("url".into(), json!(url));
    }
    out
}

pub(crate) fn file_changes(changes: &Value) -> Value {
    Value::Array(
        changes
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| {
                let kind = &c["kind"];
                let op = match kind["type"].as_str() {
                    Some("add") => "add",
                    Some("delete") => "delete",
                    _ => "update",
                };
                let mut f = json!({"path": c["path"], "op": op});
                if let Some(d) = c["diff"].as_str().filter(|d| !d.is_empty()) {
                    f["diff"] = json!(d);
                }
                if let Some(m) = kind["move_path"].as_str().filter(|m| !m.is_empty()) {
                    f["move_to"] = json!(m);
                }
                f
            })
            .collect(),
    )
}

/// What a tool item's completion changes in its call (`denied`: the call was denied, and stays
/// so).
pub(crate) fn codex_done(item: &Value, denied: bool) -> Map<String, Value> {
    let status = match item["status"].as_str().unwrap_or("completed") {
        "failed" => "failed",
        "declined" => "denied",
        "inProgress" => "running",
        _ => "completed",
    };
    let mut patch = Map::new();
    patch.insert("status".into(), json!(if denied { "denied" } else { status }));
    match item["type"].as_str().unwrap_or("") {
        "commandExecution" => {
            // A command with no output has none (null), but still an exit code.
            let out = item["aggregatedOutput"].as_str();
            let code = item["exitCode"].as_i64();
            if out.is_some() || code.is_some() {
                let mut r = slim(out.unwrap_or(""));
                if let Some(c) = code {
                    r.insert("exit_code".into(), json!(c));
                }
                patch.insert("result".into(), Value::Object(r));
            }
        }
        "fileChange" => {
            patch.insert("changes".into(), file_changes(&item["changes"]));
        }
        "mcpToolCall" => {
            let result = &item["result"];
            if result.is_object() {
                let mut r = slim(&result_text(&result["content"]));
                if !result["structuredContent"].is_null() {
                    r.insert("structured".into(), result["structuredContent"].clone());
                }
                patch.insert("result".into(), Value::Object(r));
            } else if !item["error"].is_null() {
                let e = &item["error"];
                let message = e["message"].as_str().map(String::from).unwrap_or_else(|| e.to_string());
                patch.insert("result".into(), json!({"content": message}));
            }
        }
        "dynamicToolCall" => {
            let text: Vec<String> = item["contentItems"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|c| c["type"] == "inputText")
                .map(|c| match &c["text"] {
                    Value::String(s) => s.clone(),
                    v => v.to_string(),
                })
                .collect();
            patch.insert("result".into(), Value::Object(slim(&text.join("\n"))));
        }
        "webSearch" => patch.extend(web_fields(item)),
        _ => {}
    }
    patch
}

/// What a turn used. Codex reports the thread's running totals (again after a resume), so it's
/// how far they are past the thread's usage before the turn. Its input tokens include the cached
/// ones, which (as Claude's do) `input_tokens` leaves out.
pub(crate) fn codex_usage(total: &Totals, before: &Value) -> Value {
    let b = |k: &str| before[k].as_i64().unwrap_or(0);
    let cached = total.cached_input_tokens as i64 - b("cache_read_tokens");
    let input = total.input_tokens as i64 - b("input_tokens") - b("cache_read_tokens");
    let pos = |n: i64| n.max(0);
    json!({
        "input_tokens": pos(input - cached),
        "output_tokens": pos(total.output_tokens as i64 - b("output_tokens")),
        "cache_read_tokens": pos(cached),
        "cache_write_tokens": pos(total.cache_write_input_tokens.unwrap_or(0) as i64 - b("cache_write_tokens")),
    })
}

/// Codex's totals as the usage they'd be if a turn had used them all.
pub(crate) fn totals_as_usage(t: &Totals) -> Value {
    json!({
        "input_tokens": t.input_tokens as i64 - t.cached_input_tokens as i64,
        "cache_read_tokens": t.cached_input_tokens,
        "output_tokens": t.output_tokens,
        "cache_write_tokens": t.cache_write_input_tokens.unwrap_or(0),
    })
}

/// requestUserInput's questions.
pub(crate) fn questions(qs: &Value) -> Vec<Value> {
    qs.as_array()
        .into_iter()
        .flatten()
        .map(|q| {
            let mut out = json!({"id": q["id"], "question": q["question"]});
            if let Some(h) = q["header"].as_str().filter(|h| !h.is_empty()) {
                out["header"] = json!(h);
            }
            if let Some(options) = q["options"].as_array() {
                out["options"] = Value::Array(
                    options
                        .iter()
                        .map(|o| {
                            let mut x = json!({"label": o["label"]});
                            if let Some(d) = o["description"].as_str().filter(|d| !d.is_empty()) {
                                x["description"] = json!(d);
                            }
                            x
                        })
                        .collect(),
                );
            }
            if q["isOther"].as_bool().unwrap_or(false) {
                out["allow_other"] = json!(true);
            }
            if q["isSecret"].as_bool().unwrap_or(false) {
                out["secret"] = json!(true);
            }
            out
        })
        .collect()
}

pub(crate) fn todos(plan: &Value) -> Value {
    Value::Array(
        plan.as_array()
            .into_iter()
            .flatten()
            .map(|s| {
                let status = match s["status"].as_str() {
                    Some("inProgress") => "in_progress",
                    Some("completed") => "completed",
                    _ => "pending",
                };
                json!({"text": s["step"], "status": status})
            })
            .collect(),
    )
}

/// How a permission mode runs under Codex: its approval policy and sandbox.
pub(crate) fn codex_policy(mode: Option<PermissionMode>) -> (&'static str, &'static str) {
    match mode {
        Some(PermissionMode::AcceptEdits) => ("on-request", "workspace-write"),
        Some(PermissionMode::Plan) => ("untrusted", "read-only"),
        Some(PermissionMode::Bypass) => ("never", "danger-full-access"),
        _ => ("untrusted", "workspace-write"),
    }
}

/// A sandbox mode as turn/start's sandboxPolicy has it. A workspace-write one keeps its settings
/// (Codex takes those left out as false): the ones Codex last said the thread had (`workspace`), or
/// else those of the config's `sandbox_workspace_write` (a table, or dotted keys).
pub(crate) fn sandbox_policy(mode: &str, workspace: Option<&Value>, config: &Map<String, Value>) -> Value {
    match mode {
        "read-only" => return json!({"type": "readOnly"}),
        "danger-full-access" => return json!({"type": "dangerFullAccess"}),
        _ => {}
    }
    if let Some(w) = workspace {
        return w.clone();
    }
    let setting = |key: &str| match config.get("sandbox_workspace_write") {
        Some(Value::Object(table)) => table.get(key).cloned(),
        _ => config.get(&format!("sandbox_workspace_write.{key}")).cloned(),
    };
    let mut p = json!({"type": "workspaceWrite"});
    if let Some(roots @ Value::Array(_)) = setting("writable_roots") {
        p["writableRoots"] = roots;
    }
    for (key, field) in [
        ("network_access", "networkAccess"),
        ("exclude_tmpdir_env_var", "excludeTmpdirEnvVar"),
        ("exclude_slash_tmp", "excludeSlashTmp"),
    ] {
        if let Some(v @ Value::Bool(_)) = setting(key) {
            p[field] = v;
        }
    }
    p
}

/// An MCP server as Codex's `mcp_servers` config has it, or why it can't be.
pub(crate) fn mcp_server_config(s: &McpServer) -> Result<Value, &'static str> {
    match s {
        McpServer::Sse { .. } => Err("Codex doesn't support SSE MCP servers"),
        McpServer::Http { url, headers } => {
            let mut v = json!({"url": url});
            if !headers.is_empty() {
                v["http_headers"] = json!(headers);
            }
            Ok(v)
        }
        McpServer::Stdio { command, args, env } => {
            let mut v = json!({"command": command, "args": args});
            if !env.is_empty() {
                v["env"] = json!(env);
            }
            Ok(v)
        }
    }
}

/// The limits an `account/rateLimits/updated` notification's snapshot reports: its primary and
/// secondary windows, named by its limitId when that isn't Codex's own. A used-up window is
/// rejected, unless credits carry on past it.
pub(crate) fn codex_rate_limits(rl: &Value) -> Vec<RateLimit> {
    let prefix = match rl["limitId"].as_str() {
        Some(l) if !l.is_empty() && l != "codex" => format!("{l}:"),
        _ => String::new(),
    };
    let credits = rl["credits"]["hasCredits"] == true || rl["credits"]["unlimited"] == true;
    let mut out = Vec::new();
    for key in ["primary", "secondary"] {
        let w = &rl[key];
        if !w.is_object() {
            continue;
        }
        let used = w["usedPercent"].as_f64().filter(|u| u.is_finite());
        let status = match used {
            Some(u) if u >= 100.0 && credits => RateLimitStatus::Warning,
            Some(u) if u >= 100.0 => RateLimitStatus::Rejected,
            _ => RateLimitStatus::Allowed,
        };
        out.push(RateLimit {
            id: format!("{prefix}{key}"),
            status,
            used_percent: used,
            resets_at: w["resetsAt"].as_f64().and_then(unix_time),
            window_minutes: w["windowDurationMins"].as_u64(),
        });
    }
    out
}
