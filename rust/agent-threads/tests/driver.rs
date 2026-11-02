//! What the recorded fixtures don't cover, against a scriptable fake `claude` (the Node backend's
//! mini-claude.mjs): steering that outlives a turn, policies, failures, restarts, option changes
//! and stopping; and AgentThreads itself (commands it refuses, stores that fail, deleting). As the
//! Node backend's driver.test.ts does.

mod common;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_threads::protocol::ToolKind;
use agent_threads::{
    AgentThreads, Capabilities, ClaudeCodeOptions, CreateOptions, Error, FileStore, McpServer, MemoryState,
    MemoryStore, Options, PermissionDecision, PermissionPolicy, RunRecord, SendOptions, Skill, SqliteStore, Store,
    StoreError, StoreResult, ThreadEvent, ThreadOptions, ToolContext, tool,
};
use async_trait::async_trait;
use common::{items, mini_runs, settle, texts, until};
use serde_json::{Value, json};
use tokio::sync::broadcast;

struct Setup {
    claude: ClaudeCodeOptions,
    steer: &'static str,
    env: Vec<(&'static str, String)>,
    store: Option<Arc<dyn Store>>,
    capabilities: Capabilities,
    errors: Arc<Mutex<Vec<String>>>,
}

impl Default for Setup {
    fn default() -> Self {
        Setup {
            claude: ClaudeCodeOptions::default(),
            steer: "now",
            env: Vec::new(),
            store: None,
            capabilities: Capabilities {
                permissions: Some(PermissionPolicy::allow()),
                ..Default::default()
            },
            errors: Arc::default(),
        }
    }
}

struct Env {
    sdk: AgentThreads,
    log: PathBuf,
    rx: broadcast::Receiver<ThreadEvent>,
    events: Vec<ThreadEvent>,
    setup: Setup,
}

impl Env {
    fn make(&self, store: Arc<dyn Store>) -> AgentThreads {
        let mut env: HashMap<String, Option<String>> = HashMap::new();
        env.insert("MINI_CLAUDE_LOG".into(), Some(self.log.to_string_lossy().into()));
        env.insert("MINI_CLAUDE_STEER".into(), Some(self.setup.steer.into()));
        for (k, v) in &self.setup.env {
            env.insert(k.to_string(), Some(v.clone()));
        }
        let mut claude = self.setup.claude.clone();
        if claude.bin == "claude" {
            claude.bin = common::mini("claude").to_string_lossy().into();
        }
        claude.env.extend(env);
        let errors = self.setup.errors.clone();
        AgentThreads::new(Options {
            store: Some(store),
            harnesses: vec![agent_threads::claude_code(claude)],
            capabilities: self.setup.capabilities.clone(),
            on_error: Some(Arc::new(move |e| errors.lock().unwrap().push(e.to_string()))),
            event_capacity: 1 << 16,
            ..Default::default()
        })
    }

    fn events(&mut self) -> &[ThreadEvent] {
        while let Ok(e) = self.rx.try_recv() {
            self.events.push(e);
        }
        &self.events
    }

    fn events_json(&mut self) -> Vec<Value> {
        self.events().iter().map(|e| serde_json::to_value(e).unwrap()).collect()
    }

