//! Smoke tests against the real `claude` and `codex`, which need them installed and logged in, and
//! cost a cent or so: `AGENT_THREADS_LIVE=1 cargo test --test live`. CLAUDE_BIN and CODEX_BIN name
//! other binaries, CODEX_MODEL another model. Without AGENT_THREADS_LIVE they pass without doing
//! anything.

mod common;

use std::sync::{Arc, Mutex};

use agent_threads::{
    AgentThreads, AppTools, Capabilities, ClaudeCodeOptions, CodexOptions, CreateOptions, Options, PermissionPolicy,
    ProcessEvent, SendOptions, Skill, SpawnOptions, Spawned, Spawner, ThreadEvent, claude_code, codex, direct, tool,
};
use serde_json::{Value, json};

fn live() -> bool {
    let on = std::env::var("AGENT_THREADS_LIVE").is_ok_and(|v| !v.is_empty());
    if !on {
        eprintln!("skipped: set AGENT_THREADS_LIVE=1 to run it against the real CLI");
    }
    on
}

fn lookup_order() -> Arc<dyn agent_threads::Tool> {
    let schema = json!({"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]});
    tool("lookup_order", "Looks up an order by its id.", schema, |args, _| {
        let id = args["order_id"].as_str().unwrap_or("").to_string();
        async move { format!("Order {id}: 3 blue widgets.") }
    })
}

/// The direct spawner, keeping a copy of what processes write to stdout.
struct Tee {
    inner: Arc<dyn Spawner>,
    out: Arc<Mutex<Vec<String>>>,
}

impl Spawner for Tee {
    fn name(&self) -> &str {
        "direct"
    }
    fn spawn(&self, options: SpawnOptions) -> std::io::Result<Spawned> {
        let (proc, mut rx) = self.inner.spawn(options)?;
        let (tx, out_rx) = tokio::sync::mpsc::unbounded_channel();
        let out = self.out.clone();
        tokio::spawn(async move {
            while let Some(e) = rx.recv().await {
                if let ProcessEvent::Line { line, .. } = &e {
                    out.lock().unwrap().push(line.clone());
                }
                if tx.send(e).is_err() {
                    return;
                }
            }
        });
        Ok((proc, out_rx))
    }
}

/// Sends a message and waits for its turn to end; the snapshot after, as JSON.
async fn turn(sdk: &AgentThreads, id: &str, text: &str) -> Value {
    let mut rx = sdk.subscribe();
    sdk.send(id, text, SendOptions::default()).await.unwrap();
    let wait = async {
        while let Ok(e) = rx.recv().await {
            if matches!(e, ThreadEvent::TurnCompleted(_)) {
                return;
            }
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(180), wait)
        .await
        .expect("the turn ends");
    serde_json::to_value(sdk.snapshot(id).await.unwrap()).unwrap()
}

fn said(s: &Value) -> String {
    common::texts(s).join("")
}

fn app_call(s: &Value) -> Value {
    common::items(s, "tool_call")
        .into_iter()
        .find(|i| i["kind"] == "app")
        .cloned()
        .unwrap_or(Value::Null)
}

#[tokio::test(flavor = "multi_thread")]
async fn live_claude_replies_calls_an_app_tool_and_has_the_apps_skills() {
    if !live() {
        return;
    }
    // Claude's output, to see what its initialize response lists.
    let out: Arc<Mutex<Vec<String>>> = Arc::default();
    let sdk = AgentThreads::new(Options {
        spawner: Some(Arc::new(Tee {
            inner: direct(),
            out: out.clone(),
        })),
        harnesses: vec![claude_code(ClaudeCodeOptions {
            bin: std::env::var("CLAUDE_BIN").unwrap_or("claude".into()),
            ..Default::default()
        })],
        capabilities: Capabilities {
            tools: vec![lookup_order()],
            skills: vec![Skill::Inline {
                name: "review-sentinel".into(),
                content: "---\nname: review-sentinel\ndescription: Says sentinel.\n---\nSay sentinel.\n".into(),
            }],
            permissions: Some(PermissionPolicy::allow()),
            ..Default::default()
        },
        ..Default::default()
    });
    let t = sdk
        .create(CreateOptions {
            model: Some("haiku".into()),
            cwd: Some(common::temp_dir()),
            ..Default::default()
        })
        .await
        .unwrap();
    let s = turn(
        &sdk,
        &t.id,
        "Reply with exactly these words and nothing else: hello from agent-threads",
    )
    .await;
    // The app's skill is there, though the user's and the project's config aren't loaded.
    let init = out
        .lock()
        .unwrap()
        .iter()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find(|m| m["type"] == "control_response" && m["response"]["response"]["commands"].is_array())
        .expect("Claude answered initialize with its commands");
    let commands: Vec<&str> = init["response"]["response"]["commands"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|c| c["name"].as_str())
        .collect();
    assert!(commands.contains(&"app:review-sentinel"), "{commands:?}");
    assert_eq!(s["thread"]["status"], "idle");
    assert!(s["thread"]["session_id"].is_string());
    assert!(
        said(&s).to_lowercase().contains("hello from agent-threads"),
        "{}",
        said(&s)
    );

    let s = turn(
        &sdk,
        &t.id,
        "Look up order 42 with the lookup_order tool, then tell me in a few words what's in it.",
    )
    .await;
    assert_eq!(s["thread"]["status"], "idle");
    let call = app_call(&s);
    assert_eq!(
        (
            call["name"].clone(),
            call["status"].clone(),
            call["result"]["content"].clone()
        ),
        (
            json!("lookup_order"),
            json!("completed"),
            json!("Order 42: 3 blue widgets.")
        )
    );
    assert!(s["thread"]["usage"]["cost_usd"].as_f64().unwrap() > 0.0);
    sdk.close(false).await.unwrap();
}

async fn live_codex(app_tools: AppTools) {
    if !live() {
        return;
    }
    let o = CodexOptions {
        bin: std::env::var("CODEX_BIN").unwrap_or("codex".into()),
        home: Some(common::temp_dir()),
        app_tools,
        ..Default::default()
    };
    let sdk = AgentThreads::new(Options {
        harnesses: vec![codex(o)],
        capabilities: Capabilities {
            tools: vec![lookup_order()],
            permissions: Some(PermissionPolicy::allow()),
            ..Default::default()
        },
        ..Default::default()
    });
    let model = std::env::var("CODEX_MODEL").unwrap_or("gpt-5.6-luna".into());
    let o = CreateOptions {
        harness: Some("codex".into()),
        model: Some(model),
        effort: Some("low".into()),
        cwd: Some(common::temp_dir()),
        ..Default::default()
    };
    let t = sdk.create(o).await.unwrap();
    let s = turn(
        &sdk,
        &t.id,
        "Reply with exactly these words and nothing else: hello from agent-threads",
    )
    .await;
    assert_eq!(s["thread"]["status"], "idle", "{}", s["thread"]);
    assert!(s["thread"]["session_id"].is_string());
    assert!(
        said(&s).to_lowercase().contains("hello from agent-threads"),
        "{}",
        said(&s)
    );

    let s = turn(
        &sdk,
        &t.id,
        "Look up order 42 with the lookup_order tool, then tell me in a few words what's in it.",
    )
    .await;
    assert_eq!(s["thread"]["status"], "idle");
    let call = app_call(&s);
    assert_eq!(
        (call["name"].clone(), call["status"].clone()),
        (json!("lookup_order"), json!("completed")),
        "{call}"
    );
    assert!(
        call["result"]["content"]
            .as_str()
            .unwrap()
            .contains("Order 42: 3 blue widgets.")
    );
    assert!(s["thread"]["usage"]["output_tokens"].as_u64().unwrap() > 0);
    sdk.close(false).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn live_codex_replies_and_calls_an_app_tool_given_as_a_dynamic_tool() {
    live_codex(AppTools::Dynamic).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn live_codex_replies_and_calls_an_app_tool_on_the_loopback_mcp_server() {
    live_codex(AppTools::Mcp).await;
}
