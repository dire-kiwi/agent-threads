//! Claude Code's tools, results and usage in the protocol's terms (spec/fixtures/README.md, "Claude
//! Code").

use serde_json::{Map, Value, json};

use crate::thread::round_cost;

/// The in-process MCP server that serves a thread's app tools.
pub(crate) const APP_SERVER: &str = "app";

/// Tool results longer than this (in UTF-16 code units, as the Node backend counts) are cut short,
/// as Huntaway does.
pub(crate) const MAX_RESULT: usize = 30_000;

fn kind_of(name: &str) -> &'static str {
    match name {
        "Bash" | "BashOutput" => "shell",
        "Read" | "NotebookRead" => "read",
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => "edit",
        "Glob" | "Grep" => "search",
        "WebFetch" | "WebSearch" => "web",
        "Task" | "Agent" => "subagent",
        "TodoWrite" => "todo",
        _ => "other",
    }
}

/// A tool_call's fields (all but id, status and the item's own), as a JSON object.
pub(crate) type ToolFields = Map<String, Value>;

fn str_arg<'a>(args: &'a Value, name: &str) -> Option<&'a str> {
    args.get(name).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// A tool_call's fields for a Claude tool_use.
pub(crate) fn claude_tool(name: &str, input: &Value) -> ToolFields {
    let input = if input.is_null() { json!({}) } else { input.clone() };
    let mut t = Map::new();
    let mut tool_name = name.to_string();
    let mut kind = if name.starts_with("mcp__") {
        "mcp"
    } else {
        kind_of(name)
    };
    let mut server = None;
    if let Some(rest) = name.strip_prefix("mcp__") {
        let mut parts = rest.splitn(2, "__");
        let s = parts.next().unwrap_or("");
        tool_name = parts.next().unwrap_or("").to_string();
        if s == APP_SERVER {
            kind = "app";
        } else if !s.is_empty() {
            server = Some(s.to_string());
        }
    }
    t.insert("name".into(), json!(tool_name));
    t.insert("kind".into(), json!(kind));
    t.insert("input".into(), input.clone());
    if let Some(s) = server {
        t.insert("server".into(), json!(s));
    }
    let args = &input;
    match kind {
        "shell" => {
            if let Some(c) = args.get("command").and_then(Value::as_str) {
                t.insert("command".into(), json!(c));
            }
        }
        "read" => {
            if let Some(p) = str_arg(args, "file_path") {
                t.insert("path".into(), json!(p));
            }
        }
        "search" => {
            if let Some(q) = str_arg(args, "pattern") {
                t.insert("query".into(), json!(q));
            }
            if let Some(p) = str_arg(args, "path") {
                t.insert("path".into(), json!(p));
            }
        }
        "web" => {
            if let Some(u) = str_arg(args, "url") {
                t.insert("url".into(), json!(u));
            }
            if let Some(q) = str_arg(args, "query") {
                t.insert("query".into(), json!(q));
            }
        }
        "edit" => {
            if let Some(p) = str_arg(args, "file_path") {
                t.insert("changes".into(), json!([{"path": p, "op": "update"}]));
            }
        }
        "subagent" => {
            if let Some(d) = str_arg(args, "description") {
                t.insert("title".into(), json!(d));
            }
        }
        "todo" => {
            if let Some(todos) = args.get("todos").and_then(Value::as_array) {
                let todos: Vec<Value> = todos
                    .iter()
                    .map(|x| {
                        let text = match x.get("content") {
                            Some(Value::String(s)) => s.clone(),
                            None | Some(Value::Null) => String::new(),
                            Some(v) => v.to_string(),
                        };
                        let status = x
                            .get("status")
                            .and_then(Value::as_str)
                            .filter(|s| matches!(*s, "in_progress" | "completed"))
                            .unwrap_or("pending");
                        json!({"text": text, "status": status})
                    })
                    .collect();
                t.insert("todos".into(), Value::Array(todos));
            }
        }
        _ => {}
    }
    t
}

/// A permission's title: what it's about, in a few words.
pub(crate) fn title(t: &ToolFields) -> String {
    if let Some(c) = t.get("command").and_then(Value::as_str).filter(|c| !c.is_empty()) {
        return c.into();
    }
    if let Some(p) = t.get("path").and_then(Value::as_str).filter(|c| !c.is_empty()) {
        return p.into();
    }
    if let Some(changes) = t.get("changes").and_then(Value::as_array).filter(|c| !c.is_empty()) {
        return changes
            .iter()
            .filter_map(|c| c["path"].as_str())
            .collect::<Vec<_>>()
            .join(", ");
    }
    t.get("name").and_then(Value::as_str).unwrap_or("").into()
}