    fn runs(&self) -> Vec<common::MiniRun> {
        mini_runs(&self.log)
    }
}

fn setup(setup: Setup) -> Env {
    let log = common::temp_dir().join("log.jsonl");
    let store = setup.store.clone().unwrap_or_else(|| Arc::new(MemoryStore::new()));
    let mut env = Env {
        sdk: AgentThreads::default(),
        log,
        rx: broadcast::channel(1).1,
        events: Vec::new(),
        setup,
    };
    env.sdk = env.make(store);
    env.rx = env.sdk.subscribe();
    env
}

fn create() -> CreateOptions {
    CreateOptions {
        cwd: Some(common::temp_dir()),
        ..Default::default()
    }
}

fn results(s: &Value) -> Vec<&Value> {
    items(s, "turn_result")
}

fn contains_all(argv: &[String], want: &[&str]) -> bool {
    want.windows(2)
        .step_by(2)
        .all(|w| argv.windows(2).any(|a| a[0] == w[0] && a[1] == w[1]))
        || want.iter().all(|w| argv.iter().any(|a| a == w))
}

/// Whether `argv` has `flag` followed by `value`.
fn has(argv: &[String], flag: &str, value: &str) -> bool {
    argv.windows(2).any(|a| a[0] == flag && a[1] == value)
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_turns_in_one_process_and_sets_the_session_id() {
    let env = setup(Setup::default());
    let t = env
        .sdk
        .create(CreateOptions {
            model: Some("mini".into()),
            ..create()
        })
        .await
        .unwrap();
    env.sdk.send(&t.id, "reply one", SendOptions::default()).await.unwrap();
    settle(&env.sdk, &t.id).await;
    env.sdk.send(&t.id, "reply two", SendOptions::default()).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(texts(&s), ["one", "two"]);
    assert!(s["thread"]["session_id"].as_str().unwrap().starts_with("sess-"));
    assert_eq!(
        s["thread"]["usage"],
        json!({"input_tokens": 2, "output_tokens": 4, "cache_read_tokens": 0, "cache_write_tokens": 0, "cost_usd": 0.002})
    );
    let runs = env.runs();
    assert_eq!(runs.len(), 1);
    assert!(has(&runs[0].argv, "--model", "mini") && has(&runs[0].argv, "--setting-sources", ""));
    assert!(runs[0].argv.contains(&"--strict-mcp-config".to_string()));
}

#[tokio::test(flavor = "multi_thread")]
async fn starts_the_next_turn_with_a_steered_message_claude_takes_in_after_its_turn_ends() {
    let mut env = setup(Setup {
        steer: "late",
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk.send(&t.id, "slow", SendOptions::default()).await.unwrap();
    until(5, || async {
        env.sdk.snapshot(&t.id).await.unwrap().thread.session_id.map(|_| ())
    })
    .await;
    env.sdk
        .send(
            &t.id,
            "reply steered",
            SendOptions {
                client_id: Some("c2".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    env.sdk.interrupt(&t.id).await.unwrap();
    let s = until(5, || async {
        let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
        (results(&s).len() == 2 && s["thread"]["status"] == "idle").then_some(s)
    })
    .await;
    let steered = items(&s, "user_message")
        .into_iter()
        .find(|i| i["client_id"] == "c2")
        .unwrap()
        .clone();
    assert!(steered.get("queued").is_none());
    assert_eq!(steered["steered"], true);
    let r = results(&s);
    assert_eq!(
        (r[0]["ok"].clone(), r[0]["interrupted"].clone()),
        (json!(false), json!(true))
    );
    assert_eq!(r[1]["ok"], true);
    // It moved to the turn it started.
    assert_eq!(steered["turn_id"], r[1]["turn_id"]);
    assert_eq!(texts(&s), ["steered"]);
    assert_eq!(
        env.events()
            .iter()
            .filter(|e| matches!(e, ThreadEvent::TurnStarted(_)))
            .count(),
        2
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_a_carried_over_turn_with_options_changed_during_the_turn_before() {
    let env = setup(Setup {
        steer: "late",
        ..Default::default()
    });
    let t = env
        .sdk
        .create(CreateOptions {
            model: Some("old-model".into()),
            ..create()
        })
        .await
        .unwrap();
    env.sdk.send(&t.id, "slow", SendOptions::default()).await.unwrap();
    until(5, || async {
        env.sdk.snapshot(&t.id).await.unwrap().thread.session_id.map(|_| ())
    })
    .await;
    env.sdk
        .send(&t.id, "reply steered", SendOptions::default())
        .await
        .unwrap();
    env.sdk
        .set_options(
            &t.id,
            ThreadOptions {
                model: Some("new-model".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    env.sdk.interrupt(&t.id).await.unwrap();
    let s = until(5, || async {
        let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
        (results(&s).len() == 2 && s["thread"]["status"] == "idle").then_some(s)
    })
    .await;
    assert_eq!(texts(&s), ["steered"]);
    let runs = env.runs();
    assert!(has(&runs[0].argv, "--model", "old-model"));
    assert!(has(&runs[1].argv, "--model", "new-model"));
    assert!(has(
        &runs[1].argv,
        "--resume",
        s["thread"]["session_id"].as_str().unwrap()
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn restarts_claude_with_a_steered_message_it_never_takes_in() {
    let claude = ClaudeCodeOptions {
        steer_grace: Duration::from_millis(100),
        close_grace: Duration::from_millis(100),
        ..Default::default()
    };
    let env = setup(Setup {
        steer: "never",
        claude,
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk.send(&t.id, "slow", SendOptions::default()).await.unwrap();
    until(5, || async {
        env.sdk.snapshot(&t.id).await.unwrap().thread.session_id.map(|_| ())
    })
    .await;
    // Sent while a turn runs, so it's steered; this Claude ignores it.
    env.sdk.send(&t.id, "reply a", SendOptions::default()).await.unwrap();
    env.sdk.interrupt(&t.id).await.unwrap();
    let s = until(5, || async {
        let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
        (texts(&s).contains(&"a".to_string()) && s["thread"]["status"] == "idle").then_some(s)
    })
    .await;
    assert!(items(&s, "user_message").iter().all(|i| i.get("queued").is_none()));
    let runs = env.runs();
    assert_eq!(runs.len(), 2);
    assert!(has(
        &runs[1].argv,
        "--resume",
        s["thread"]["session_id"].as_str().unwrap()
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn doesnt_restart_claude_while_it_works_through_steered_messages_for_longer_than_the_grace() {
    let claude = ClaudeCodeOptions {
        steer_grace: Duration::from_millis(150),
        ..Default::default()
    };
    let env = setup(Setup {
        steer: "late",
        claude,
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, "sleep 100 first", SendOptions::default())
        .await
        .unwrap();
    until(5, || async {
        env.sdk.snapshot(&t.id).await.unwrap().thread.session_id.map(|_| ())
    })
    .await;
    env.sdk
        .send(&t.id, "sleep 500 second", SendOptions::default())
        .await
        .unwrap();
    env.sdk
        .send(&t.id, "reply third", SendOptions::default())
        .await
        .unwrap();
    until(5, || async {
        let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
        (texts(&s).contains(&"third".to_string()) && s["thread"]["status"] == "idle").then_some(())
    })
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
    assert_eq!(texts(&s), ["first", "second", "third"]);
    assert_eq!(env.runs().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn asks_the_policy_and_remembers_an_answer_given_always() {
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let s2 = seen.clone();
    let policy = PermissionPolicy::from_fn(move |q, _| {
        s2.lock().unwrap().push(q.name.clone());
        match (q.kind, q.name.as_str()) {
            (ToolKind::Read, _) => PermissionDecision::Allow,
            (_, "WebFetch") => PermissionDecision::deny("No web."),
            _ => PermissionDecision::Ask,
        }
    });
    let mut env = setup(Setup {
        capabilities: Capabilities {
            permissions: Some(policy),
            ..Default::default()
        },
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, r#"tool Read {"file_path":"a.txt"}"#, SendOptions::default())
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    let call = items(&s, "tool_call")[0].clone();
    assert_eq!(
        (
            call["name"].clone(),
            call["kind"].clone(),
            call["path"].clone(),
            call["status"].clone()
        ),
        (json!("Read"), json!("read"), json!("a.txt"), json!("completed"))
    );

    env.sdk
        .send(
            &t.id,
            r#"tool WebFetch {"url":"https://example.com"}"#,
            SendOptions::default(),
        )
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert!(texts(&s).contains(&"denied: No web.".to_string()));
    assert_eq!(items(&s, "tool_call")[1]["status"], "denied");

    env.sdk
        .send(&t.id, r#"tool Bash {"command":"ls"}"#, SendOptions::default())
        .await
        .unwrap();
    let r = until(5, || async {
        env.sdk.snapshot(&t.id).await.unwrap().requests.first().cloned()
    })
    .await;
    let r = serde_json::to_value(r).unwrap();
    assert_eq!(
        (
            r["type"].clone(),
            r["name"].clone(),
            r["kind"].clone(),
            r["title"].clone()
        ),
        (json!("permission"), json!("Bash"), json!("shell"), json!("ls"))
    );
    let respond = json!({"type": "respond", "thread_id": t.id, "request_id": r["id"], "resolution": {"outcome": "allow", "always": true}});
    env.sdk.handle_json(respond).await.unwrap();
    settle(&env.sdk, &t.id).await;

    env.sdk
        .send(&t.id, r#"tool Bash {"command":"pwd"}"#, SendOptions::default())
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(
        env.events()
            .iter()
            .filter(|e| matches!(e, ThreadEvent::RequestOpened(_)))
            .count(),
        1
    );
    assert_eq!(*seen.lock().unwrap(), ["Read", "WebFetch", "Bash"]);
    assert_eq!(texts(&s).last().unwrap(), r#"ran with {"command":"pwd"}"#);
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_a_background_subagents_calls_and_requests_after_its_turn_and_runs_the_turn_claude_starts() {
    let policy = PermissionPolicy::from_fn(|q, _| match q.kind {
        ToolKind::Shell => PermissionDecision::Ask,
        _ => PermissionDecision::Allow,
    });
    let env = setup(Setup {
        capabilities: Capabilities {
            permissions: Some(policy),
            ..Default::default()
        },
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, "background 0 apple", SendOptions::default())
        .await
        .unwrap();
    // The turn ends with the subagent's call waiting for the user, who's still asked.
    let s = until(5, || async {
        let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
        (results(&s).len() == 1).then_some(s)
    })
    .await;
    assert_eq!(s["thread"]["status"], "waiting");
    assert_eq!(s["requests"].as_array().unwrap().len(), 1);
    let calls = items(&s, "tool_call");
    assert_eq!(
        (calls[0]["status"].clone(), calls[0]["subagent"].clone()),
        (
            json!("completed"),
            json!({"status": "running", "background": true, "agent_type": "general-purpose", "model": "mini-1"})
        )
    );
    assert_eq!(
        (calls[1]["status"].clone(), calls[1]["parent_id"].clone()),
        (json!("pending"), calls[0]["id"].clone())
    );

    let respond = json!({"type": "respond", "thread_id": t.id, "request_id": s["requests"][0]["id"], "resolution": {"outcome": "allow"}});
    env.sdk.handle_json(respond).await.unwrap();
    let s = until(5, || async {
        let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
        (results(&s).len() == 2 && s["thread"]["status"] == "idle").then_some(s)
    })
    .await;
    let calls = items(&s, "tool_call");
    assert_eq!(
        calls[0]["subagent"],
        json!({"status": "completed", "background": true, "agent_type": "general-purpose", "model": "mini-1", "activity": "Running true", "tool_uses": 1, "summary": "apple"})
    );
    assert_eq!(calls[1]["status"], "completed");
    // Claude's own turn has no message of the user's.
    let second = results(&s)[1]["turn_id"].clone();
    assert!(items(&s, "user_message").iter().all(|u| u["turn_id"] != second));
    assert_eq!(texts(&s).last().unwrap(), "the subagent said apple");
    assert!(
        env.runs()[0]
            .sent
            .iter()
            .any(|m| m["response"]["response"]["behavior"] == "allow")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn stops_a_runs_subagents_when_it_ends_and_cancels_what_they_were_doing() {
    let mut env = setup(Setup::default());
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, "background 60000 apple", SendOptions::default())
        .await
        .unwrap();
    until(5, || async {
        let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
        let calls = items(&s, "tool_call");
        (s["thread"]["status"] == "idle" && calls.len() == 2 && calls[1]["status"] == "running").then_some(())
    })
    .await;
    env.sdk.close(false).await.unwrap();
    let events = env.events_json();
    let patches: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "item.updated")
        .map(|e| &e["patch"])
        .collect();
    assert!(patches.iter().any(|p| p["subagent"]["status"] == "stopped"));
    assert!(patches.iter().any(|p| p["status"] == "cancelled"));
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_app_tools_with_the_threads_id_metadata_and_call() {
    let seen: Arc<Mutex<Option<ToolContext>>> = Arc::default();
    let s2 = seen.clone();
    let lookup = tool(
        "lookup",
        "Looks a thing up.",
        json!({"type": "object", "properties": {"id": {"type": "string"}}}),
        move |args, ctx| {
            *s2.lock().unwrap() = Some(ctx);
            let id = args["id"].as_str().unwrap_or("").to_string();
            async move { agent_threads::ToolOutput::text(format!("thing {id}")).with_structured(json!({"id": id})) }
        },
    );
    let env = setup(Setup::default());
    let mut metadata = serde_json::Map::new();
    metadata.insert("user".into(), json!("u1"));
    let o = CreateOptions {
        metadata,
        capabilities: Capabilities {
            tools: vec![lookup],
            ..Default::default()
        },
        ..create()
    };
    let t = env.sdk.create(o).await.unwrap();
    env.sdk
        .send(&t.id, r#"app lookup {"id":"7"}"#, SendOptions::default())
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(texts(&s), ["app said thing 7"]);
    let call = items(&s, "tool_call")[0].clone();
    assert_eq!(
        (
            call["name"].clone(),
            call["kind"].clone(),
            call["status"].clone(),
            call["result"]["content"].clone()
        ),
        (json!("lookup"), json!("app"), json!("completed"), json!("thing 7"))
    );
    // Its structured output, which Claude doesn't pass on, is in the call's result.
    assert_eq!(call["result"]["structured"], json!({"id": "7"}));
    let ctx = seen.lock().unwrap().clone().unwrap();
    assert_eq!(
        (ctx.thread_id, ctx.metadata["user"].clone(), ctx.tool_call_id),
        (t.id.clone(), json!("u1"), call["id"].as_str().map(String::from))
    );
    let init = env.runs()[0]
        .sent
        .iter()
        .find(|m| m["type"] == "control_request")
        .unwrap()
        .clone();
    assert_eq!(
        init["request"],
        json!({"subtype": "initialize", "sdkMcpServers": ["app"]})
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn fails_the_turn_when_claude_cant_be_started() {
    let env = setup(Setup {
        claude: ClaudeCodeOptions {
            bin: "/nonexistent/claude".into(),
            ..Default::default()
        },
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk.send(&t.id, "reply hi", SendOptions::default()).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(s["thread"]["status"], "error");
    assert!(s["thread"]["error"].as_str().unwrap().contains("couldn't be started"));
    assert_eq!(results(&s).len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn fails_the_turn_when_claude_exits_during_it_with_what_it_said_on_stderr() {
    let env = setup(Setup::default());
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk.send(&t.id, "crash", SendOptions::default()).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(s["thread"]["status"], "error");
    let error = s["thread"]["error"].as_str().unwrap();
    assert!(
        error.contains("exited with code 3") && error.contains("something broke"),
        "{error}"
    );
    assert!(s["thread"].get("run").is_none());
    // The next message starts a new process, which resumes the session.
    env.sdk
        .send(&t.id, "reply again", SendOptions::default())
        .await
        .unwrap();
    assert_eq!(settle(&env.sdk, &t.id).await["thread"]["status"], "idle");
}

#[tokio::test(flavor = "multi_thread")]
async fn stops_claude_when_an_interrupt_doesnt_end_the_turn() {
    let claude = ClaudeCodeOptions {
        stop_grace: Duration::from_millis(100),
        close_grace: Duration::from_millis(100),
        ..Default::default()
    };
    let env = setup(Setup {
        claude,
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk.send(&t.id, "stubborn", SendOptions::default()).await.unwrap();
    until(5, || async {
        env.sdk.snapshot(&t.id).await.unwrap().thread.session_id.map(|_| ())
    })
    .await;
    env.sdk.interrupt(&t.id).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(s["thread"]["status"], "idle");
    let r = results(&s);
    assert_eq!(r.len(), 1);
    assert_eq!(
        (r[0]["ok"].clone(), r[0]["interrupted"].clone()),
        (json!(false), json!(true))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn restarts_claude_with_new_options_for_the_next_turn() {
    let env = setup(Setup::default());
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
    let cmd = json!({"type": "set_options", "thread_id": t.id, "model": "b", "permission_mode": "accept_edits", "effort": "high"});
    env.sdk.handle_json(cmd).await.unwrap();
    let thread = env.sdk.snapshot(&t.id).await.unwrap().thread;
    assert_eq!(
        (thread.model.as_deref(), thread.effort.as_deref()),
        (Some("b"), Some("high"))
    );
    env.sdk.send(&t.id, "reply two", SendOptions::default()).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    let runs = env.runs();
    let argv = &runs[1].argv;
    assert!(
        has(argv, "--model", "b") && has(argv, "--permission-mode", "acceptEdits") && has(argv, "--effort", "high")
    );
    assert!(has(argv, "--resume", s["thread"]["session_id"].as_str().unwrap()));
}

#[tokio::test(flavor = "multi_thread")]
async fn passes_skills_mcp_servers_and_the_system_prompt_isolated_from_the_users_config() {
    let skill_dir = common::temp_dir().join("support");
    std::fs::create_dir(&skill_dir).unwrap();
    std::fs::write(skill_dir.join("SKILL.md"), "---\nname: support\n---\nBe kind.").unwrap();
    let all = Capabilities {
        permissions: Some(PermissionPolicy::allow()),
        skills: vec![Skill::Dir(skill_dir)],
        mcp_servers: [("docs".to_string(), McpServer::http("https://example.com/mcp"))].into(),
        system_prompt: Some("You help.".into()),
        ..Default::default()
    };
    let env = setup(Setup {
        capabilities: all,
        ..Default::default()
    });
    let own = Capabilities {
        skills: vec![Skill::Inline {
            name: "greet".into(),
            content: "Say hi.".into(),
        }],
        mcp_servers: [("echo".to_string(), McpServer::stdio("node", ["echo.mjs"]))].into(),
        ..Default::default()
    };
    let t = env
        .sdk
        .create(CreateOptions {
            capabilities: own,
            ..create()
        })
        .await
        .unwrap();
    env.sdk.send(&t.id, "reply hi", SendOptions::default()).await.unwrap();
    settle(&env.sdk, &t.id).await;
    let argv = env.runs()[0].argv.clone();
    let flag = |name: &str| argv[argv.iter().position(|a| a == name).unwrap() + 1].clone();
    // A plugin, which Claude finds even with --setting-sources "", that was there while it ran.
    assert!(flag("--plugin-dir").contains("plugin-"));
    let mcp: Value = serde_json::from_str(&flag("--mcp-config")).unwrap();
    assert_eq!(
        mcp["mcpServers"]["docs"],
        json!({"type": "http", "url": "https://example.com/mcp"})
    );
    assert_eq!(
        mcp["mcpServers"]["echo"],
        json!({"type": "stdio", "command": "node", "args": ["echo.mjs"]})
    );
    assert_eq!(flag("--append-system-prompt"), "You help.");
    assert!(contains_all(&argv, &["--setting-sources", "", "--strict-mcp-config"]));
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_a_malformed_command_before_it_changes_anything() {
    let mut env = setup(Setup {
        capabilities: Capabilities {
            permissions: Some(PermissionPolicy::ask()),
            ..Default::default()
        },
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, r#"tool Bash {"command":"ls"}"#, SendOptions::default())
        .await
        .unwrap();
    let r = until(5, || async {
        env.sdk.snapshot(&t.id).await.unwrap().requests.first().cloned()
    })
    .await;
    let request_id = r.id().to_string();
    let before = (
        serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap(),
        env.events().len(),
        env.runs().len(),
    );
    let id = &t.id;
    let bad = [
        json!({"type": "send", "thread_id": id, "text": "hi", "attachments": [{"kind": "video"}]}),
        json!({"type": "send", "thread_id": id, "text": "hi", "attachments": [{"kind": "file", "data": "not base64!"}]}),
        json!({"type": "send", "thread_id": id, "text": "hi", "attachments": "a.txt"}),
        json!({"type": "send", "thread_id": id, "text": "hi", "client_id": 5}),
        json!({"type": "send", "thread_id": id, "text": 7}),
        json!({"type": "respond", "thread_id": id, "request_id": request_id, "resolution": {"outcome": "answer", "answers": {"q": "Blue"}}}),
        json!({"type": "respond", "thread_id": id, "request_id": request_id, "resolution": {"outcome": "yes"}}),
        json!({"type": "respond", "thread_id": id, "request_id": request_id, "resolution": {"outcome": "allow", "always": "please"}}),
        json!({"type": "respond", "thread_id": id, "request_id": request_id}),
        json!({"type": "set_options", "thread_id": id, "permission_mode": "yolo"}),
        json!({"type": "set_options", "thread_id": id, "model": 4}),
        json!({"type": "set_options", "thread_id": id, "model": "fine", "effort": ["high"]}),
        json!({"type": "interrupt", "thread_id": 1}),
        json!({"type": "dance", "thread_id": id}),
        json!("send"),
        Value::Null,
    ];
    for command in bad {
        let r = env.sdk.handle_json(command.clone()).await;
        assert!(matches!(r, Err(Error::Command(_))), "{command}: {r:?}");
    }
    let after = (
        serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap(),
        env.events().len(),
        env.runs().len(),
    );
    assert_eq!(after, before);
    // The request is still open, and a valid answer to it works.
    env.sdk
        .handle_json(
            json!({"type": "respond", "thread_id": id, "request_id": request_id, "resolution": {"outcome": "allow"}}),
        )
        .await
        .unwrap();
    assert_eq!(settle(&env.sdk, &t.id).await["thread"]["status"], "idle");
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_commands_after_close() {
    let env = setup(Setup::default());
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk.close(false).await.unwrap();
    let sdk = &env.sdk;
    let id = t.id.as_str();
    assert!(matches!(sdk.snapshot(id).await, Err(Error::Command(_))));
    assert!(matches!(
        sdk.send(id, "hi", SendOptions::default()).await,
        Err(Error::Command(_))
    ));
    assert!(matches!(sdk.interrupt(id).await, Err(Error::Command(_))));
    assert!(matches!(
        sdk.set_options(id, ThreadOptions::default()).await,
        Err(Error::Command(_))
    ));
    assert!(matches!(
        sdk.handle_json(json!({"type": "interrupt", "thread_id": id})).await,
        Err(Error::Command(_))
    ));
    assert!(matches!(
        sdk.configure(id, Capabilities::default()).await,
        Err(Error::Command(_))
    ));
    assert!(matches!(sdk.delete(id).await, Err(Error::Command(_))));
    assert!(matches!(sdk.create(create()).await, Err(Error::Command(_))));
    // Reading the store still works.
    assert_eq!(sdk.get(id).await.unwrap().unwrap().id, t.id);
    assert_eq!(sdk.events_since(id, 0, None).await.unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_commands_it_cant_carry_out() {
    let env = setup(Setup::default());
    assert!(matches!(
        env.sdk
            .handle_json(json!({"type": "send", "thread_id": "nope", "text": "hi"}))
            .await,
        Err(Error::Command(_))
    ));
    let r = env
        .sdk
        .create(CreateOptions {
            harness: Some("codex".into()),
            ..create()
        })
        .await;
    assert!(
        matches!(&r, Err(Error::Command(m)) if m.contains("no harness")),
        "{:?}",
        r.err()
    );
}

async fn saves_events_and_picks_a_thread_up_again(store: Arc<dyn Store>) {
    let mut env = setup(Setup {
        store: Some(store.clone()),
        ..Default::default()
    });
    let t = env
        .sdk
        .create(CreateOptions {
            title: Some("kept".into()),
            ..create()
        })
        .await
        .unwrap();
    env.sdk.send(&t.id, "reply one", SendOptions::default()).await.unwrap();
    settle(&env.sdk, &t.id).await;
    let saved: Vec<Value> = env.events_json().into_iter().filter(|e| e["type"] != "delta").collect();
    let since: Vec<Value> = env
        .sdk
        .events_since(&t.id, 0, None)
        .await
        .unwrap()
        .iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect();
    assert_eq!(since, saved);
    let tail: Vec<Value> = env
        .sdk
        .events_since(&t.id, saved.len() as u64 - 2, None)
        .await
        .unwrap()
        .iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect();
    assert_eq!(tail, saved[saved.len() - 2..]);
    env.sdk.close(false).await.unwrap();
    // Everything it sent, folded, which a new instance must load from the store.
    let mut before = agent_threads::reducer::initial_state(t.clone());
    agent_threads::reducer::apply_events(&mut before, env.events());
    let again = env.make(store);
    assert_eq!(
        serde_json::to_value(again.snapshot(&t.id).await.unwrap()).unwrap(),
        serde_json::to_value(&before).unwrap()
    );
    assert!(before.thread.run.is_none());
    again.send(&t.id, "reply two", SendOptions::default()).await.unwrap();
    assert_eq!(texts(&settle(&again, &t.id).await), ["one", "two"]);
    assert_eq!(
        again
            .list()
            .await
            .unwrap()
            .iter()
            .map(|t| t.title.clone().unwrap())
            .collect::<Vec<_>>(),
        ["kept"]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn on_a_file_store_saves_events_and_picks_a_thread_up_again_after_a_restart() {
    saves_events_and_picks_a_thread_up_again(Arc::new(FileStore::open(common::temp_dir()).unwrap())).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn on_a_sqlite_store_saves_events_and_picks_a_thread_up_again_after_a_restart() {
    saves_events_and_picks_a_thread_up_again(Arc::new(SqliteStore::open(common::temp_dir().join("t.db")).unwrap()))
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn ends_a_turn_that_was_running_when_the_backend_stopped() {
    let state = MemoryState::new();
    let env = setup(Setup {
        store: Some(Arc::new(MemoryStore::with_state(state.clone()))),
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk.send(&t.id, "slow", SendOptions::default()).await.unwrap();
    until(5, || async {
        env.sdk.snapshot(&t.id).await.unwrap().thread.session_id.map(|_| ())
    })
    .await;
    env.sdk.events_since(&t.id, 0, None).await.unwrap(); // saved
    // As if the backend died: nothing is closed, and the thread is left running in the store.
    let crashed = MemoryStore::new();
    copy_store(&MemoryStore::with_state(state), &crashed, &t.id).await;
    env.sdk.close(false).await.unwrap();

    let again = env.make(Arc::new(crashed));
    let s = serde_json::to_value(again.snapshot(&t.id).await.unwrap()).unwrap();
    assert_eq!(s["thread"]["status"], "error");
    assert!(s["thread"]["error"].as_str().unwrap().contains("stopped"));
    assert!(s["thread"].get("run").is_none());
    let r = results(&s);
    assert_eq!(r.len(), 1);
    assert_eq!(r[0]["ok"], false);
}

async fn copy_store(from: &MemoryStore, to: &MemoryStore, id: &str) {
    to.create_thread(&from.get_thread(id).await.unwrap().unwrap())
        .await
        .unwrap();
    let events = from.read_events(id, 0, None).await.unwrap();
    to.append_events(id, &events, &[]).await.unwrap();
}

/// A store whose appends fail when it's told to.
struct Flaky {
    inner: MemoryStore,
    /// Each append's fate, in order: Ok(true) fails it, Ok(false) lets it through, Err fails it
    /// after it happened.
    plan: Mutex<Vec<Result<bool, ()>>>,
    broken: std::sync::atomic::AtomicBool,
    /// get_run fails.
    runs_broken: std::sync::atomic::AtomicBool,
}

#[async_trait]
impl Store for Flaky {
    async fn create_thread(&self, t: &Value) -> StoreResult<()> {
        self.inner.create_thread(t).await
    }
    async fn get_thread(&self, id: &str) -> StoreResult<Option<Value>> {
        self.inner.get_thread(id).await
    }
    async fn list_threads(&self) -> StoreResult<Vec<Value>> {
        self.inner.list_threads().await
    }
    async fn update_thread(&self, t: &Value) -> StoreResult<()> {
        self.inner.update_thread(t).await
    }
    async fn delete_thread(&self, id: &str) -> StoreResult<bool> {
        self.inner.delete_thread(id).await
    }
    async fn append_events(&self, id: &str, events: &[Value], runs: &[RunRecord]) -> StoreResult<()> {
        if self.broken.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(StoreError::failed("the disk is full"));
        }
        let fate = {
            let mut plan = self.plan.lock().unwrap();
            if plan.is_empty() { Ok(false) } else { plan.remove(0) }
        };
        match fate {
            Ok(true) => Err(StoreError::failed("the disk is full")),
            Ok(false) => self.inner.append_events(id, events, runs).await,
            Err(()) => {
                self.inner.append_events(id, events, runs).await?;
                Err(StoreError::failed("timed out (but it happened)"))
            }
        }
    }
    async fn read_events(&self, id: &str, after: u64, limit: Option<usize>) -> StoreResult<Vec<Value>> {
        self.inner.read_events(id, after, limit).await
    }
    async fn last_seq(&self, id: &str) -> StoreResult<u64> {
        self.inner.last_seq(id).await
    }
    async fn save_snapshot(&self, id: &str, s: &Value) -> StoreResult<()> {
        self.inner.save_snapshot(id, s).await
    }
    async fn load_snapshot(&self, id: &str) -> StoreResult<Option<Value>> {
        self.inner.load_snapshot(id).await
    }
    async fn put_run(&self, r: &RunRecord) -> StoreResult<()> {
        self.inner.put_run(r).await
    }
    async fn get_run(&self, id: &str) -> StoreResult<Option<RunRecord>> {
        if self.runs_broken.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(StoreError::failed("the database is locked"));
        }
        self.inner.get_run(id).await
    }
    async fn active_runs(&self) -> StoreResult<Vec<RunRecord>> {
        self.inner.active_runs().await
    }
}

fn flaky(plan: Vec<Result<bool, ()>>) -> Arc<Flaky> {
    Arc::new(Flaky {
        inner: MemoryStore::new(),
        plan: Mutex::new(plan),
        broken: Default::default(),
        runs_broken: Default::default(),
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_events_a_store_failed_to_append_and_saves_them_in_order_once_it_can() {
    // The second append fails; the third is written but reported as failed.
    let store = flaky(vec![Ok(false), Ok(true), Err(())]);
    let mut env = setup(Setup {
        store: Some(store.clone()),
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk.send(&t.id, "reply one", SendOptions::default()).await.unwrap();
    settle(&env.sdk, &t.id).await;
    let saved: Vec<Value> = env.events_json().into_iter().filter(|e| e["type"] != "delta").collect();
    let n = saved.len() as u64;
    let inner = store.inner.clone();
    until(10, || async {
        (inner.last_seq(&t.id).await.unwrap() == n).then_some(())
    })
    .await;
    assert_eq!(store.inner.read_events(&t.id, 0, None).await.unwrap(), saved);
    assert!(env.setup.errors.lock().unwrap().len() >= 2);
    env.sdk.close(false).await.unwrap();
    // The snapshot is never ahead of the events.
    let snap = store.inner.load_snapshot(&t.id).await.unwrap().unwrap();
    assert_eq!(
        snap["seq"].as_u64().unwrap(),
        store.inner.last_seq(&t.id).await.unwrap()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn fails_close_while_events_cant_be_saved_and_saves_them_when_its_called_again() {
    let store = flaky(Vec::new());
    let env = setup(Setup {
        store: Some(store.clone()),
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    store.broken.store(true, std::sync::atomic::Ordering::SeqCst);
    env.sdk
        .set_options(
            &t.id,
            ThreadOptions {
                model: Some("unsaved-model".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(env.sdk.close(false).await.is_err());
    assert_eq!(store.inner.last_seq(&t.id).await.unwrap(), 1);
    assert!(matches!(
        env.sdk.send(&t.id, "reply hi", SendOptions::default()).await,
        Err(Error::Command(_))
    ));
    store.broken.store(false, std::sync::atomic::Ordering::SeqCst);
    env.sdk.close(false).await.unwrap();
    let again = env.make(Arc::new(MemoryStore::with_state(store.inner.state.clone())));
    assert_eq!(
        again.snapshot(&t.id).await.unwrap().thread.model.as_deref(),
        Some("unsaved-model")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn fails_events_since_while_the_store_cant_take_the_threads_events() {
    let store = flaky(Vec::new());
    let env = setup(Setup {
        store: Some(store.clone()),
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    store.broken.store(true, std::sync::atomic::Ordering::SeqCst);
    env.sdk
        .set_options(
            &t.id,
            ThreadOptions {
                model: Some("other".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let r = env.sdk.events_since(&t.id, 0, None).await;
    assert!(
        r.as_ref().is_err_and(|e| e.to_string().contains("disk is full")),
        "{r:?}"
    );
    store.broken.store(false, std::sync::atomic::Ordering::SeqCst);
    // Saved by the retry, after its backoff.
    let seqs = until(5, || async {
        let seqs: Vec<u64> = env
            .sdk
            .events_since(&t.id, 0, None)
            .await
            .ok()?
            .iter()
            .map(|e| e.seq())
            .collect();
        Some(seqs)
    })
    .await;
    assert_eq!(seqs, [1, 2]);
}

#[tokio::test(flavor = "multi_thread")]
async fn deletes_a_thread() {
    let env = setup(Setup::default());
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk.send(&t.id, "reply hi", SendOptions::default()).await.unwrap();
    settle(&env.sdk, &t.id).await;
    assert!(env.sdk.delete(&t.id).await.unwrap());
    assert!(env.sdk.get(&t.id).await.unwrap().is_none());
    assert!(matches!(env.sdk.snapshot(&t.id).await, Err(Error::Command(_))));
}

#[tokio::test(flavor = "multi_thread")]
async fn denies_when_an_async_policy_panics_making_its_future_and_the_thread_carries_on() {
    #[allow(unreachable_code)]
    let policy = PermissionPolicy::from_async(|_, _| {
        panic!("policy factory failure");
        async { PermissionDecision::Allow }
    });
    let env = setup(Setup {
        capabilities: Capabilities {
            permissions: Some(policy),
            ..Default::default()
        },
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, "tool Bash {}", SendOptions::default())
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(s["thread"]["status"], "idle");
    let said = texts(&s).join("\n");
    assert!(
        said.contains("The permission policy failed: policy factory failure"),
        "{said}"
    );
    assert_eq!(items(&s, "tool_call")[0]["status"], "denied");
    // The thread is still there, and saves.
    env.sdk
        .send(&t.id, "reply still here", SendOptions::default())
        .await
        .unwrap();
    assert_eq!(texts(&settle(&env.sdk, &t.id).await).last().unwrap(), "still here");
    env.sdk.close(true).await.unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn writes_attached_files_where_only_the_user_can_read_them() {
    use base64::Engine;
    use std::os::unix::fs::PermissionsExt;
    let env = setup(Setup::default());
    let t = env.sdk.create(create()).await.unwrap();
    let data = base64::engine::general_purpose::STANDARD.encode(b"\x00\x01secret");
    let attachment = serde_json::from_value(
        json!({"kind": "file", "name": "private.bin", "media_type": "application/octet-stream", "data": data}),
    )
    .unwrap();
    env.sdk
        .send(
            &t.id,
            "reply got it",
            SendOptions {
                attachments: vec![attachment],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    settle(&env.sdk, &t.id).await;
    // What Claude was told: where the file is.
    let runs = env.runs();
    let told = runs[0]
        .sent
        .iter()
        .filter(|m| m["type"] == "user")
        .flat_map(|m| m["message"]["content"].as_array().cloned().unwrap_or_default())
        .filter_map(|b| b["text"].as_str().map(String::from))
        .find(|t| t.starts_with("Attached file private.bin"))
        .unwrap();
    let path = std::path::PathBuf::from(told.rsplit(": ").next().unwrap());
    assert_eq!(std::fs::read(&path).unwrap(), b"\x00\x01secret");
    let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&path) & 0o077, 0, "{}", path.display());
    let private = path
        .ancestors()
        .find(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("agent-threads_"))
        })
        .unwrap();
    assert_eq!(mode(private), 0o700, "{}", private.display());
}

#[tokio::test(flavor = "multi_thread")]
async fn configure_changes_only_what_its_given() {
    use agent_threads::CapabilitiesUpdate;
    let lookup = tool("lookup", "Looks up.", json!({"type": "object"}), |_, _| async {
        "found it"
    });
    let env = setup(Setup::default());
    let own = Capabilities {
        tools: vec![lookup],
        ..Default::default()
    };
    let t = env
        .sdk
        .create(CreateOptions {
            capabilities: own,
            ..create()
        })
        .await
        .unwrap();
    // Only the policy: the thread keeps its tool.
    let policy = CapabilitiesUpdate {
        permissions: Some(PermissionPolicy::allow()),
        ..Default::default()
    };
    env.sdk.configure(&t.id, policy).await.unwrap();
    env.sdk
        .send(&t.id, "app lookup {}", SendOptions::default())
        .await
        .unwrap();
    assert_eq!(
        texts(&settle(&env.sdk, &t.id).await).last().unwrap(),
        "app said found it"
    );

    // A thread's own deny policy stays when something else changes, though the instance's allows.
    let deny = CapabilitiesUpdate {
        permissions: Some(PermissionPolicy::deny()),
        ..Default::default()
    };
    env.sdk.configure(&t.id, deny).await.unwrap();
    let prompt = CapabilitiesUpdate {
        system_prompt: Some("Be brief.".into()),
        tools: Some(vec![]),
        ..Default::default()
    };
    env.sdk.configure(&t.id, prompt).await.unwrap();
    env.sdk
        .send(&t.id, "tool Bash {}", SendOptions::default())
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(items(&s, "tool_call").last().unwrap()["status"], "denied");
    // And the tools given (none) replaced the thread's.
    env.sdk
        .send(&t.id, "app lookup {}", SendOptions::default())
        .await
        .unwrap();
    assert!(
        texts(&settle(&env.sdk, &t.id).await)
            .last()
            .unwrap()
            .contains("no tool lookup")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_commands_for_a_thread_being_deleted_and_leaves_nothing_behind() {
    let claude = ClaudeCodeOptions {
        close_grace: Duration::from_millis(500),
        ..Default::default()
    };
    let env = setup(Setup {
        claude,
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk.send(&t.id, "stubborn", SendOptions::default()).await.unwrap();
    until(5, || async {
        env.sdk.snapshot(&t.id).await.unwrap().thread.session_id.map(|_| ())
    })
    .await;
    // Claude doesn't stop at its input closing, so deleting takes the close grace.
    let (sdk, id) = (env.sdk.clone(), t.id.clone());
    let deleting = tokio::spawn(async move { sdk.delete(&id).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let sent = env.sdk.send(&t.id, "reply resurrected", SendOptions::default()).await;
    assert!(matches!(sent, Err(Error::Command(_))), "{sent:?}");
    assert!(matches!(env.sdk.snapshot(&t.id).await, Err(Error::Command(_))));
    assert!(deleting.await.unwrap().unwrap());
    assert!(env.sdk.get(&t.id).await.unwrap().is_none());
    assert!(matches!(env.sdk.snapshot(&t.id).await, Err(Error::Command(_))));
    assert_eq!(env.runs().len(), 1);
    env.sdk.close(true).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_store_that_cant_say_whether_a_thread_has_a_run_loads_nothing() {
    let store = flaky(Vec::new());
    // A thread left running under the shim by a backend before this one.
    let thread = json!({"id": "th_1", "harness": "claude", "status": "running", "permission_mode": "default",
        "created_at": "2026-11-01T00:00:00Z", "run": {"id": "run_1", "spawner": "shim"}});
    store.inner.create_thread(&thread).await.unwrap();
    let events = [
        json!({"type": "thread.updated", "thread_id": "th_1", "seq": 1, "thread": thread}),
        json!({"type": "turn.started", "thread_id": "th_1", "seq": 2, "turn_id": "t1"}),
    ];
    store.inner.append_events("th_1", &events, &[]).await.unwrap();
    store.runs_broken.store(true, std::sync::atomic::Ordering::SeqCst);
    let env = setup(Setup {
        store: Some(store.clone()),
        ..Default::default()
    });
    let r = env.sdk.snapshot("th_1").await;
    assert!(matches!(&r, Err(Error::Store(_))), "{:?}", r.err());
    // Nothing was made of it: its turn isn't ended as lost, and it isn't loaded.
    assert_eq!(store.inner.last_seq("th_1").await.unwrap(), 2);
    assert!(matches!(
        env.sdk.send("th_1", "reply hi", SendOptions::default()).await,
        Err(Error::Store(_))
    ));
    assert_eq!(store.inner.last_seq("th_1").await.unwrap(), 2);
    // Once it can, the thread loads (its run, which no store has, is lost).
    store.runs_broken.store(false, std::sync::atomic::Ordering::SeqCst);
    let s = env.sdk.snapshot("th_1").await.unwrap();
    assert_eq!(s.thread.status, agent_threads::protocol::ThreadStatus::Error);
}

/// A thread whose turn ignores its process's input closing, so deleting it takes the close grace.
async fn stubborn_thread(env: &Env) -> String {
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk.send(&t.id, "stubborn", SendOptions::default()).await.unwrap();
    until(5, || async {
        env.sdk.snapshot(&t.id).await.unwrap().thread.session_id.map(|_| ())
    })
    .await;
    t.id
}

#[tokio::test(flavor = "multi_thread")]
async fn a_deletion_finishes_though_its_caller_stops_waiting_and_a_retry_joins_it() {
    let claude = ClaudeCodeOptions {
        close_grace: Duration::from_millis(500),
        ..Default::default()
    };
    let env = setup(Setup {
        claude,
        ..Default::default()
    });
    let id = stubborn_thread(&env).await;
    let (sdk, i) = (env.sdk.clone(), id.clone());
    let first = tokio::spawn(async move { sdk.delete(&i).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    // The caller gives up mid-close.
    first.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    // Still being deleted: commands and configure are refused, and a retry waits for the same one.
    assert!(matches!(env.sdk.snapshot(&id).await, Err(Error::Command(m)) if m.contains("being deleted")));
    let configure = env.sdk.configure(&id, Capabilities::default()).await;
    assert!(
        matches!(&configure, Err(Error::Command(m)) if m.contains("being deleted")),
        "{configure:?}"
    );
    assert!(
        env.sdk.delete(&id).await.unwrap(),
        "the retry joins the deletion that has the thread"
    );
    // Gone, with nothing left behind: no actor, no mark, no new run.
    assert!(env.sdk.get(&id).await.unwrap().is_none());
    assert!(matches!(env.sdk.snapshot(&id).await, Err(Error::Command(m)) if m.contains("there's no thread")));
    assert!(!env.sdk.delete(&id).await.unwrap());
    assert_eq!(env.runs().len(), 1);
    env.sdk.close(true).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_aborted_deletion_still_deletes_the_thread() {
    let claude = ClaudeCodeOptions {
        close_grace: Duration::from_millis(300),
        ..Default::default()
    };
    let env = setup(Setup {
        claude,
        ..Default::default()
    });
    let id = stubborn_thread(&env).await;
    let (sdk, i) = (env.sdk.clone(), id.clone());
    let first = tokio::spawn(async move { sdk.delete(&i).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    first.abort();
    // Eventually gone, and not stuck "being deleted".
    until(10, || async {
        match env.sdk.snapshot(&id).await {
            Err(Error::Command(m)) if m.contains("there's no thread") => Some(()),
            _ => None,
        }
    })
    .await;
    assert!(env.sdk.store().get_thread(&id).await.unwrap().is_none());
    env.sdk.close(true).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn close_waits_for_a_deletion_under_way() {
    let claude = ClaudeCodeOptions {
        close_grace: Duration::from_millis(300),
        ..Default::default()
    };
    let env = setup(Setup {
        claude,
        ..Default::default()
    });
    let id = stubborn_thread(&env).await;
    let (sdk, i) = (env.sdk.clone(), id.clone());
    let deleting = tokio::spawn(async move { sdk.delete(&i).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    env.sdk.close(true).await.unwrap();
    assert!(env.sdk.store().get_thread(&id).await.unwrap().is_none());
    assert!(deleting.await.unwrap().unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_close_cut_short_mid_grace_finishes_and_a_retry_saves_the_interrupted_turn() {
    let claude = ClaudeCodeOptions {
        close_grace: Duration::from_millis(500),
        ..Default::default()
    };
    let env = setup(Setup {
        claude,
        ..Default::default()
    });
    let id = stubborn_thread(&env).await;
    let sdk = env.sdk.clone();
    let first = tokio::spawn(async move { sdk.close(true).await });
    // The caller gives up while Claude, which doesn't stop at its input closing, has its grace.
    tokio::time::sleep(Duration::from_millis(100)).await;
    first.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    // Commands are refused from the moment close() started.
    assert!(matches!(
        env.sdk.send(&id, "reply hi", SendOptions::default()).await,
        Err(Error::Command(_))
    ));
    env.sdk.close(true).await.unwrap();
    // The harness was stopped, and the turn it cut short is saved as interrupted, with the thread
    // idle and its run gone.
    let events: Vec<Value> = env
        .sdk
        .events_since(&id, 0, None)
        .await
        .unwrap()
        .iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect();
    let result = events
        .iter()
        .rev()
        .find(|e| e["type"] == "item.added" && e["item"]["type"] == "turn_result")
        .unwrap();
    assert_eq!(result["item"]["interrupted"], true);
    let thread = &events.iter().rev().find(|e| e["type"] == "thread.updated").unwrap()["thread"];
    assert_eq!(thread["status"], "idle");
    assert!(thread.get("run").is_none());
    assert!(events.iter().any(|e| e["type"] == "turn.completed"));
    // Closing again is fine.
    env.sdk.close(true).await.unwrap();
}

/// A store that holds up loading one thread (its get_thread) until it's let go, and counts its
/// loads; or (`runs`) holds up every get_run, which loading a thread with a run asks once it has
/// made the thread's actor.
struct Gated {
    inner: MemoryStore,
    id: String,
    runs: bool,
    open: tokio::sync::watch::Sender<bool>,
    loads: std::sync::atomic::AtomicUsize,
}

impl Gated {
    fn new(inner: MemoryStore, id: &str) -> Arc<Self> {
        Arc::new(Gated {
            inner,
            id: id.into(),
            runs: false,
            open: tokio::sync::watch::channel(false).0,
            loads: Default::default(),
        })
    }

    fn runs(inner: MemoryStore) -> Arc<Self> {
        Arc::new(Gated {
            inner,
            id: String::new(),
            runs: true,
            open: tokio::sync::watch::channel(false).0,
            loads: Default::default(),
        })
    }

    async fn gate(&self) {
        self.loads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _ = self.open.subscribe().wait_for(|open| *open).await;
    }

    fn loads(&self) -> usize {
        self.loads.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[async_trait]
impl Store for Gated {
    async fn create_thread(&self, t: &Value) -> StoreResult<()> {
        self.inner.create_thread(t).await
    }
    async fn get_thread(&self, id: &str) -> StoreResult<Option<Value>> {
        if !self.runs && id == self.id {
            self.gate().await;
        }
        self.inner.get_thread(id).await
    }
    async fn list_threads(&self) -> StoreResult<Vec<Value>> {
        self.inner.list_threads().await
    }
    async fn update_thread(&self, t: &Value) -> StoreResult<()> {
        self.inner.update_thread(t).await
    }
    async fn delete_thread(&self, id: &str) -> StoreResult<bool> {
        self.inner.delete_thread(id).await
    }
    async fn append_events(&self, id: &str, events: &[Value], runs: &[RunRecord]) -> StoreResult<()> {
        self.inner.append_events(id, events, runs).await
    }
    async fn read_events(&self, id: &str, after: u64, limit: Option<usize>) -> StoreResult<Vec<Value>> {
        self.inner.read_events(id, after, limit).await
    }
    async fn last_seq(&self, id: &str) -> StoreResult<u64> {
        self.inner.last_seq(id).await
    }
    async fn save_snapshot(&self, id: &str, s: &Value) -> StoreResult<()> {
        self.inner.save_snapshot(id, s).await
    }
    async fn load_snapshot(&self, id: &str) -> StoreResult<Option<Value>> {
        self.inner.load_snapshot(id).await
    }
    async fn put_run(&self, r: &RunRecord) -> StoreResult<()> {
        self.inner.put_run(r).await
    }
    async fn get_run(&self, id: &str) -> StoreResult<Option<RunRecord>> {
        if self.runs {
            self.gate().await;
        }
        self.inner.get_run(id).await
    }
    async fn active_runs(&self) -> StoreResult<Vec<RunRecord>> {
        self.inner.active_runs().await
    }
}

/// Two threads made by a backend before, and a new backend whose store holds up loading the first.
async fn gated() -> (Env, AgentThreads, Arc<Gated>, String, String) {
    let env = setup(Setup::default());
    let (a, b) = (
        env.sdk.create(create()).await.unwrap(),
        env.sdk.create(create()).await.unwrap(),
    );
    env.sdk.close(false).await.unwrap();
    let state = env.sdk.store().clone();
    let inner = MemoryStore::new();
    for id in [&a.id, &b.id] {
        inner
            .create_thread(&state.get_thread(id).await.unwrap().unwrap())
            .await
            .unwrap();
        let events = state.read_events(id, 0, None).await.unwrap();
        inner.append_events(id, &events, &[]).await.unwrap();
    }
    let store = Gated::new(inner, &a.id);
    let sdk = env.make(store.clone());
    (env, sdk, store, a.id, b.id)
}

#[tokio::test(flavor = "multi_thread")]
async fn loads_each_thread_on_its_own_and_a_thread_once_however_many_ask() {
    let (_env, sdk, store, a, b) = gated().await;
    let first = tokio::spawn({
        let (sdk, a) = (sdk.clone(), a.clone());
        async move { sdk.snapshot(&a).await }
    });
    let second = tokio::spawn({
        let (sdk, a) = (sdk.clone(), a.clone());
        async move { sdk.snapshot(&a).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    // The other thread's commands don't wait for the slow load.
    let other = tokio::time::timeout(Duration::from_secs(2), sdk.snapshot(&b)).await;
    assert_eq!(other.expect("it isn't held up").unwrap().thread.id, b);
    sdk.send(&b, "reply hi", SendOptions::default()).await.unwrap();
    assert!(!first.is_finished() && !second.is_finished());
    store.open.send_replace(true);
    assert_eq!(first.await.unwrap().unwrap().thread.id, a);
    assert_eq!(second.await.unwrap().unwrap().thread.id, a);
    assert_eq!(store.loads(), 1, "the second waited for the first's load");
    settle(&sdk, &b).await;
    sdk.close(true).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_deletion_waits_for_a_load_under_way_and_the_load_comes_to_nothing() {
    let (_env, sdk, store, a, _) = gated().await;
    let loading = tokio::spawn({
        let (sdk, a) = (sdk.clone(), a.clone());
        async move { sdk.snapshot(&a).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let deleting = tokio::spawn({
        let (sdk, a) = (sdk.clone(), a.clone());
        async move { sdk.delete(&a).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let sent = sdk.send(&a, "reply hi", SendOptions::default()).await;
    assert!(
        matches!(&sent, Err(Error::Command(m)) if m.contains("being deleted")),
        "{sent:?}"
    );
    assert!(!deleting.is_finished());
    store.open.send_replace(true);
    let loaded = loading.await.unwrap();
    assert!(
        matches!(&loaded, Err(Error::Command(m)) if m.contains("being deleted")),
        "{:?}",
        loaded.err()
    );
    assert!(deleting.await.unwrap().unwrap());
    assert!(sdk.get(&a).await.unwrap().is_none());
    assert!(matches!(sdk.snapshot(&a).await, Err(Error::Command(m)) if m.contains("there's no thread")));
    assert_eq!(
        store.loads(),
        3,
        "the snapshot's load, then get() and a snapshot that found it gone"
    );
    sdk.close(true).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn close_waits_for_a_load_under_way_and_refuses_loads_after_it() {
    let (_env, sdk, store, a, b) = gated().await;
    let loading = tokio::spawn({
        let (sdk, a) = (sdk.clone(), a.clone());
        async move { sdk.snapshot(&a).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let closing = tokio::spawn({
        let sdk = sdk.clone();
        async move { sdk.close(false).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!closing.is_finished(), "close() waits for the load");
    assert!(matches!(sdk.snapshot(&b).await, Err(Error::Command(m)) if m.contains("closed")));
    store.open.send_replace(true);
    closing.await.unwrap().unwrap();
    // Loaded, but the AgentThreads closed meanwhile.
    let loaded = loading.await.unwrap();
    assert!(
        matches!(&loaded, Err(Error::Command(m)) if m.contains("closed")),
        "{:?}",
        loaded.err()
    );
    // close() saved the thread it loaded, and let it go.
    assert!(store.inner.load_snapshot(&a).await.unwrap().is_some());
    assert!(store.inner.load_snapshot(&b).await.unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_thread_configured_while_its_being_loaded_has_the_new_configuration() {
    // A thread left with a run by a backend before this one: loading it looks the run up after
    // making its actor.
    let thread = json!({"id": "th_1", "harness": "claude", "status": "idle", "permission_mode": "default",
        "cwd": common::temp_dir(), "created_at": "2026-11-01T00:00:00Z", "run": {"id": "run_1", "spawner": "shim"}});
    let inner = MemoryStore::new();
    inner.create_thread(&thread).await.unwrap();
    let events = [json!({"type": "thread.updated", "thread_id": "th_1", "seq": 1, "thread": thread})];
    inner.append_events("th_1", &events, &[]).await.unwrap();
    let store = Gated::runs(inner);
    let env = setup(Setup {
        store: Some(store.clone()),
        ..Default::default()
    });
    let loading = tokio::spawn({
        let sdk = env.sdk.clone();
        async move { sdk.snapshot("th_1").await }
    });
    let s = store.clone();
    until(5, || async { (s.loads() > 0).then_some(()) }).await;
    // Its actor is made (with the instance's policy, allow), and it isn't live yet: configure()
    // waits for it, and changes it once it is.
    let configuring = tokio::spawn({
        let sdk = env.sdk.clone();
        let policy = Capabilities {
            permissions: Some(PermissionPolicy::deny()),
            ..Default::default()
        };
        async move { sdk.configure("th_1", policy).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!configuring.is_finished(), "configure() waits for the load");
    store.open.send_replace(true);
    configuring.await.unwrap().unwrap();
    loading.await.unwrap().unwrap();
    env.sdk
        .send("th_1", "tool Bash {}", SendOptions::default())
        .await
        .unwrap();
    let s = settle(&env.sdk, "th_1").await;
    assert_eq!(items(&s, "tool_call")[0]["status"], "denied");
    env.sdk.close(true).await.unwrap();
}

/// Kills the runs in a directory when it's dropped, so a test that fails leaves nothing running.
struct KillRuns(PathBuf);

impl Drop for KillRuns {
    fn drop(&mut self) {
        agent_threads::kill_runs(&self.0);
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_thread_configured_while_its_run_is_reattached_answers_the_runs_open_requests_with_the_new_policy() {
    let runs = KillRuns(common::temp_dir());
    let log = common::temp_dir().join("log.jsonl");
    let make = |store: Arc<dyn Store>, policy: PermissionPolicy| {
        let mut claude = ClaudeCodeOptions {
            bin: common::mini("claude").to_string_lossy().into(),
            ..Default::default()
        };
        claude
            .env
            .insert("MINI_CLAUDE_LOG".into(), Some(log.to_string_lossy().into()));
        AgentThreads::new(Options {
            store: Some(store),
            harnesses: vec![agent_threads::claude_code(claude)],
            spawner: Some(agent_threads::shim(
                common::shim_path(),
                agent_threads::ShimOptions::new(&runs.0),
            )),
            capabilities: Capabilities {
                permissions: Some(policy),
                ..Default::default()
            },
            ..Default::default()
        })
    };
    // A backend whose policy hasn't decided on Claude's request when it shuts down, leaving the run
    // going with the request open.
    let asked = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let a = asked.clone();
    #[allow(unreachable_code)]
    let undecided = PermissionPolicy::from_async(move |_, _| {
        a.store(true, std::sync::atomic::Ordering::SeqCst);
        std::future::pending::<PermissionDecision>()
    });
    let state = MemoryStore::new();
    let first = make(Arc::new(MemoryStore::with_state(state.state.clone())), undecided);
    let t = first.create(create()).await.unwrap();
    first.send(&t.id, "tool Bash {}", SendOptions::default()).await.unwrap();
    until(10, || async {
        asked.load(std::sync::atomic::Ordering::SeqCst).then_some(())
    })
    .await;
    first.close(false).await.unwrap();
    let run_dir = std::fs::read_dir(&runs.0).unwrap().next().unwrap().unwrap().path();
    let input = run_dir.join("input.jsonl");
    let answers = || {
        std::fs::read_to_string(&input)
            .unwrap()
            .lines()
            .filter(|l| l.contains("control_response"))
            .map(String::from)
            .collect::<Vec<_>>()
    };
    assert!(answers().is_empty());

    // The next backend allows everything, and is told to deny while it's looking the run up.
    let store = Gated::runs(MemoryStore::with_state(state.state.clone()));
    let second = make(store.clone(), PermissionPolicy::allow());
    let loading = tokio::spawn({
        let (sdk, id) = (second.clone(), t.id.clone());
        async move { sdk.snapshot(&id).await }
    });
    let s = store.clone();
    until(5, || async { (s.loads() > 0).then_some(()) }).await;
    let configuring = tokio::spawn({
        let (sdk, id) = (second.clone(), t.id.clone());
        let policy = Capabilities {
            permissions: Some(PermissionPolicy::deny()),
            ..Default::default()
        };
        async move { sdk.configure(&id, policy).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    store.open.send_replace(true);
    configuring.await.unwrap().unwrap();
    loading.await.unwrap().unwrap();
    let said = until(10, || async {
        let a = answers();
        (!a.is_empty()).then_some(a)
    })
    .await;
    assert_eq!(said.len(), 1, "{said:?}");
    assert!(said[0].contains(r#""behavior":"deny""#), "{said:?}");
    second.close(true).await.unwrap();
}
