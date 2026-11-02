//! What the recorded fixtures don't cover for Codex, against a scriptable fake `codex app-server`
//! (the Node backend's mini-codex.mjs). As the Node backend's codex.test.ts does.

mod common;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agent_threads::protocol::{PermissionMode, ToolKind};
use agent_threads::reducer::open_requests;
use agent_threads::{
    AgentThreads, AppTools, Capabilities, CapabilitiesUpdate, CodexOptions, CreateOptions, LaunchOptions, McpServer,
    MemoryStore, Options, PermissionDecision, PermissionPolicy, SendOptions, Skill, Store, ThreadEvent, ThreadOptions,
    ToolContext, codex, tool,
};
use common::{items, mini_runs, settle, texts, until};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Env {
    sdk: AgentThreads,
    log: PathBuf,
    home: PathBuf,
    user_home: PathBuf,
    store: Arc<MemoryStore>,
    rx: tokio::sync::broadcast::Receiver<ThreadEvent>,
}

fn setup(capabilities: Capabilities, o: CodexOptions, env: &[(&str, &str)]) -> Env {
    let log = common::temp_dir().join("log.jsonl");
    let home = common::temp_dir();
    // A home of its own, so the user's own skills don't show up.
    let user_home = common::temp_dir();
    let mut e: HashMap<String, Option<String>> = HashMap::new();
    e.insert("MINI_CODEX_LOG".into(), Some(log.to_string_lossy().into()));
    e.insert("HOME".into(), Some(user_home.to_string_lossy().into()));
    for (k, v) in env {
        e.insert(k.to_string(), Some(v.to_string()));
    }
    let mut o = o;
    o.bin = common::mini("codex").to_string_lossy().into();
    o.env.extend(e);
    o.home = Some(home.clone());
    o.close_grace = std::time::Duration::from_secs(1);
    let mut capabilities = capabilities;
    if capabilities.permissions.is_none() {
        capabilities.permissions = Some(PermissionPolicy::allow());
    }
    let store = Arc::new(MemoryStore::new());
    let sdk = AgentThreads::new(Options {
        store: Some(store.clone()),
        harnesses: vec![codex(o)],
        capabilities,
        on_error: Some(Arc::new(|e| panic!("{e}"))),
        event_capacity: 1 << 16,
        ..Default::default()
    });
    let rx = sdk.subscribe();
    Env {
        sdk,
        log,
        home,
        user_home,
        store,
        rx,
    }
}

fn plain() -> CodexOptions {
    CodexOptions {
        login: None,
        ..Default::default()
    }
}

impl Env {
    /// The requests the last run (or `run`) sent, by method.
    fn sent(&self, method: &str) -> Vec<Value> {
        mini_runs(&self.log)
            .last()
            .map(|r| r.sent.iter().filter(|m| m["method"] == method).cloned().collect())
            .unwrap_or_default()
    }

    fn all_sent(&self, method: &str) -> Vec<Value> {
        mini_runs(&self.log)
            .iter()
            .flat_map(|r| r.sent.iter().filter(|m| m["method"] == method).cloned())
            .collect()
    }

    async fn request(&self, id: &str) -> Value {
        until(5, || async {
            open_requests(&self.sdk.snapshot(id).await.unwrap())
                .next()
                .map(|r| serde_json::to_value(r).unwrap())
        })
        .await
    }
}

fn create() -> CreateOptions {
    CreateOptions {
        harness: Some("codex".into()),
        cwd: Some(common::temp_dir()),
        ..Default::default()
    }
}