/// A tool result's content as text: text blocks joined by newlines, images as [image].
pub(crate) fn result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| match b.get("type").and_then(Value::as_str) {
                Some("text") => Some(b.get("text").and_then(Value::as_str).unwrap_or("").to_string()),
                Some("image") => Some("[image]".into()),
                Some("tool_reference") => b.get("tool_name").and_then(Value::as_str).map(String::from),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// A result's content, cut short if it's long: `{content, truncated?}`.
pub(crate) fn slim(text: &str) -> Map<String, Value> {
    let mut out = Map::new();
    if crate::reducer::utf16_len(text) > MAX_RESULT {
        let mut units = 0;
        let cut: String = text
            .chars()
            .take_while(|c| {
                units += c.len_utf16();
                units <= MAX_RESULT
            })
            .collect();
        out.insert("content".into(), json!(cut));
        out.insert("truncated".into(), json!(true));
    } else {
        out.insert("content".into(), json!(text));
    }
    out
}

/// A structuredPatch as a unified diff's hunks.
fn hunks(patch: &[Value]) -> String {
    patch
        .iter()
        .map(|h| {
            let n = |k: &str| h.get(k).map(|v| v.to_string()).unwrap_or_default();
            let lines: Vec<&str> = h
                .get("lines")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            format!(
                "@@ -{},{} +{},{} @@\n{}\n",
                n("oldStart"),
                n("oldLines"),
                n("newStart"),
                n("newLines"),
                lines.join("\n")
            )
        })
        .collect()
}

/// An Edit/Write result's file change, from its tool_use_result.
pub(crate) fn edit_change(result: &Value, path: Option<&str>) -> Option<Value> {
    let patch = result.get("structuredPatch")?.as_array()?;
    let p = result.get("filePath").and_then(Value::as_str).or(path)?;
    let create = result.get("type").and_then(Value::as_str) == Some("create");
    let diff = if create {
        match result.get("content") {
            Some(Value::String(s)) => s.clone(),
            None | Some(Value::Null) => String::new(),
            Some(v) => v.to_string(),
        }
    } else {
        hunks(patch)
    };
    Some(json!({"path": p, "op": if create { "add" } else { "update" }, "diff": diff}))
}

/// What a turn used: its result's model_usage_since_last_result, summed over the models. (Its
/// `usage` is only the last model call's, and total_cost_usd is the session's so far.)
pub(crate) fn claude_usage(result: &Value) -> Value {
    let (mut input, mut output, mut read, mut write, mut cost) = (0u64, 0u64, 0u64, 0u64, 0f64);
    for m in result
        .get("model_usage_since_last_result")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|o| o.values())
    {
        let n = |k: &str| m.get(k).and_then(Value::as_f64).unwrap_or(0.0) as u64;
        input += n("inputTokens");
        output += n("outputTokens");
        read += n("cacheReadInputTokens");
        write += n("cacheCreationInputTokens");
        cost = round_cost(cost + m.get("costUSD").and_then(Value::as_f64).unwrap_or(0.0));
    }
    json!({"input_tokens": input, "output_tokens": output, "cache_read_tokens": read, "cache_write_tokens": write, "cost_usd": cost})
}

/// AskUserQuestion's questions; each one's id is its text, and "Other" is always offered.
pub(crate) fn questions(input: &Value) -> Vec<Value> {
    input
        .get("questions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|q| {
            let text = q.get("question").and_then(Value::as_str).unwrap_or("");
            let mut out = json!({"id": text, "question": text});
            if let Some(h) = q.get("header").and_then(Value::as_str).filter(|h| !h.is_empty()) {
                out["header"] = json!(h);
            }
            let options: Vec<Value> = q
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|o| {
                    let mut x = json!({"label": o.get("label").and_then(Value::as_str).unwrap_or("")});
                    if let Some(d) = o.get("description").and_then(Value::as_str).filter(|d| !d.is_empty()) {
                        x["description"] = json!(d);
                    }
                    x
                })
                .collect();
            out["options"] = Value::Array(options);
            if q.get("multiSelect").and_then(Value::as_bool).unwrap_or(false) {
                out["multi_select"] = json!(true);
            }
            out["allow_other"] = json!(true);
            out
        })
        .collect()
}

/// The permission mode as Claude Code names it, or nothing for the default.
pub(crate) fn claude_permission_mode(mode: Option<crate::protocol::PermissionMode>) -> Option<&'static str> {
    use crate::protocol::PermissionMode::*;
    match mode? {
        AcceptEdits => Some("acceptEdits"),
        Plan => Some("plan"),
        Bypass => Some("bypassPermissions"),
        // dont_ask: Claude asks, and agent-threads denies what it asks about (so the policy still
        // allows what it allows).
        Default | DontAsk => None,
    }
}