fn lookup_order(seen: Arc<Mutex<Vec<ToolContext>>>) -> Arc<dyn agent_threads::Tool> {
    tool(
        "lookup_order",
        "Looks up an order.",
        json!({"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]}),
        move |args, ctx| {
            seen.lock().unwrap().push(ctx);
            let id = args["order_id"].as_str().unwrap_or("").to_string();
            async move {
                agent_threads::ToolOutput::text(format!("Order {id}: 3 blue widgets."))
                    .with_structured(json!({"order_id": id}))
            }
        },
    )
}

fn calls(s: &Value) -> Vec<&Value> {
    items(s, "tool_call")
}

fn results(s: &Value) -> Vec<&Value> {
    items(s, "turn_result")
}

fn send(text: &str) -> (String, SendOptions) {
    (text.to_string(), SendOptions::default())
}

#[tokio::test(flavor = "multi_thread")]
async fn streams_replies_and_reasoning_sets_the_session_and_counts_each_turns_usage() {
    let env = setup(Capabilities::default(), plain(), &[]);
    let t = env
        .sdk
        .create(CreateOptions {
            model: Some("gpt-test".into()),
            effort: Some("low".into()),
            ..create()
        })
        .await
        .unwrap();
    let (text, o) = send("reply hello there world\nreason thinking");
    env.sdk.send(&t.id, &text, o).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(texts(&s), ["hello there world"]);
    assert_eq!(items(&s, "reasoning")[0]["text"], "thinking one\n\nthinking two");
    assert!(s["thread"]["session_id"].as_str().unwrap().starts_with("thread-"));
    // The totals grow by 100 input tokens (40 of them cached) and 10 output tokens a turn.
    let r = results(&s)[0];
    assert_eq!(
        r["usage"],
        json!({"input_tokens": 60, "cache_read_tokens": 40, "output_tokens": 10, "cache_write_tokens": 0})
    );
    assert_eq!((r["ok"].clone(), r["duration_ms"].clone()), (json!(true), json!(7)));

    env.sdk
        .send(&t.id, "reply again", SendOptions::default())
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(results(&s)[1]["usage"]["input_tokens"], 60);
    let u = &s["thread"]["usage"];
    assert_eq!(
        (
            u["input_tokens"].clone(),
            u["cache_read_tokens"].clone(),
            u["output_tokens"].clone()
        ),
        (json!(120), json!(80), json!(20))
    );
    // One process, one thread, a turn/start per message, with the thread's effort.
    assert_eq!(env.sent("thread/start").len(), 1);
    let starts: Vec<(Value, Value)> = env
        .sent("turn/start")
        .iter()
        .map(|m| (m["params"]["effort"].clone(), m["params"]["input"][0]["text"].clone()))
        .collect();
    assert_eq!(
        starts,
        [
            (json!("low"), json!("reply hello there world\nreason thinking")),
            (json!("low"), json!("reply again"))
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn starts_the_thread_with_its_options_mcp_servers_app_tools_and_system_prompt() {
    let mut config = serde_json::Map::new();
    config.insert("model_reasoning_summary".into(), json!("auto"));
    let servers = [
        (
            "gh".to_string(),
            McpServer::Stdio {
                command: "gh-mcp".into(),
                args: vec!["--stdio".into()],
                env: [("TOKEN".into(), "x".into())].into(),
            },
        ),
        (
            "docs".to_string(),
            McpServer::Http {
                url: "https://example.com/mcp".into(),
                headers: [("X-Key".into(), "k".into())].into(),
            },
        ),
        (
            "old".to_string(),
            McpServer::Sse {
                url: "https://example.com/sse".into(),
                headers: Default::default(),
            },
        ),
    ];
    let caps = Capabilities {
        tools: vec![lookup_order(Arc::default())],
        system_prompt: Some("Be brief.".into()),
        mcp_servers: servers.into_iter().collect(),
        ..Default::default()
    };
    let env = setup(caps, CodexOptions { config, ..plain() }, &[]);
    let cwd = common::temp_dir();
    let mode = Some(agent_threads::protocol::PermissionMode::Plan);
    let t = env
        .sdk
        .create(CreateOptions {
            model: Some("gpt-test".into()),
            permission_mode: mode,
            cwd: Some(cwd.clone()),
            ..create()
        })
        .await
        .unwrap();
    env.sdk.send(&t.id, "reply ok", SendOptions::default()).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    let runs = mini_runs(&env.log);
    assert_eq!(runs[0].argv, ["app-server"]);
    let methods: Vec<&str> = runs[0]
        .sent
        .iter()
        .take(4)
        .map(|m| m["method"].as_str().unwrap())
        .collect();
    assert_eq!(methods, ["initialize", "initialized", "skills/list", "thread/start"]);
    assert_eq!(
        runs[0].sent[0]["params"]["capabilities"],
        json!({"experimentalApi": true})
    );
    let schema = json!({"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]});
    assert_eq!(
        env.sent("thread/start")[0]["params"],
        json!({
            "cwd": cwd,
            "model": "gpt-test",
            "approvalPolicy": "untrusted",
            "sandbox": "workspace-write",
            "developerInstructions": "Be brief.",
            "config": {
                "model_reasoning_summary": "auto",
                "features.default_mode_request_user_input": true,
                "suppress_unstable_features_warning": true,
                "mcp_servers": {
                    "gh": {"command": "gh-mcp", "args": ["--stdio"], "env": {"TOKEN": "x"}},
                    "docs": {"url": "https://example.com/mcp", "http_headers": {"X-Key": "k"}},
                },
            },
            "dynamicTools": [{"type": "function", "name": "lookup_order", "description": "Looks up an order.", "inputSchema": schema}],
        })
    );
    let notices: Vec<&Value> = items(&s, "notice").into_iter().map(|n| &n["text"]).collect();
    assert_eq!(
        notices,
        [&json!(
            "The MCP server old isn't available: Codex doesn't support SSE MCP servers."
        )]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn asks_the_policy_about_commands_and_file_changes_and_the_user_when_it_says_ask() {
    let policy = PermissionPolicy::from_fn(|q, _| {
        if q.kind == ToolKind::Shell {
            PermissionDecision::Allow
        } else {
            PermissionDecision::Ask
        }
    });
    let env = setup(
        Capabilities {
            permissions: Some(policy),
            ..Default::default()
        },
        plain(),
        &[],
    );
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, "exec ls\nedit notes.txt", SendOptions::default())
        .await
        .unwrap();
    let r = env.request(&t.id).await;
    assert_eq!(
        (r["type"].clone(), r["kind"].clone()),
        (json!("permission"), json!("edit"))
    );
    env.sdk
        .respond(
            &t.id,
            r["id"].as_str().unwrap(),
            serde_json::from_value(json!({"outcome": "deny", "message": "no"})).unwrap(),
        )
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    let c = calls(&s);
    assert_eq!(
        (c[0]["kind"].clone(), c[0]["status"].clone()),
        (json!("shell"), json!("completed"))
    );
    assert_eq!(
        (c[1]["kind"].clone(), c[1]["status"].clone()),
        (json!("edit"), json!("denied"))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_app_tools_given_as_dynamic_tools_through_the_policy() {
    let seen: Arc<Mutex<Vec<ToolContext>>> = Arc::default();
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let a2 = asked.clone();
    let policy = PermissionPolicy::from_async(move |q, _| {
        a2.lock().unwrap().push(q.name.clone());
        async { PermissionDecision::Ask }
    });
    let env = setup(
        Capabilities {
            tools: vec![lookup_order(seen.clone())],
            permissions: Some(policy),
            ..Default::default()
        },
        plain(),
        &[],
    );
    let mut metadata = serde_json::Map::new();
    metadata.insert("user".into(), json!("u1"));
    let t = env.sdk.create(CreateOptions { metadata, ..create() }).await.unwrap();
    env.sdk
        .send(&t.id, r#"app lookup_order {"order_id":"42"}"#, SendOptions::default())
        .await
        .unwrap();
    let r = env.request(&t.id).await;
    assert_eq!(
        (r["name"].clone(), r["kind"].clone(), r["input"].clone()),
        (json!("lookup_order"), json!("app"), json!({"order_id": "42"}))
    );
    env.sdk
        .respond(
            &t.id,
            r["id"].as_str().unwrap(),
            serde_json::from_value(json!({"outcome": "allow"})).unwrap(),
        )
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    let call = calls(&s)[0].clone();
    assert_eq!(
        (
            call["kind"].clone(),
            call["status"].clone(),
            call["result"]["content"].clone()
        ),
        (json!("app"), json!("completed"), json!("Order 42: 3 blue widgets."))
    );
    assert_eq!(call["result"]["structured"], json!({"order_id": "42"}));
    let ctx = seen.lock().unwrap()[0].clone();
    assert_eq!(
        (ctx.thread_id, ctx.metadata["user"].clone(), ctx.tool_call_id),
        (t.id.clone(), json!("u1"), call["id"].as_str().map(String::from))
    );
    assert_eq!(texts(&s), ["app said Order 42: 3 blue widgets."]);
    assert_eq!(*asked.lock().unwrap(), ["lookup_order"]);
}

/// POSTs JSON to a URL on 127.0.0.1, with headers; the status and body.
async fn post(url: &str, headers: &[(String, String)], body: &str) -> Result<(u16, String), std::io::Error> {
    let rest = url.strip_prefix("http://127.0.0.1:").unwrap();
    let (port, path) = rest.split_once('/').unwrap();
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port.parse::<u16>().unwrap())).await?;
    let mut req = format!(
        "POST /{path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    req.push_str(body);
    s.write_all(req.as_bytes()).await?;
    let mut out = String::new();
    s.read_to_string(&mut out).await?;
    let status = out.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    Ok((status, out.split("\r\n\r\n").nth(1).unwrap_or("").to_string()))
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_app_tools_on_a_loopback_mcp_server_when_codex_refuses_dynamic_tools() {
    let seen: Arc<Mutex<Vec<ToolContext>>> = Arc::default();
    let env = setup(
        Capabilities {
            tools: vec![lookup_order(seen.clone())],
            ..Default::default()
        },
        plain(),
        &[("MINI_CODEX_NO_DYNAMIC", "1")],
    );
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, r#"app lookup_order {"order_id":"7"}"#, SendOptions::default())
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    let starts = env.sent("thread/start");
    assert_eq!(starts[0]["params"]["dynamicTools"].as_array().unwrap().len(), 1);
    assert!(starts[1]["params"].get("dynamicTools").is_none());
    let app = starts[1]["params"]["config"]["mcp_servers"]["app"].clone();
    let url = app["url"].as_str().unwrap().to_string();
    assert!(url.starts_with("http://127.0.0.1:") && url.ends_with("/mcp"));
    let auth = app["http_headers"]["Authorization"].as_str().unwrap().to_string();
    assert!(auth.starts_with("Bearer ") && auth.len() > 27);
    assert_eq!(app["default_tools_approval_mode"], "approve");
    assert!(
        mini_runs(&env.log)[0]
            .notes
            .contains(&json!({"mcpTools": ["lookup_order"]}))
    );
    let call = calls(&s)[0].clone();
    assert_eq!(
        (
            call["kind"].clone(),
            call["status"].clone(),
            call["result"]["content"].clone()
        ),
        (json!("app"), json!("completed"), json!("Order 7: 3 blue widgets."))
    );
    assert!(call.get("server").is_none());
    assert_eq!(call["result"]["structured"], json!({"order_id": "7"}));
    assert_eq!(
        seen.lock().unwrap()[0].tool_call_id,
        call["id"].as_str().map(String::from)
    );
    assert_eq!(texts(&s), ["app said Order 7: 3 blue widgets."]);

    // It takes only requests with its token.
    let list = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
    assert_eq!(
        post(&url, &[("Authorization".into(), "Bearer wrong".into())], list)
            .await
            .unwrap()
            .0,
        401
    );
    assert_eq!(post(&url, &[], list).await.unwrap().0, 401);
    let (status, body) = post(&url, &[("Authorization".into(), auth.clone())], list)
        .await
        .unwrap();
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["result"]["tools"][0]["name"],
        "lookup_order"
    );
    let note = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
    assert_eq!(
        post(&url, &[("Authorization".into(), auth.clone())], note)
            .await
            .unwrap()
            .0,
        202
    );
    // The server goes with the process.
    env.sdk.close(false).await.unwrap();
    assert!(post(&url, &[("Authorization".into(), auth)], list).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn uses_the_loopback_mcp_server_when_asked_to_and_applies_the_policy_to_its_tools() {
    let policy = PermissionPolicy::from_fn(|q, _| {
        if q.kind == ToolKind::App {
            PermissionDecision::deny("no orders")
        } else {
            PermissionDecision::Allow
        }
    });
    let caps = Capabilities {
        tools: vec![lookup_order(Arc::default())],
        permissions: Some(policy),
        ..Default::default()
    };
    let env = setup(
        caps,
        CodexOptions {
            app_tools: AppTools::Mcp,
            ..plain()
        },
        &[],
    );
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, r#"app lookup_order {"order_id":"7"}"#, SendOptions::default())
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(env.sent("thread/start").len(), 1);
    let call = calls(&s)[0].clone();
    assert_eq!(
        (call["kind"].clone(), call["status"].clone()),
        (json!("app"), json!("denied"))
    );
    assert_eq!(texts(&s), ["app said no orders"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn steers_a_running_turn_with_turn_steer_and_the_message_joins_it_when_codex_takes_it_in() {
    let env = setup(Capabilities::default(), plain(), &[]);
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk.send(&t.id, "sleep 300", SendOptions::default()).await.unwrap();
    until(5, || async { (!env.sent("turn/start").is_empty()).then_some(()) }).await;
    env.sdk.send(&t.id, "also this", SendOptions::default()).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    let steer = env.sent("turn/steer")[0].clone();
    assert_eq!(steer["params"]["threadId"], s["thread"]["session_id"]);
    assert_eq!(steer["params"]["input"][0]["text"], "also this");
    assert!(steer["params"]["expectedTurnId"].as_str().unwrap().starts_with("turn-"));
    let m = items(&s, "user_message")
        .into_iter()
        .find(|i| i["text"] == "also this")
        .unwrap()
        .clone();
    assert_eq!(m["steered"], true);
    assert!(m.get("queued").is_none());
    assert_eq!(results(&s).len(), 1);
    assert_eq!(texts(&s), ["heard also this"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn carries_a_message_codex_refused_to_steer_with_over_to_the_next_turn() {
    let env = setup(Capabilities::default(), plain(), &[("MINI_CODEX_STEER", "reject")]);
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk.send(&t.id, "sleep 200", SendOptions::default()).await.unwrap();
    until(5, || async { (!env.sent("turn/start").is_empty()).then_some(()) }).await;
    env.sdk
        .send(&t.id, "reply carried", SendOptions::default())
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    let starts: Vec<Value> = env
        .sent("turn/start")
        .iter()
        .map(|m| m["params"]["input"][0]["text"].clone())
        .collect();
    assert_eq!(starts, [json!("sleep 200"), json!("reply carried")]);
    assert_eq!(results(&s).len(), 2);
    assert_eq!(texts(&s), ["carried"]);
    assert_eq!(s["thread"]["status"], "idle");
}

#[tokio::test(flavor = "multi_thread")]
async fn interrupts_with_turn_interrupt() {
    let env = setup(Capabilities::default(), plain(), &[]);
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, "exec sleep 100\nslow", SendOptions::default())
        .await
        .unwrap();
    until(5, || async {
        let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
        (calls(&s).first().is_some_and(|c| c["status"] == "completed")).then_some(())
    })
    .await;
    env.sdk.interrupt(&t.id).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    let i = env.sent("turn/interrupt")[0].clone();
    assert_eq!(i["params"]["threadId"], s["thread"]["session_id"]);
    let r = results(&s)[0];
    assert_eq!((r["ok"].clone(), r["interrupted"].clone()), (json!(false), json!(true)));
    assert_eq!(s["thread"]["status"], "idle");
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_warnings_and_retries_as_notices_and_a_failed_turns_error() {
    let env = setup(Capabilities::default(), plain(), &[]);
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, "warn careful\nretry\nfail it broke", SendOptions::default())
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    let notices: Vec<(Value, Value, Value)> = items(&s, "notice")
        .iter()
        .map(|n| {
            (
                n["level"].clone(),
                n.get("code").cloned().unwrap_or(Value::Null),
                n["text"].clone(),
            )
        })
        .collect();
    assert_eq!(
        notices,
        [
            (json!("warning"), Value::Null, json!("careful")),
            (json!("warning"), json!("retry"), json!("Reconnecting... 1/5"))
        ]
    );
    assert_eq!(
        (results(&s)[0]["ok"].clone(), results(&s)[0]["error"].clone()),
        (json!(false), json!("it broke"))
    );
    assert_eq!(
        (s["thread"]["status"].clone(), s["thread"]["error"].clone()),
        (json!("error"), json!("it broke"))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn ends_the_turn_when_codex_crashes_and_resumes_the_session_in_a_new_process() {
    let env = setup(Capabilities::default(), plain(), &[]);
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, "reply first", SendOptions::default())
        .await
        .unwrap();
    settle(&env.sdk, &t.id).await;
    env.sdk.send(&t.id, "crash", SendOptions::default()).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    let error = results(&s)[1]["error"].as_str().unwrap().to_string();
    assert!(
        error.starts_with("Codex exited with code 3 during the turn.\nmini-codex crashed"),
        "{error}"
    );
    assert!(s["thread"].get("run").is_none());
    let session = s["thread"]["session_id"].clone();
    env.sdk.send(&t.id, "reply back", SendOptions::default()).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(mini_runs(&env.log).len(), 2);
    let resume = env.all_sent("thread/resume")[0].clone();
    assert_eq!(
        (
            resume["params"]["threadId"].clone(),
            resume["params"]["excludeTurns"].clone()
        ),
        (session.clone(), json!(true))
    );
    assert_eq!(s["thread"]["session_id"], session);
    assert_eq!(texts(&s), ["first", "back"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn sends_compact_as_thread_compact_start() {
    let env = setup(Capabilities::default(), plain(), &[]);
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk.send(&t.id, "reply hi", SendOptions::default()).await.unwrap();
    settle(&env.sdk, &t.id).await;
    env.sdk.send(&t.id, "/compact", SendOptions::default()).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(env.sent("thread/compact/start").len(), 1);
    assert_eq!(items(&s, "compaction")[0]["trigger"], "manual");
    assert_eq!(results(&s).len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn gives_the_process_new_options_with_its_next_turn() {
    let env = setup(Capabilities::default(), plain(), &[]);
    let t = env
        .sdk
        .create(CreateOptions {
            model: Some("a".into()),
            effort: Some("low".into()),
            ..create()
        })
        .await
        .unwrap();
    env.sdk.send(&t.id, "reply one", SendOptions::default()).await.unwrap();
    settle(&env.sdk, &t.id).await;
    let cmd =
        json!({"type": "set_options", "thread_id": t.id, "model": "b", "effort": "high", "permission_mode": "bypass"});
    env.sdk.handle_json(cmd).await.unwrap();
    env.sdk.send(&t.id, "reply two", SendOptions::default()).await.unwrap();
    settle(&env.sdk, &t.id).await;
    env.sdk
        .send(&t.id, "reply three", SendOptions::default())
        .await
        .unwrap();
    settle(&env.sdk, &t.id).await;
    assert_eq!(mini_runs(&env.log).len(), 1);
    let turns: Vec<Value> = env.sent("turn/start").iter().map(|m| m["params"].clone()).collect();
    assert!(turns[0].get("model").is_none() && turns[0].get("approvalPolicy").is_none());
    let p = &turns[1];
    assert_eq!(
        (
            p["model"].clone(),
            p["effort"].clone(),
            p["approvalPolicy"].clone(),
            p["sandboxPolicy"].clone()
        ),
        (
            json!("b"),
            json!("high"),
            json!("never"),
            json!({"type": "dangerFullAccess"})
        )
    );
    // Codex keeps them.
    assert!(turns[2].get("model").is_none() && turns[2].get("approvalPolicy").is_none());
    assert!(turns.iter().all(|p| p.get("collaborationMode").is_none()));
}

#[tokio::test(flavor = "multi_thread")]
async fn starts_a_new_process_with_codexs_own_model_or_effort_when_the_threads_is_cleared() {
    for option in ["model", "effort"] {
        let env = setup(Capabilities::default(), plain(), &[]);
        let t = env
            .sdk
            .create(CreateOptions {
                model: Some("a".into()),
                effort: Some("high".into()),
                ..create()
            })
            .await
            .unwrap();
        env.sdk.send(&t.id, "reply one", SendOptions::default()).await.unwrap();
        settle(&env.sdk, &t.id).await;
        let cmd = json!({"type": "set_options", "thread_id": t.id, option: ""});
        env.sdk.handle_json(cmd).await.unwrap();
        env.sdk.send(&t.id, "reply two", SendOptions::default()).await.unwrap();
        settle(&env.sdk, &t.id).await;
        assert_eq!(mini_runs(&env.log).len(), 2, "{option}");
        if option == "model" {
            assert!(env.sent("thread/resume")[0]["params"].get("model").is_none());
        }
        assert!(env.sent("turn/start")[0]["params"].get(option).is_none(), "{option}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn starts_a_new_process_resuming_the_session_when_the_config_changes() {
    let env = setup(Capabilities::default(), plain(), &[]);
    let t = env
        .sdk
        .create(CreateOptions {
            model: Some("a".into()),
            ..create()
        })
        .await
        .unwrap();
    env.sdk.send(&t.id, "reply one", SendOptions::default()).await.unwrap();
    settle(&env.sdk, &t.id).await;
    let cmd = json!({"type": "set_options", "thread_id": t.id, "model": "b", "permission_mode": "bypass"});
    env.sdk.handle_json(cmd).await.unwrap();
    let update = CapabilitiesUpdate {
        system_prompt: Some("Be brief.".into()),
        ..Default::default()
    };
    env.sdk.configure(&t.id, update).await.unwrap();
    env.sdk.send(&t.id, "reply two", SendOptions::default()).await.unwrap();
    settle(&env.sdk, &t.id).await;
    assert_eq!(mini_runs(&env.log).len(), 2);
    let resume = env.sent("thread/resume")[0]["params"].clone();
    assert_eq!(
        (
            resume["model"].clone(),
            resume["approvalPolicy"].clone(),
            resume["sandbox"].clone()
        ),
        (json!("b"), json!("never"), json!("workspace-write"))
    );
    // The new process has them (its sandbox comes with its first turn): its turn doesn't override
    // the rest.
    let turn = env.sent("turn/start")[0]["params"].clone();
    assert!(turn.get("model").is_none() && turn.get("approvalPolicy").is_none());
    assert_eq!(turn["sandboxPolicy"], json!({"type": "dangerFullAccess"}));
}

/// A thread in plan mode.
async fn planning(env: &Env) -> String {
    let t = env
        .sdk
        .create(CreateOptions {
            permission_mode: Some(PermissionMode::Plan),
            ..create()
        })
        .await
        .unwrap();
    t.id
}

fn turn_starts(env: &Env) -> Vec<Value> {
    env.sent("turn/start").iter().map(|m| m["params"].clone()).collect()
}

fn respond(id: &str, request: &Value, resolution: Value) -> Value {
    json!({"type": "respond", "thread_id": id, "request_id": request["id"], "resolution": resolution})
}

#[tokio::test(flavor = "multi_thread")]
async fn in_plan_mode_asks_the_user_about_a_proposed_plan_and_implements_it_in_the_same_turn_once_its_approved() {
    let caps = Capabilities {
        permissions: Some(PermissionPolicy::ask()),
        ..Default::default()
    };
    let env = setup(caps, plain(), &[]);
    let t = env
        .sdk
        .create(CreateOptions {
            model: Some("m".into()),
            permission_mode: Some(PermissionMode::Plan),
            ..create()
        })
        .await
        .unwrap();
    env.sdk
        .send(&t.id, "propose Change apple to apricot.", SendOptions::default())
        .await
        .unwrap();
    let r = env.request(&t.id).await;
    assert_eq!(
        (r["type"].clone(), r["plan"].clone()),
        (json!("plan"), json!("Change apple to apricot."))
    );
    let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
    assert_eq!(s["thread"]["status"], "waiting");
    assert!(results(&s).is_empty());
    env.sdk
        .handle_json(respond(&t.id, &r, json!({"outcome": "allow"})))
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(s["thread"]["permission_mode"], "default");
    assert_eq!(mini_runs(&env.log).len(), 1);
    let turns = turn_starts(&env);
    assert_eq!(turns[0]["collaborationMode"]["mode"], "plan");
    assert_eq!(turns[0]["collaborationMode"]["settings"]["model"], "m");
    assert_eq!(turns[1]["input"][0]["text"], "Implement the plan.");
    assert_eq!(turns[1]["collaborationMode"]["mode"], "default");
    // Its approval policy's the same.
    assert_eq!(
        (
            turns[1].get("approvalPolicy"),
            turns[1]["sandboxPolicy"]["type"].clone()
        ),
        (None, json!("workspaceWrite"))
    );
    // One turn, of both Codex turns.
    let r = results(&s);
    assert_eq!(r.len(), 1);
    assert_eq!(
        (r[0]["ok"].clone(), r[0]["duration_ms"].clone()),
        (json!(true), json!(14))
    );
    assert_eq!(
        r[0]["usage"],
        json!({"input_tokens": 120, "cache_read_tokens": 80, "output_tokens": 20, "cache_write_tokens": 0})
    );
    assert_eq!(texts(&s), ["Change apple to apricot."]);

    // Codex stays in its default mode, which isn't sent again.
    env.sdk.send(&t.id, "reply done", SendOptions::default()).await.unwrap();
    settle(&env.sdk, &t.id).await;
    assert!(turn_starts(&env)[2].get("collaborationMode").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn in_plan_mode_sends_the_users_feedback_and_plans_again_denied_without_any_the_turn_ends() {
    let env = setup(Capabilities::default(), plain(), &[]);
    let t = planning(&env).await;
    env.sdk.send(&t, "propose One.", SendOptions::default()).await.unwrap();
    let r = env.request(&t).await;
    env.sdk
        .handle_json(respond(&t, &r, json!({"outcome": "deny", "message": "propose Two."})))
        .await
        .unwrap();
    let r2 = until(5, || async {
        env.sdk
            .snapshot(&t)
            .await
            .unwrap()
            .requests
            .iter()
            .find(|x| x.id() != r["id"])
            .map(|x| serde_json::to_value(x).unwrap())
    })
    .await;
    assert_eq!((r2["type"].clone(), r2["plan"].clone()), (json!("plan"), json!("Two.")));
    env.sdk
        .handle_json(respond(&t, &r2, json!({"outcome": "deny"})))
        .await
        .unwrap();
    let s = settle(&env.sdk, &t).await;
    assert_eq!(s["thread"]["permission_mode"], "plan");
    let r = results(&s);
    assert_eq!((r.len(), r[0]["ok"].clone()), (1, json!(true)));
    let turns = turn_starts(&env);
    assert_eq!(turns.len(), 2);
    assert_eq!(
        (
            turns[1]["input"][0]["text"].clone(),
            turns[1]["collaborationMode"]["mode"].clone()
        ),
        (json!("propose Two."), json!("plan"))
    );
    assert!(turns[1].get("approvalPolicy").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn in_plan_mode_keeps_the_configs_workspace_write_settings_when_a_plans_approved_out_of_the_read_only_sandbox() {
    let sandbox = json!({"network_access": true, "exclude_tmpdir_env_var": true, "exclude_slash_tmp": true});
    let config = [("sandbox_workspace_write".to_string(), sandbox)].into_iter().collect();
    let env = setup(Capabilities::default(), CodexOptions { config, ..plain() }, &[]);
    let t = planning(&env).await;
    env.sdk.send(&t, "propose One.", SendOptions::default()).await.unwrap();
    let r = env.request(&t).await;
    env.sdk
        .handle_json(respond(
            &t,
            &r,
            json!({"outcome": "allow", "permission_mode": "accept_edits"}),
        ))
        .await
        .unwrap();
    settle(&env.sdk, &t).await;
    assert_eq!(
        turn_starts(&env)[1]["sandboxPolicy"],
        json!({"type": "workspaceWrite", "writableRoots": [], "networkAccess": true, "excludeTmpdirEnvVar": true, "excludeSlashTmp": true})
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn starts_threads_in_the_workspace_write_sandbox_and_switches_back_to_it_as_codex_has_it() {
    // In plan or bypass mode too, with its config dir's settings and its other directories.
    for mode in [PermissionMode::Plan, PermissionMode::Bypass] {
        let config = [("sandbox_workspace_write.writable_roots".to_string(), json!(["/base"]))]
            .into_iter()
            .collect();
        let env = setup(Capabilities::default(), CodexOptions { config, ..plain() }, &[]);
        let (home, cwd) = (common::temp_dir(), common::temp_dir());
        std::fs::write(
            home.join("config.toml"),
            "[sandbox_workspace_write]\nexclude_tmpdir_env_var = true\nexclude_slash_tmp = true\n",
        )
        .unwrap();
        let t = env
            .sdk
            .create(CreateOptions {
                cwd: Some(cwd.clone()),
                permission_mode: Some(mode),
                launch: LaunchOptions {
                    add_dirs: vec!["extra".into()],
                    config_dir: Some(home),
                    ..Default::default()
                },
                ..create()
            })
            .await
            .unwrap();
        if mode == PermissionMode::Plan {
            env.sdk
                .send(&t.id, "propose One.", SendOptions::default())
                .await
                .unwrap();
            let r = env.request(&t.id).await;
            env.sdk
                .handle_json(respond(
                    &t.id,
                    &r,
                    json!({"outcome": "allow", "permission_mode": "accept_edits"}),
                ))
                .await
                .unwrap();
        } else {
            env.sdk.send(&t.id, "reply one", SendOptions::default()).await.unwrap();
            settle(&env.sdk, &t.id).await;
            let cmd = json!({"type": "set_options", "thread_id": t.id, "permission_mode": "accept_edits"});
            env.sdk.handle_json(cmd).await.unwrap();
            env.sdk.send(&t.id, "reply two", SendOptions::default()).await.unwrap();
        }
        settle(&env.sdk, &t.id).await;
        let (approval, first) = if mode == PermissionMode::Plan {
            ("untrusted", "readOnly")
        } else {
            ("never", "dangerFullAccess")
        };
        let start = env.sent("thread/start")[0]["params"].clone();
        assert_eq!(
            (start["approvalPolicy"].clone(), start["sandbox"].clone()),
            (json!(approval), json!("workspace-write"))
        );
        let turns = turn_starts(&env);
        assert_eq!(turns[0]["sandboxPolicy"], json!({"type": first}));
        assert_eq!(
            turns[1]["sandboxPolicy"],
            json!({
                "type": "workspaceWrite",
                "writableRoots": ["/base", cwd.join("extra")],
                "networkAccess": false,
                "excludeTmpdirEnvVar": true,
                "excludeSlashTmp": true,
            })
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn changes_only_the_approval_policy_when_the_sandbox_stays_and_switches_back_to_the_sandbox_codex_had() {
    // Codex takes a sandboxPolicy's settings that are left out as false.
    let config = [
        ("sandbox_workspace_write.network_access".to_string(), json!(true)),
        ("sandbox_workspace_write.exclude_slash_tmp".to_string(), json!(true)),
    ]
    .into_iter()
    .collect();
    let env = setup(Capabilities::default(), CodexOptions { config, ..plain() }, &[]);
    let t = env.sdk.create(create()).await.unwrap();
    for mode in [None, Some("accept_edits"), Some("bypass"), Some("accept_edits")] {
        if let Some(mode) = mode {
            let cmd = json!({"type": "set_options", "thread_id": t.id, "permission_mode": mode});
            env.sdk.handle_json(cmd).await.unwrap();
        }
        env.sdk.send(&t.id, "reply ok", SendOptions::default()).await.unwrap();
        settle(&env.sdk, &t.id).await;
    }
    let turns = turn_starts(&env);
    assert_eq!(
        (turns[1]["approvalPolicy"].clone(), turns[1].get("sandboxPolicy")),
        (json!("on-request"), None)
    );
    assert_eq!(
        (turns[2]["approvalPolicy"].clone(), turns[2]["sandboxPolicy"].clone()),
        (json!("never"), json!({"type": "dangerFullAccess"}))
    );
    assert_eq!(
        turns[3]["sandboxPolicy"],
        json!({"type": "workspaceWrite", "writableRoots": [], "networkAccess": true, "excludeTmpdirEnvVar": false, "excludeSlashTmp": true})
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn in_plan_mode_carries_on_in_the_mode_the_user_approves_the_plan_in() {
    let env = setup(Capabilities::default(), plain(), &[]);
    let t = planning(&env).await;
    env.sdk.send(&t, "propose One.", SendOptions::default()).await.unwrap();
    let r = env.request(&t).await;
    env.sdk
        .handle_json(respond(
            &t,
            &r,
            json!({"outcome": "allow", "permission_mode": "accept_edits"}),
        ))
        .await
        .unwrap();
    let s = settle(&env.sdk, &t).await;
    assert_eq!(s["thread"]["permission_mode"], "accept_edits");
    let p = &turn_starts(&env)[1];
    assert_eq!(
        (
            p["approvalPolicy"].clone(),
            p["sandboxPolicy"]["type"].clone(),
            p["collaborationMode"]["mode"].clone()
        ),
        (json!("on-request"), json!("workspaceWrite"), json!("default"))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn in_plan_mode_takes_a_message_sent_while_a_plan_waits_as_more_to_plan_with() {
    let env = setup(Capabilities::default(), plain(), &[]);
    let t = planning(&env).await;
    env.sdk.send(&t, "propose One.", SendOptions::default()).await.unwrap();
    let r = env.request(&t).await;
    let o = SendOptions {
        client_id: Some("more".into()),
        ..Default::default()
    };
    env.sdk.send(&t, "reply And two.", o).await.unwrap();
    let s = settle(&env.sdk, &t).await;
    let plan = s["requests"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == r["id"])
        .unwrap();
    assert_eq!(plan["resolution"], json!({"outcome": "cancel"}));
    let m = items(&s, "user_message")
        .into_iter()
        .find(|i| i["client_id"] == "more")
        .unwrap()
        .clone();
    assert_eq!(m["steered"], true);
    assert_eq!(texts(&s), ["One.", "And two."]);
    assert_eq!(results(&s).len(), 1);
    let p = &turn_starts(&env)[1];
    assert_eq!(
        (p["input"][0]["text"].clone(), p["collaborationMode"]["mode"].clone()),
        (json!("reply And two."), json!("plan"))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn in_plan_mode_ends_the_turn_when_its_interrupted_while_a_plan_waits() {
    let env = setup(Capabilities::default(), plain(), &[]);
    let t = planning(&env).await;
    env.sdk.send(&t, "propose One.", SendOptions::default()).await.unwrap();
    let r = env.request(&t).await;
    env.sdk.interrupt(&t).await.unwrap();
    let s = settle(&env.sdk, &t).await;
    let res = results(&s);
    assert_eq!(
        (res.len(), res[0]["ok"].clone(), res[0]["interrupted"].clone()),
        (1, json!(false), json!(true))
    );
    // Kept, resolved.
    assert_eq!(
        (s["requests"][0]["id"].clone(), s["requests"][0]["resolution"].clone()),
        (r["id"].clone(), json!({"outcome": "cancel"}))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn in_plan_mode_keeps_what_the_plans_used_when_the_turn_fails_after_them() {
    let env = setup(Capabilities::default(), plain(), &[]);
    let t = planning(&env).await;
    env.sdk.send(&t, "propose One.", SendOptions::default()).await.unwrap();
    let r = env.request(&t).await;
    env.sdk
        .handle_json(respond(&t, &r, json!({"outcome": "deny", "message": "crash"})))
        .await
        .unwrap();
    let s = settle(&env.sdk, &t).await;
    let r = results(&s);
    let used = json!({"input_tokens": 60, "cache_read_tokens": 40, "output_tokens": 10, "cache_write_tokens": 0});
    assert_eq!(
        (
            r.len(),
            r[0]["ok"].clone(),
            r[0]["duration_ms"].clone(),
            r[0]["usage"].clone()
        ),
        (1, json!(false), json!(7), used.clone())
    );
    assert_eq!(s["thread"]["usage"], used);
}

#[tokio::test(flavor = "multi_thread")]
async fn in_plan_mode_doesnt_ask_about_a_plan_outside_plan_mode() {
    let env = setup(Capabilities::default(), plain(), &[]);
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, "propose One.", SendOptions::default())
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    let r = results(&s);
    assert_eq!((r.len(), r[0]["ok"].clone()), (1, json!(true)));
}

#[tokio::test(flavor = "multi_thread")]
async fn turns_off_the_users_and_the_projects_skills_keeping_the_apps_and_codexs_own() {
    let skill = |root: &std::path::Path, name: &str| {
        let dir = root.join(".agents/skills").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), format!("---\nname: {name}\n---\n")).unwrap();
        dir.join("SKILL.md").to_string_lossy().to_string()
    };
    let caps = Capabilities {
        skills: vec![Skill::Inline {
            name: "app-skill".into(),
            content: "---\nname: app-skill\n---\n".into(),
        }],
        ..Default::default()
    };
    let env = setup(caps, plain(), &[]);
    let cwd = common::temp_dir();
    let user = skill(&env.user_home, "user-sentinel");
    let repo = skill(&cwd, "repo-sentinel");
    let t = env
        .sdk
        .create(CreateOptions {
            cwd: Some(cwd.clone()),
            ..create()
        })
        .await
        .unwrap();
    env.sdk.send(&t.id, "skills", SendOptions::default()).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(texts(&s), ["skills: app-skill,builtin"]);
    assert_eq!(
        env.sent("skills/list")[0]["params"],
        json!({"cwds": [cwd], "forceReload": true})
    );
    assert_eq!(
        env.sent("thread/start")[0]["params"]["config"]["skills"],
        json!({"config": [{"path": user, "enabled": false}, {"path": repo, "enabled": false}]})
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_a_secret_answer_out_of_whats_sent_and_saved_and_gives_it_only_to_codex() {
    let mut env = setup(Capabilities::default(), plain(), &[]);
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk.send(&t.id, "secret", SendOptions::default()).await.unwrap();
    let r = env.request(&t.id).await;
    assert_eq!(
        (
            r["type"].clone(),
            r["questions"][0]["id"].clone(),
            r["questions"][0]["secret"].clone()
        ),
        (json!("question"), json!("password"), json!(true))
    );
    let res =
        serde_json::from_value(json!({"outcome": "answer", "answers": {"password": ["hunter2-sentinel"]}})).unwrap();
    env.sdk.respond(&t.id, r["id"].as_str().unwrap(), res).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert!(
        mini_runs(&env.log)[0]
            .notes
            .contains(&json!({"secretAnswer": {"password": {"answers": ["hunter2-sentinel"]}}}))
    );
    assert_eq!(calls(&s)[0]["result"]["content"], "password: [secret]");
    let mut published = Vec::new();
    while let Ok(e) = env.rx.try_recv() {
        published.push(serde_json::to_value(e).unwrap());
    }
    let resolved = published.iter().find(|e| e["type"] == "request.resolved").unwrap();
    assert_eq!(resolved["resolution"]["answers"], json!({"password": ["[secret]"]}));
    env.sdk.close(false).await.unwrap();
    let saved = serde_json::to_string(&env.store.read_events(&t.id, 0, None).await.unwrap()).unwrap();
    for wherever in [saved, serde_json::to_string(&published).unwrap(), s.to_string()] {
        assert!(!wherever.contains("hunter2-sentinel"));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn links_the_users_login_into_the_apps_home() {
    let user = common::temp_dir();
    std::fs::write(user.join("auth.json"), r#"{"user":true}"#).unwrap();
    let env = setup(
        Capabilities::default(),
        CodexOptions {
            login: Some(user.clone()),
            ..Default::default()
        },
        &[],
    );
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk.send(&t.id, "reply hi", SendOptions::default()).await.unwrap();
    settle(&env.sdk, &t.id).await;
    let link = env.home.join("auth.json");
    assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    assert_eq!(std::fs::read_link(&link).unwrap(), user.join("auth.json"));
}

/// A snapshot's open requests (it keeps those resolved too).
fn open(s: &Value) -> Value {
    s["requests"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r.get("resolution").is_none_or(Value::is_null))
        .cloned()
        .collect()
}

fn shell_asks() -> Capabilities {
    Capabilities {
        permissions: Some(PermissionPolicy::from_fn(|q, _| match q.kind {
            ToolKind::Shell => PermissionDecision::Ask,
            _ => PermissionDecision::Allow,
        })),
        ..Default::default()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn shows_a_subagents_child_thread_under_its_spawn_agent_call() {
    let env = setup(Capabilities::default(), plain(), &[]);
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, "sub read the notes", SendOptions::default())
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    let call = calls(&s)[0].clone();
    // The spawn returns as soon as the child has started; the child's end is its subagent's.
    assert_eq!(
        (call["name"].clone(), call["status"].clone(), call["result"].clone()),
        (json!("spawnAgent"), json!("completed"), Value::Null)
    );
    assert_eq!(
        call["subagent"],
        json!({"status": "completed", "background": true, "summary": "child says read the notes"})
    );
    let child: Vec<&Value> = s["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["parent_id"] == call["id"])
        .collect();
    assert_eq!(child.len(), 1);
    assert_eq!(child[0]["text"], "child says read the notes");
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_a_child_threads_calls_and_requests_after_its_parents_turn_and_ends_its_subagent_with_the_childs_turn() {
    for (outcome, subagent, status) in [
        (
            "allow",
            json!({"status": "completed", "background": true, "model": "mini-child", "summary": "child ran touch a.txt"}),
            "completed",
        ),
        (
            "deny",
            json!({"status": "failed", "background": true, "model": "mini-child", "summary": "the child wasn't allowed to"}),
            "denied",
        ),
    ] {
        let env = setup(shell_asks(), plain(), &[]);
        let t = env.sdk.create(create()).await.unwrap();
        env.sdk
            .send(&t.id, "bg touch a.txt", SendOptions::default())
            .await
            .unwrap();
        // The turn ends with the child's command waiting for the user, who's still asked.
        let s = until(5, || async {
            let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
            (results(&s).len() == 1).then_some(s)
        })
        .await;
        assert_eq!(s["thread"]["status"], "waiting");
        let c = calls(&s);
        assert_eq!(
            (c[0]["status"].clone(), c[0]["subagent"].clone()),
            (
                json!("completed"),
                json!({"status": "running", "background": true, "model": "mini-child"})
            )
        );
        assert_eq!(
            (c[1]["status"].clone(), c[1]["parent_id"].clone()),
            (json!("pending"), c[0]["id"].clone())
        );
        let r = &s["requests"][0];
        env.sdk
            .respond(
                &t.id,
                r["id"].as_str().unwrap(),
                serde_json::from_value(json!({ "outcome": outcome })).unwrap(),
            )
            .await
            .unwrap();
        let s = until(5, || async {
            let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
            (s["thread"]["status"] == "idle" && calls(&s)[0]["subagent"]["status"] != "running").then_some(s)
        })
        .await;
        let c = calls(&s);
        assert_eq!(c[0]["subagent"], subagent);
        assert_eq!(c[1]["status"], status);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn stops_a_runs_child_threads_when_it_ends_and_cancels_what_they_were_doing() {
    let mut env = setup(
        Capabilities {
            permissions: Some(PermissionPolicy::ask()),
            ..Default::default()
        },
        plain(),
        &[],
    );
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, "bg sleep 60", SendOptions::default())
        .await
        .unwrap();
    until(5, || async {
        let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
        (results(&s).len() == 1 && s["thread"]["status"] == "waiting").then_some(())
    })
    .await;
    env.sdk.close(false).await.unwrap();
    let mut events = Vec::new();
    while let Ok(e) = env.rx.try_recv() {
        events.push(serde_json::to_value(e).unwrap());
    }
    let patches: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "item.updated")
        .map(|e| &e["patch"])
        .collect();
    assert!(patches.iter().any(|p| p["subagent"]["status"] == "stopped"));
    assert!(patches.iter().any(|p| p["status"] == "cancelled"));
    assert!(events.iter().any(|e| e["type"] == "request.resolved"));
}

#[tokio::test(flavor = "multi_thread")]
async fn cancels_what_a_child_thread_left_unfinished_when_it_ends_after_its_parents_turn() {
    for end in ["endchild interrupted", "closechild"] {
        let env = setup(shell_asks(), plain(), &[]);
        let t = env.sdk.create(create()).await.unwrap();
        env.sdk
            .send(&t.id, "bg sleep 60", SendOptions::default())
            .await
            .unwrap();
        until(5, || async {
            let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
            (results(&s).len() == 1 && s["thread"]["status"] == "waiting").then_some(())
        })
        .await;
        env.sdk.send(&t.id, end, SendOptions::default()).await.unwrap();
        let s = until(5, || async {
            let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
            (results(&s).len() == 2 && s["thread"]["status"] == "idle").then_some(s)
        })
        .await;
        let c = calls(&s);
        assert_eq!(
            c[0]["subagent"],
            json!({"status": "stopped", "background": true, "model": "mini-child"}),
            "{end}"
        );
        assert_eq!(c[1]["status"], "cancelled", "{end}");
        assert_eq!(open(&s), json!([]), "{end}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn sets_the_thread_running_again_when_a_child_thread_ends_during_its_parents_turn() {
    for end in ["endchild interrupted", "closechild"] {
        let env = setup(shell_asks(), plain(), &[]);
        let t = env.sdk.create(create()).await.unwrap();
        env.sdk
            .send(
                &t.id,
                &format!("bg sleep 60\nsleep 200\n{end}\nsleep 1500"),
                SendOptions::default(),
            )
            .await
            .unwrap();
        until(5, || async {
            let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
            (open(&s).as_array().unwrap().len() == 1 && s["thread"]["status"] == "waiting").then_some(())
        })
        .await;
        let s = until(5, || async {
            let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
            (calls(&s)[0]["subagent"]["status"] == "stopped").then_some(s)
        })
        .await;
        assert!(results(&s).is_empty(), "{end}");
        assert_eq!(open(&s), json!([]), "{end}");
        assert_eq!(s["thread"]["status"], "running", "{end}");
        env.sdk.interrupt(&t.id).await.unwrap();
        until(5, || async {
            let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
            (s["thread"]["status"] == "idle").then_some(())
        })
        .await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn doesnt_take_a_child_threads_earlier_report_for_a_follow_up_that_ends_without_one() {
    let env = setup(Capabilities::default(), plain(), &[]);
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, "sub old summary", SendOptions::default())
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(
        calls(&s)[0]["subagent"],
        json!({"status": "completed", "background": true, "summary": "child says old summary"})
    );
    env.sdk
        .send(&t.id, "followup interrupted", SendOptions::default())
        .await
        .unwrap();
    let s = until(5, || async {
        let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
        (results(&s).len() == 2 && s["thread"]["status"] == "idle").then_some(s)
    })
    .await;
    assert_eq!(
        calls(&s)[0]["subagent"],
        json!({"status": "stopped", "background": true})
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn cancels_a_child_threads_approval_about_none_of_its_calls_when_it_ends() {
    for end in ["endchild interrupted", "closechild"] {
        for late in ["", " late"] {
            let env = setup(
                Capabilities {
                    permissions: Some(PermissionPolicy::ask()),
                    ..Default::default()
                },
                plain(),
                &[],
            );
            let t = env.sdk.create(create()).await.unwrap();
            env.sdk
                .send(&t.id, &format!("bgmcp srv echo{late}"), SendOptions::default())
                .await
                .unwrap();
            // Two calls alike: the approval can't be put down to either. It's the child's, and
            // outlives the turn.
            let s = until(5, || async {
                let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
                (results(&s).len() == 1 && open(&s).as_array().unwrap().len() == 1).then_some(s)
            })
            .await;
            let r = &open(&s)[0];
            assert_eq!(
                (
                    r["tool_call_id"].clone(),
                    r["parent_id"].clone(),
                    s["thread"]["status"].clone()
                ),
                (Value::Null, calls(&s)[0]["id"].clone(), json!("waiting")),
                "{end}{late}"
            );
            env.sdk.send(&t.id, end, SendOptions::default()).await.unwrap();
            let s = until(5, || async {
                let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
                (results(&s).len() == 2 && s["thread"]["status"] == "idle").then_some(s)
            })
            .await;
            let c = calls(&s);
            assert_eq!(
                c[0]["subagent"],
                json!({"status": "stopped", "background": true, "model": "mini-child"}),
                "{end}{late}"
            );
            assert_eq!(
                (c[1]["status"].clone(), c[2]["status"].clone()),
                (json!("cancelled"), json!("cancelled")),
                "{end}{late}"
            );
            assert_eq!(open(&s), json!([]), "{end}{late}");
        }
    }
}

/// A thread's launch options: its own CODEX_HOME (used as it is), arguments after the options',
/// environment, and writable roots; stored with the thread, and changed by set_options.
#[tokio::test(flavor = "multi_thread")]
async fn starts_codex_with_the_threads_launch_options() {
    let mut o = plain();
    o.args = vec!["--own".into()];
    o.config
        .insert("sandbox_workspace_write.writable_roots".into(), json!(["/base"]));
    let env = setup(
        Capabilities::default(),
        o,
        &[("MINI_LOG_ENV", "AT_SET,AT_GONE"), ("AT_GONE", "instance")],
    );
    let (home, cwd) = (common::temp_dir(), common::temp_dir());
    let t = env
        .sdk
        .create(CreateOptions {
            cwd: Some(cwd.clone()),
            launch: LaunchOptions {
                args: vec!["-c".into(), "a=1".into()],
                env: [
                    ("AT_SET".to_string(), Some("x y".to_string())),
                    ("AT_GONE".to_string(), None),
                ]
                .into(),
                add_dirs: vec!["sub".into(), "/abs".into()],
                config_dir: Some(home.clone()),
            },
            ..create()
        })
        .await
        .unwrap();
    env.sdk.send(&t.id, "reply one", SendOptions::default()).await.unwrap();
    assert_eq!(texts(&settle(&env.sdk, &t.id).await), ["one"]);
    let runs = mini_runs(&env.log);
    assert_eq!(runs[0].argv, ["app-server", "--own", "-c", "a=1"]);
    assert_eq!(runs[0].config_dir.as_deref(), Some(home.to_str().unwrap()));
    assert_eq!(runs[0].env, json!({"AT_SET": "x y", "AT_GONE": null}));
    assert_eq!(
        env.sent("thread/start")[0]["params"]["config"]["sandbox_workspace_write.writable_roots"],
        json!(["/base", cwd.join("sub"), "/abs"])
    );
    // Its own home, not the app's: no login was linked into it.
    assert!(!home.join("auth.json").exists());
    let stored = env.store.get_thread(&t.id).await.unwrap().unwrap();
    assert_eq!(stored["launch"]["args"], json!(["-c", "a=1"]));
    assert!(
        serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap()["thread"]
            .get("launch")
            .is_none()
    );

    // New arguments: the next turn resumes the thread in a new process that has them.
    env.sdk
        .set_options(
            &t.id,
            ThreadOptions {
                launch: Some(LaunchOptions {
                    args: vec!["-c".into(), "a=2".into()],
                    config_dir: Some(home.clone()),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    env.sdk.send(&t.id, "reply two", SendOptions::default()).await.unwrap();
    assert_eq!(texts(&settle(&env.sdk, &t.id).await), ["one", "two"]);
    let runs = mini_runs(&env.log);
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[1].argv, ["app-server", "--own", "-c", "a=2"]);
    assert_eq!(runs[1].env, json!({"AT_SET": null, "AT_GONE": "instance"}));
    assert_eq!(env.sent("thread/resume").len(), 1);
    assert_eq!(
        env.sent("thread/resume")[0]["params"]["config"]["sandbox_workspace_write.writable_roots"],
        json!(["/base"])
    );
}
