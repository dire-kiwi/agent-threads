//! What the recorded fixtures don't cover, against a scriptable fake `claude` (the Node backend's
//! mini-claude.mjs): steering that outlives a turn, policies, failures, restarts, option changes
//! and stopping; and AgentThreads itself (commands it refuses, stores that fail, deleting). As the
//! Node backend's driver.test.ts does.

mod common;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_threads::protocol::{PermissionMode, Resolution, StandingAnswer, ToolKind};
use agent_threads::reducer::open_requests;
use agent_threads::{
    AgentThreads, Capabilities, ClaudeCodeOptions, CreateOptions, DONT_ASK_DENIAL, Error, FileStore, HarnessMessage,
    LaunchOptions, McpServer, MemoryState, MemoryStore, Options, PermissionDecision, PermissionPolicy, RunRecord,
    SendOptions, Skill, Snapshot, Spawner, SqliteStore, Store, StoreError, StoreResult, ThreadEvent, ThreadOptions,
    ToolContext, tool,
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
    spawner: Option<Arc<dyn Spawner>>,
    capabilities: Capabilities,
    errors: Arc<Mutex<Vec<String>>>,
    late_answers: bool,
    idle_close: Option<Duration>,
    /// What the app's on_harness_message has been given.
    messages: Arc<Mutex<Vec<HarnessMessage>>>,
}

impl Default for Setup {
    fn default() -> Self {
        Setup {
            claude: ClaudeCodeOptions::default(),
            steer: "now",
            env: Vec::new(),
            store: None,
            spawner: None,
            capabilities: Capabilities {
                permissions: Some(PermissionPolicy::allow()),
                ..Default::default()
            },
            errors: Arc::default(),
            late_answers: false,
            idle_close: None,
            messages: Arc::default(),
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
        let messages = self.setup.messages.clone();
        AgentThreads::new(Options {
            store: Some(store),
            harnesses: vec![agent_threads::claude_code(claude)],
            spawner: self.setup.spawner.clone(),
            capabilities: self.setup.capabilities.clone(),
            on_error: Some(Arc::new(move |e| errors.lock().unwrap().push(e.to_string()))),
            event_capacity: 1 << 16,
            late_answers: self.setup.late_answers,
            idle_close: self.setup.idle_close,
            on_harness_message: Some(Arc::new(move |m| messages.lock().unwrap().push(m.clone()))),
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
async fn leaves_raw_out_unless_its_turned_on_and_passes_the_app_every_line() {
    let mut env = setup(Setup::default());
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk.send(&t.id, "reply hi", SendOptions::default()).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert!(
        env.events_json()
            .iter()
            .all(|e| e.get("raw").is_none() && e["item"].get("raw").is_none())
    );
    assert!(s["items"].as_array().unwrap().iter().all(|i| i.get("raw").is_none()));
    let messages = env.setup.messages.lock().unwrap();
    let types: Vec<&str> = messages
        .iter()
        .filter_map(|m| m.message.as_ref()?["type"].as_str())
        .collect();
    for want in ["control_response", "system", "assistant", "result"] {
        assert!(types.contains(&want), "no {want} message in {types:?}");
    }
    let run = s["thread"]["run"]["id"].as_str().unwrap();
    assert!(messages.iter().all(|m| m.thread_id == t.id
        && m.harness == "claude"
        && m.run_id == run
        && m.message == serde_json::from_str::<Value>(&m.line).ok()));
}

#[tokio::test(flavor = "multi_thread")]
async fn sends_control_requests_to_the_running_process_and_fails_them_when_it_cant() {
    let env = setup(Setup::default());
    let t = env.sdk.create(create()).await.unwrap();
    let usage = json!({"subtype": "get_context_usage"});
    assert!(matches!(
        env.sdk.control(&t.id, usage.clone()).await,
        Err(Error::Command(_))
    ));
    env.sdk.send(&t.id, "reply hi", SendOptions::default()).await.unwrap();
    settle(&env.sdk, &t.id).await;
    assert_eq!(env.sdk.control(&t.id, usage.clone()).await.unwrap(), json!({}));
    assert!(matches!(
        env.sdk.control(&t.id, json!("get_context_usage")).await,
        Err(Error::Command(_))
    ));
    // One the process exits before answering.
    let sdk = env.sdk.clone();
    let id = t.id.clone();
    let pending = tokio::spawn(async move { sdk.control(&id, json!({"subtype": "never_answered"})).await });
    until(5, || async {
        env.runs()
            .first()?
            .sent
            .iter()
            .any(|m| m["request"]["subtype"] == "never_answered")
            .then_some(())
    })
    .await;
    env.sdk.close(true).await.unwrap();
    assert!(matches!(pending.await.unwrap(), Err(Error::Control { .. })));
    assert!(matches!(env.sdk.control(&t.id, usage).await, Err(Error::Command(_))));
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

/// The control requests a mini-claude run was sent.
fn controls(run: &common::MiniRun) -> Vec<Value> {
    run.sent
        .iter()
        .filter(|m| m["type"] == "control_request")
        .map(|m| m["request"].clone())
        .collect()
}

/// The first open request, once there is one.
async fn first_request(env: &Env, id: &str) -> Value {
    let r = until(5, || async {
        env.sdk.snapshot(id).await.unwrap().requests.first().cloned()
    })
    .await;
    serde_json::to_value(r).unwrap()
}

/// The first control_response a mini-claude run was sent: the answer to its first request.
fn first_answer(run: &common::MiniRun) -> Value {
    run.sent
        .iter()
        .find(|m| m["type"] == "control_response")
        .map(|m| m["response"]["response"].clone())
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn gives_a_running_process_a_new_model_and_permission_mode() {
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
    let cmd = json!({"type": "set_options", "thread_id": t.id, "model": "b", "permission_mode": "accept_edits"});
    env.sdk.handle_json(cmd).await.unwrap();
    env.sdk.send(&t.id, "reply two", SendOptions::default()).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(texts(&s), ["one", "two"]);
    let runs = env.runs();
    assert_eq!(runs.len(), 1);
    let controls = controls(&runs[0]);
    assert!(controls.contains(&json!({"subtype": "set_model", "model": "b"})));
    assert!(controls.contains(&json!({"subtype": "set_permission_mode", "mode": "acceptEdits"})));
}

#[tokio::test(flavor = "multi_thread")]
async fn asks_the_user_about_a_plan_and_approving_it_leaves_plan_mode_for_the_mode_they_pick() {
    let env = setup(Setup {
        capabilities: Capabilities {
            permissions: Some(PermissionPolicy::ask()),
            ..Default::default()
        },
        ..Default::default()
    });
    let t = env
        .sdk
        .create(CreateOptions {
            permission_mode: Some(PermissionMode::Plan),
            ..create()
        })
        .await
        .unwrap();
    env.sdk
        .send(
            &t.id,
            r##"tool ExitPlanMode {"plan":"#Plan\n-one"}"##,
            SendOptions::default(),
        )
        .await
        .unwrap();
    let r = first_request(&env, &t.id).await;
    assert_eq!(
        (r["type"].clone(), r["plan"].clone()),
        (json!("plan"), json!("#Plan\n-one"))
    );
    assert!(r["id"].as_str().unwrap().starts_with("plan"));
    let respond = json!({"type": "respond", "thread_id": t.id, "request_id": r["id"], "resolution": {"outcome": "allow", "permission_mode": "accept_edits"}});
    env.sdk.handle_json(respond).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(s["thread"]["permission_mode"], "accept_edits");
    let answer = first_answer(&env.runs()[0]);
    assert_eq!(answer["behavior"], "allow");
    assert_eq!(
        answer["updatedPermissions"],
        json!([{"type": "setMode", "mode": "acceptEdits", "destination": "session"}])
    );
    // The process has the mode: the next turn runs in it, and isn't told it again.
    env.sdk.send(&t.id, "reply next", SendOptions::default()).await.unwrap();
    settle(&env.sdk, &t.id).await;
    let runs = env.runs();
    assert_eq!(runs.len(), 1);
    assert!(!controls(&runs[0]).iter().any(|c| c["subtype"] == "set_permission_mode"));
}

#[tokio::test(flavor = "multi_thread")]
async fn sends_a_plan_back_with_the_users_feedback() {
    let env = setup(Setup::default());
    let t = env
        .sdk
        .create(CreateOptions {
            permission_mode: Some(PermissionMode::Plan),
            ..create()
        })
        .await
        .unwrap();
    env.sdk
        .send(&t.id, r#"tool ExitPlanMode {"plan":"p"}"#, SendOptions::default())
        .await
        .unwrap();
    let r = first_request(&env, &t.id).await;
    let respond = json!({"type": "respond", "thread_id": t.id, "request_id": r["id"], "resolution": {"outcome": "deny", "message": "Not yet."}});
    env.sdk.handle_json(respond).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(s["thread"]["permission_mode"], "plan");
    let call = items(&s, "tool_call")[0];
    assert_eq!(
        (
            call["name"].clone(),
            call["status"].clone(),
            call["result"]["content"].clone()
        ),
        (json!("ExitPlanMode"), json!("denied"), json!("Not yet."))
    );
    assert_eq!(
        first_answer(&env.runs()[0]),
        json!({"behavior": "deny", "message": "Not yet."})
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn allows_what_a_process_that_cant_be_switched_to_bypass_mode_asks_until_a_new_one_starts_in_it() {
    let mut env = setup(Setup {
        capabilities: Capabilities {
            permissions: Some(PermissionPolicy::ask()),
            ..Default::default()
        },
        env: vec![("MINI_CLAUDE_ASK_DELAY", "300".into())],
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, r#"tool Bash {"command":"ls"}"#, SendOptions::default())
        .await
        .unwrap();
    let cmd = json!({"type": "set_options", "thread_id": t.id, "permission_mode": "bypass"});
    env.sdk.handle_json(cmd).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert!(!env.events().iter().any(|e| matches!(e, ThreadEvent::RequestOpened(_))));
    let calls: Vec<(Value, Value)> = items(&s, "tool_call")
        .iter()
        .map(|c| (c["name"].clone(), c["status"].clone()))
        .collect();
    assert_eq!(calls, [(json!("Bash"), json!("completed"))]);
    // It was put in acceptEdits mode, the nearest it could be.
    let runs = env.runs();
    assert!(controls(&runs[0]).contains(&json!({"subtype": "set_permission_mode", "mode": "acceptEdits"})));
    // The next turn has a process started in bypass mode.
    env.sdk.send(&t.id, "reply next", SendOptions::default()).await.unwrap();
    settle(&env.sdk, &t.id).await;
    let runs = env.runs();
    assert_eq!(runs.len(), 2);
    assert!(has(&runs[1].argv, "--permission-mode", "bypassPermissions"));
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_a_carried_over_turn_with_options_changed_during_the_turn_before() {
    let env = setup(Setup {
        steer: "late",
        ..Default::default()
    });
    // A new effort needs a new process (a model or permission mode doesn't).
    let t = env
        .sdk
        .create(CreateOptions {
            effort: Some("low".into()),
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
                effort: Some("high".into()),
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
    assert!(has(&runs[0].argv, "--effort", "low"));
    assert!(has(&runs[1].argv, "--effort", "high"));
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
        open_requests(&env.sdk.snapshot(&t.id).await.unwrap()).next().cloned()
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
    let s = settle(&env.sdk, &t.id).await;

    // The answered request stays, with its answer.
    let mut answered = r.clone();
    answered["resolution"] = json!({"outcome": "allow", "always": true});
    assert_eq!(s["requests"], json!([answered]));

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

fn asking(policy: PermissionPolicy) -> Setup {
    Setup {
        capabilities: Capabilities {
            permissions: Some(policy),
            ..Default::default()
        },
        ..Default::default()
    }
}

fn resolution(v: Value) -> Resolution {
    serde_json::from_value(v).unwrap()
}

/// A snapshot's open requests (resolved ones stay, with their resolution).
fn open(s: &Value) -> Vec<&Value> {
    s["requests"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r.get("resolution").is_none())
        .collect()
}

/// Waits for the thread's open request with a type, other than `not`.
async fn open_request(sdk: &AgentThreads, id: &str, ty: &str, not: Option<&str>) -> Value {
    until(5, || async {
        let s = serde_json::to_value(sdk.snapshot(id).await.unwrap()).unwrap();
        open(&s)
            .into_iter()
            .find(|r| r["type"] == ty && Some(r["id"].as_str().unwrap()) != not)
            .cloned()
    })
    .await
}

const QUESTION: &str = r#"{"questions":[{"question":"Colour?","options":[{"label":"Blue"},{"label":"Red"}]}]}"#;

#[tokio::test(flavor = "multi_thread")]
async fn keeps_standing_answers_with_the_thread_and_lets_the_app_seed_and_clear_them() {
    let state = MemoryState::new();
    let env = setup(Setup {
        store: Some(Arc::new(MemoryStore::with_state(state.clone()))),
        ..asking(PermissionPolicy::ask())
    });
    let seeded: Vec<StandingAnswer> =
        serde_json::from_value(json!([{"kind": "web", "name": "WebFetch", "outcome": "deny"}])).unwrap();
    let t = env
        .sdk
        .create(CreateOptions {
            standing_answers: seeded,
            ..create()
        })
        .await
        .unwrap();
    env.sdk
        .send(
            &t.id,
            r#"tool WebFetch {"url":"https://example.com"}"#,
            SendOptions::default(),
        )
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(
        texts(&s).last().unwrap(),
        "denied: The user has denied this tool for the rest of the thread."
    );

    env.sdk
        .send(&t.id, r#"tool Bash {"command":"ls"}"#, SendOptions::default())
        .await
        .unwrap();
    let r = open_request(&env.sdk, &t.id, "permission", None).await;
    env.sdk
        .respond(
            &t.id,
            r["id"].as_str().unwrap(),
            resolution(json!({"outcome": "allow", "always": true})),
        )
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    let standing = json!([
        {"kind": "web", "name": "WebFetch", "outcome": "deny"},
        {"kind": "shell", "name": "Bash", "outcome": "allow"},
    ]);
    assert_eq!(s["thread"]["standing_answers"], standing);
    env.sdk.close(false).await.unwrap();

    // Kept with the thread: a backend that starts again has them.
    let env = setup(Setup {
        store: Some(Arc::new(MemoryStore::with_state(state.clone()))),
        ..asking(PermissionPolicy::ask())
    });
    let got = serde_json::to_value(env.sdk.get(&t.id).await.unwrap().unwrap()).unwrap();
    assert_eq!(got["standing_answers"], standing);
    let stored = MemoryStore::with_state(state.clone())
        .get_thread(&t.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored["standing_answers"], standing);
    env.sdk
        .send(&t.id, r#"tool Bash {"command":"pwd"}"#, SendOptions::default())
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(texts(&s).last().unwrap(), r#"ran with {"command":"pwd"}"#);
    assert!(open(&s).is_empty());

    // Cleared, they don't stand any more; set_options leaves them as they are without them.
    let clear = json!({"type": "set_options", "thread_id": t.id, "standing_answers": []});
    env.sdk.handle_json(clear).await.unwrap();
    env.sdk
        .set_options(
            &t.id,
            ThreadOptions {
                model: Some("m".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
    assert!(s["thread"].get("standing_answers").is_none());
    env.sdk
        .send(&t.id, r#"tool Bash {"command":"pwd"}"#, SendOptions::default())
        .await
        .unwrap();
    open_request(&env.sdk, &t.id, "permission", None).await;

    // Seeding one answers the open requests it's for.
    let seed = json!({"type": "set_options", "thread_id": t.id, "standing_answers": [{"kind": "shell", "name": "Bash", "outcome": "allow"}]});
    env.sdk.handle_json(seed).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(texts(&s).last().unwrap(), r#"ran with {"command":"pwd"}"#);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_answer_given_always_answers_the_open_requests_for_the_same_tool() {
    let mut env = setup(asking(PermissionPolicy::ask()));
    let t = env.sdk.create(create()).await.unwrap();
    // Two at once (as from parallel subagents).
    env.sdk
        .send(&t.id, r#"twice Bash {"command":"ls"}"#, SendOptions::default())
        .await
        .unwrap();
    let first = open_request(&env.sdk, &t.id, "permission", None).await;
    open_request(&env.sdk, &t.id, "permission", first["id"].as_str()).await;
    let first_id = first["id"].as_str().unwrap();
    env.sdk
        .respond(
            &t.id,
            first_id,
            resolution(json!({"outcome": "deny", "always": true, "message": "No."})),
        )
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    let resolved: Vec<Value> = env
        .events_json()
        .into_iter()
        .filter(|e| e["type"] == "request.resolved")
        .map(|e| e["resolution"].clone())
        .collect();
    assert_eq!(
        resolved,
        [
            json!({"outcome": "deny", "always": true, "message": "No."}),
            json!({"outcome": "deny", "message": "The user has denied this tool for the rest of the thread."}),
        ]
    );
    assert_eq!(texts(&s).len(), 2);
    assert_eq!(
        s["thread"]["standing_answers"],
        json!([{"kind": "shell", "name": "Bash", "outcome": "deny"}])
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_mode_change_answers_open_permission_requests_and_decides_later_ones() {
    let env = setup(asking(PermissionPolicy::ask()));
    let t = env.sdk.create(create()).await.unwrap();
    let mode = |m: PermissionMode| ThreadOptions {
        permission_mode: Some(m),
        ..Default::default()
    };

    // bypass allows an open permission request, but doesn't answer a question for the user.
    env.sdk
        .send(
            &t.id,
            &format!("tool AskUserQuestion {QUESTION}"),
            SendOptions::default(),
        )
        .await
        .unwrap();
    let q = open_request(&env.sdk, &t.id, "question", None).await;
    env.sdk.set_options(&t.id, mode(PermissionMode::Bypass)).await.unwrap();
    let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
    assert_eq!(open(&s).len(), 1);
    env.sdk
        .respond(
            &t.id,
            q["id"].as_str().unwrap(),
            resolution(json!({"outcome": "answer", "answers": {"Colour?": ["Blue"]}})),
        )
        .await
        .unwrap();
    settle(&env.sdk, &t.id).await;

    env.sdk.set_options(&t.id, mode(PermissionMode::Default)).await.unwrap();
    env.sdk
        .send(&t.id, r#"tool Bash {"command":"ls"}"#, SendOptions::default())
        .await
        .unwrap();
    open_request(&env.sdk, &t.id, "permission", None).await;
    env.sdk.set_options(&t.id, mode(PermissionMode::Bypass)).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(texts(&s).last().unwrap(), r#"ran with {"command":"ls"}"#);

    // dont_ask denies an open permission request, and what would be asked after it.
    env.sdk.set_options(&t.id, mode(PermissionMode::Default)).await.unwrap();
    env.sdk
        .send(&t.id, r#"tool Bash {"command":"pwd"}"#, SendOptions::default())
        .await
        .unwrap();
    open_request(&env.sdk, &t.id, "permission", None).await;
    env.sdk.set_options(&t.id, mode(PermissionMode::DontAsk)).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(texts(&s).last().unwrap(), &format!("denied: {DONT_ASK_DENIAL}"));
    for text in [
        r#"tool Bash {"command":"id"}"#.to_string(),
        format!("tool AskUserQuestion {QUESTION}"),
    ] {
        env.sdk.send(&t.id, &text, SendOptions::default()).await.unwrap();
        let s = settle(&env.sdk, &t.id).await;
        assert_eq!(texts(&s).last().unwrap(), &format!("denied: {DONT_ASK_DENIAL}"));
    }
    let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
    assert_eq!(items(&s, "tool_call").last().unwrap()["status"], "denied");
    // Requests were opened for the first three calls only.
    let opened = serde_json::to_value(env.sdk.events_since(&t.id, 0, None).await.unwrap())
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["type"] == "request.opened")
        .count();
    assert_eq!(opened, 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_question_left_open_when_its_turn_ends_is_answered_with_a_message() {
    let state = MemoryState::new();
    let env = setup(Setup {
        store: Some(Arc::new(MemoryStore::with_state(state.clone()))),
        late_answers: true,
        ..asking(PermissionPolicy::ask())
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(
            &t.id,
            &format!("asking AskUserQuestion {QUESTION}"),
            SendOptions::default(),
        )
        .await
        .unwrap();
    let q = open_request(&env.sdk, &t.id, "question", None).await;
    env.sdk.interrupt(&t.id).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(s["thread"]["status"], "idle");
    assert_eq!(open(&s)[0]["id"], q["id"]);
    assert_eq!(results(&s)[0]["interrupted"], true);
    env.sdk.close(false).await.unwrap();

    // Still open after a restart; the answer goes to the agent as the next message.
    let mut env = setup(Setup {
        store: Some(Arc::new(MemoryStore::with_state(state.clone()))),
        late_answers: true,
        ..asking(PermissionPolicy::ask())
    });
    let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
    assert_eq!(open(&s)[0]["id"], q["id"]);
    let respond = json!({"type": "respond", "thread_id": t.id, "request_id": q["id"],
        "resolution": {"outcome": "answer", "answers": {"Colour?": ["Blue"]}, "message": "Thanks."}});
    env.sdk.handle_json(respond).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    let text = "My answer to the question you asked:\n\n- Colour?\n  Blue\n\nThanks.";
    assert_eq!(items(&s, "user_message").last().unwrap()["text"], text);
    assert_eq!(results(&s).len(), 2);
    assert!(open(&s).is_empty());
    let sent: Vec<Value> = env.runs().last().unwrap().sent.clone();
    assert!(
        sent.iter()
            .any(|m| m["type"] == "user" && m.to_string().contains("Colour?"))
    );
    assert_eq!(
        env.events_json()
            .iter()
            .filter(|e| e["type"] == "request.resolved")
            .count(),
        1
    );

    // One the conversation has moved on from (a message was sent) is cancelled instead.
    env.sdk
        .send(
            &t.id,
            &format!("asking AskUserQuestion {QUESTION}"),
            SendOptions::default(),
        )
        .await
        .unwrap();
    let q2 = open_request(&env.sdk, &t.id, "question", None).await;
    env.sdk.interrupt(&t.id).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(open(&s)[0]["id"], q2["id"]);
    env.sdk.send(&t.id, "reply hi", SendOptions::default()).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert!(open(&s).is_empty());
    let last = env
        .events_json()
        .into_iter()
        .rfind(|e| e["type"] == "request.resolved")
        .unwrap();
    assert_eq!(
        (last["request_id"].clone(), last["resolution"]["outcome"].clone()),
        (q2["id"].clone(), json!("cancel"))
    );
    // Answering it now does nothing.
    let before = items(&s, "user_message").len();
    env.sdk
        .respond(
            &t.id,
            q2["id"].as_str().unwrap(),
            resolution(json!({"outcome": "answer", "answers": {"Colour?": ["Red"]}})),
        )
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(items(&s, "user_message").len(), before);
}

/// Asks a question, and interrupts its turn: the harness cancels the question, which is kept open.
/// Doesn't wait for the turn to end.
async fn interrupted_question(sdk: &AgentThreads, id: &str) -> Value {
    sdk.send(
        id,
        &format!("asking AskUserQuestion {QUESTION}"),
        SendOptions::default(),
    )
    .await
    .unwrap();
    let q = open_request(sdk, id, "question", None).await;
    sdk.interrupt(id).await.unwrap();
    // No longer waiting on it, though it's open.
    until(5, || async {
        let s = sdk.snapshot(id).await.unwrap();
        (s.thread.status != agent_threads::protocol::ThreadStatus::Waiting).then_some(())
    })
    .await;
    q
}

/// The resolution the thread's request got, if it has one.
async fn resolution_of(sdk: &AgentThreads, thread: &str, request: &Value) -> Value {
    let s = serde_json::to_value(sdk.snapshot(thread).await.unwrap()).unwrap();
    s["requests"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == request["id"])
        .map(|r| r["resolution"].clone())
        .unwrap_or(Value::Null)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_question_isnt_kept_open_once_the_user_sends_a_message_during_its_turn() {
    let env = setup(Setup {
        late_answers: true,
        env: vec![("MINI_CLAUDE_INTERRUPT_DELAY", "300".into())],
        ..asking(PermissionPolicy::ask())
    });
    let t = env.sdk.create(create()).await.unwrap();

    // The message comes after the harness gave the question up, before the turn ends.
    let q = interrupted_question(&env.sdk, &t.id).await;
    assert!(resolution_of(&env.sdk, &t.id, &q).await.is_null());
    env.sdk.send(&t.id, "reply hi", SendOptions::default()).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert!(open(&s).is_empty());
    assert_eq!(resolution_of(&env.sdk, &t.id, &q).await, json!({"outcome": "cancel"}));
    let before = items(&s, "user_message").len();
    let answer = resolution(json!({"outcome": "answer", "answers": {"Colour?": ["Red"]}}));
    env.sdk
        .respond(&t.id, q["id"].as_str().unwrap(), answer.clone())
        .await
        .unwrap();
    assert_eq!(items(&settle(&env.sdk, &t.id).await, "user_message").len(), before);

    // And before it.
    env.sdk
        .send(
            &t.id,
            &format!("asking AskUserQuestion {QUESTION}"),
            SendOptions::default(),
        )
        .await
        .unwrap();
    let q = open_request(&env.sdk, &t.id, "question", None).await;
    env.sdk
        .send(&t.id, "reply later", SendOptions::default())
        .await
        .unwrap();
    env.sdk.interrupt(&t.id).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert!(open(&s).is_empty());
    assert_eq!(resolution_of(&env.sdk, &t.id, &q).await, json!({"outcome": "cancel"}));
}

#[tokio::test(flavor = "multi_thread")]
async fn dont_ask_dismisses_questions_kept_open_after_their_turns_before_and_after_a_restart() {
    let state = MemoryState::new();
    let make = || {
        setup(Setup {
            store: Some(Arc::new(MemoryStore::with_state(state.clone()))),
            late_answers: true,
            ..asking(PermissionPolicy::ask())
        })
    };
    let dont_ask = ThreadOptions {
        permission_mode: Some(PermissionMode::DontAsk),
        ..Default::default()
    };
    let env = make();
    let t = env.sdk.create(create()).await.unwrap();
    for restart in [false, true] {
        let env = make();
        env.sdk
            .set_options(
                &t.id,
                ThreadOptions {
                    permission_mode: Some(PermissionMode::Default),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let q = interrupted_question(&env.sdk, &t.id).await;
        let s = settle(&env.sdk, &t.id).await;
        assert_eq!(open(&s)[0]["id"], q["id"]);
        let env = if restart {
            env.sdk.close(false).await.unwrap();
            make()
        } else {
            env
        };
        env.sdk.set_options(&t.id, dont_ask.clone()).await.unwrap();
        let s = settle(&env.sdk, &t.id).await;
        assert!(open(&s).is_empty(), "restart: {restart}");
        assert_eq!(
            resolution_of(&env.sdk, &t.id, &q).await,
            json!({"outcome": "cancel", "message": DONT_ASK_DENIAL})
        );
        // Dismissed, it sent nothing.
        assert_eq!(results(&s).len(), if restart { 2 } else { 1 });
        env.sdk.close(false).await.unwrap();
    }
}

/// The conversation moved on from a question (the user sent a message, which the harness took in)
/// before the backend stopped with its run: the question isn't kept open when the lost turn ends,
/// whether or not it has a tool_call item.
#[tokio::test(flavor = "multi_thread")]
async fn a_question_isnt_kept_open_after_a_lost_run_once_the_user_sent_a_message() {
    for unlinked in [false, true] {
        lost_run_after_a_message(unlinked).await;
    }
}

async fn lost_run_after_a_message(unlinked: bool) {
    let state = MemoryState::new();
    let make = |store: MemoryStore| {
        setup(Setup {
            store: Some(Arc::new(store)),
            late_answers: true,
            env: if unlinked {
                vec![("MINI_CLAUDE_UNLINKED", "1".into())]
            } else {
                vec![]
            },
            ..asking(PermissionPolicy::ask())
        })
    };
    let env = make(MemoryStore::with_state(state.clone()));
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(
            &t.id,
            &format!("asking AskUserQuestion {QUESTION}"),
            SendOptions::default(),
        )
        .await
        .unwrap();
    let q = open_request(&env.sdk, &t.id, "question", None).await;
    assert_eq!(q.get("tool_call_id").is_none(), unlinked, "{q}");
    env.sdk.send(&t.id, "reply hi", SendOptions::default()).await.unwrap();
    // Taken in: nothing's queued.
    until(5, || async {
        let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
        let messages = items(&s, "user_message").into_iter().cloned().collect::<Vec<_>>();
        (messages.len() == 2 && messages.iter().all(|m| m.get("queued").is_none())).then_some(())
    })
    .await;
    env.sdk.events_since(&t.id, 0, None).await.unwrap(); // saved
    // As if the backend died with the run.
    let copy = common::crashed(&MemoryStore::with_state(state), &t.id).await;
    env.sdk.close(false).await.unwrap();

    let again = make(copy);
    let s = serde_json::to_value(again.sdk.snapshot(&t.id).await.unwrap()).unwrap();
    assert!(open(&s).is_empty(), "unlinked: {unlinked}: {s}");
    assert_eq!(resolution_of(&again.sdk, &t.id, &q).await, json!({"outcome": "cancel"}));
}

/// A message the harness took in between a tool call and the question it asks for it came before
/// the question: the conversation hasn't moved on from it.
#[tokio::test(flavor = "multi_thread")]
async fn keeps_a_question_open_after_a_message_taken_in_before_it_was_asked() {
    let env = setup(Setup {
        late_answers: true,
        env: vec![("MINI_CLAUDE_ASK_DELAY", "500".into())],
        ..asking(PermissionPolicy::ask())
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(
            &t.id,
            &format!("asking AskUserQuestion {QUESTION}"),
            SendOptions::default(),
        )
        .await
        .unwrap();
    until(5, || async {
        let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
        (!items(&s, "tool_call").is_empty()).then_some(())
    })
    .await;
    env.sdk.send(&t.id, "reply hi", SendOptions::default()).await.unwrap();
    let q = open_request(&env.sdk, &t.id, "question", None).await;
    let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
    let messages = items(&s, "user_message");
    assert!(
        messages.len() == 2 && messages.iter().all(|m| m.get("queued").is_none()),
        "{s}"
    );
    assert_eq!(q["user_messages"], 2);
    env.sdk.interrupt(&t.id).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(open(&s).first().map(|r| &r["id"]), Some(&q["id"]), "{s}");
    let answer = resolution(json!({"outcome": "answer", "answers": {"Colour?": ["Red"]}}));
    env.sdk.respond(&t.id, q["id"].as_str().unwrap(), answer).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    let text = "My answer to the question you asked:\n\n- Colour?\n  Red";
    assert_eq!(items(&s, "user_message").last().unwrap()["text"], text);
}

#[tokio::test(flavor = "multi_thread")]
async fn without_late_answers_a_turn_that_ends_cancels_its_questions() {
    let env = setup(asking(PermissionPolicy::ask()));
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(
            &t.id,
            &format!("asking AskUserQuestion {QUESTION}"),
            SendOptions::default(),
        )
        .await
        .unwrap();
    open_request(&env.sdk, &t.id, "question", None).await;
    env.sdk.interrupt(&t.id).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert!(open(&s).is_empty());
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
    let open: Vec<&Value> = s["requests"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r.get("resolution").is_none())
        .collect();
    assert_eq!(open.len(), 1);
    let request = open[0]["id"].clone();
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

    let respond =
        json!({"type": "respond", "thread_id": t.id, "request_id": request, "resolution": {"outcome": "allow"}});
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

/// new_session or rewind changes the session while a background subagent runs: the process is
/// stopped, so the turn Claude would start when it ends can't bring the old session back.
async fn stops_the_process_when_the_session_changes(rewind: bool) {
    let mut env = setup(Setup::default());
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, "background 500 apple", SendOptions::default())
        .await
        .unwrap();
    until(5, || {
        let done = env.events().iter().any(|e| matches!(e, ThreadEvent::TurnCompleted(_)));
        async move { done.then_some(()) }
    })
    .await;
    let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
    assert!(s["thread"]["session_id"].is_string());
    let agent = items(&s, "tool_call")
        .into_iter()
        .find(|c| c["name"] == "Agent")
        .unwrap()
        .clone();
    assert_eq!(agent["subagent"]["status"], "running");
    if rewind {
        let turn = results(&s)[0]["turn_id"].as_str().unwrap().to_string();
        env.sdk.rewind(&t.id, &turn).await.unwrap();
    } else {
        env.sdk.new_session(&t.id).await.unwrap();
    }
    // Long enough for the subagent to have ended, and Claude's turn about it to have come.
    tokio::time::sleep(Duration::from_millis(1000)).await;
    let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
    assert!(s["thread"].get("session_id").is_none(), "{}", s["thread"]);
    assert_eq!(s["thread"]["status"], "idle");
    let last = s["items"].as_array().unwrap().last().unwrap();
    assert_eq!(
        (&last["type"], &last["code"]),
        (&json!("notice"), &json!(if rewind { "rewind" } else { "session.new" }))
    );
    assert!(!texts(&s).contains(&"the subagent said apple".to_string()));
    if !rewind {
        let call = s["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["id"] == agent["id"])
            .unwrap();
        assert_eq!(call["subagent"]["status"], "stopped");
    }
    assert_eq!(env.runs().len(), 1);
    // The next message starts a new process, in a new session.
    env.sdk
        .send(&t.id, "reply fresh", SendOptions::default())
        .await
        .unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(texts(&s).last().unwrap(), "fresh");
    assert!(!env.runs()[1].argv.iter().any(|a| a == "--resume"));
}

#[tokio::test(flavor = "multi_thread")]
async fn stops_the_process_when_new_session_changes_the_session_so_a_background_subagents_turn_cant_bring_the_old_one_back()
 {
    stops_the_process_when_the_session_changes(false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn stops_the_process_when_rewind_changes_the_session_so_a_background_subagents_turn_cant_bring_the_old_one_back()
{
    stops_the_process_when_the_session_changes(true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_a_users_turn_going_past_a_turn_claude_makes_before_taking_its_message_in() {
    let mut env = setup(Setup {
        env: vec![("MINI_CLAUDE_NOTIFY_FIRST", "1".into())],
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, "background 300 apple", SendOptions::default())
        .await
        .unwrap();
    until(5, || async {
        let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
        (results(&s).len() == 1).then_some(())
    })
    .await;
    // Sent before the subagent is done: Claude reports the subagent first, then takes this in.
    env.sdk.send(&t.id, "reply hi", SendOptions::default()).await.unwrap();
    let s = until(5, || async {
        let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
        (texts(&s).last().map(String::as_str) == Some("hi") && s["thread"]["status"] == "idle").then_some(s)
    })
    .await;
    let results = results(&s);
    assert_eq!(results.len(), 2, "{:?}", env.events_json());
    // The user's turn has its message, both replies, and both results' usage.
    let turn = results[1]["turn_id"].clone();
    let said: Vec<&Value> = s["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["turn_id"] == turn && i["type"] != "turn_result")
        .map(|i| &i["text"])
        .collect();
    assert_eq!(
        said,
        [&json!("reply hi"), &json!("the subagent said apple"), &json!("hi")]
    );
    assert_eq!(results[1]["usage"]["input_tokens"], 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_a_background_subagents_app_tools_structured_output_for_the_result_after_its_turn() {
    let lookup = tool("lookup", "Looks it up.", json!({"type": "object"}), |_, _| async {
        agent_threads::ToolOutput::text("42").with_structured(json!({"answer": 42}))
    });
    let env = setup(Setup {
        env: vec![("MINI_CLAUDE_BACKGROUND_APP", "lookup".into())],
        capabilities: Capabilities {
            tools: vec![lookup],
            permissions: Some(PermissionPolicy::allow()),
            ..Default::default()
        },
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, "background 200 apple", SendOptions::default())
        .await
        .unwrap();
    let s = until(5, || async {
        let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
        (results(&s).len() == 2 && s["thread"]["status"] == "idle").then_some(s)
    })
    .await;
    let call = items(&s, "tool_call")
        .into_iter()
        .find(|c| c["name"] == "lookup")
        .unwrap()
        .clone();
    assert_eq!(call["status"], "completed");
    assert_eq!(call["result"]["structured"], json!({"answer": 42}), "{call}");
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
async fn gives_a_window_of_a_threads_last_items_and_pages_of_the_items_before_it() {
    let env = setup(Setup::default());
    let t = env.sdk.create(create()).await.unwrap();
    for n in ["one", "two", "three"] {
        env.sdk
            .send(&t.id, &format!("reply {n}"), SendOptions::default())
            .await
            .unwrap();
        settle(&env.sdk, &t.id).await;
    }
    let whole = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
    // A user message, the reply and the turn's result, for each turn.
    let all = whole["items"].as_array().unwrap();
    assert_eq!(all.len(), 9);
    assert!(whole.get("start").is_none());
    let value = |s| serde_json::to_value::<Snapshot>(s).unwrap();
    assert_eq!(value(env.sdk.snapshot_window(&t.id, 20).await.unwrap()), whole);

    let window = value(env.sdk.snapshot_window(&t.id, 4).await.unwrap());
    assert_eq!(
        (&window["start"], &window["seq"], &window["thread"]),
        (&json!(5), &whole["seq"], &whole["thread"])
    );
    assert_eq!(window["items"], json!(all[5..]));
    assert!(window.get("context").is_none());

    let page = env.sdk.items_before(&t.id, 5, 3).await.unwrap();
    assert_eq!(
        serde_json::to_value(page).unwrap(),
        json!({"thread_id": t.id, "items": all[2..5], "requests": [], "start": 2, "context": [], "seq": whole["seq"]})
    );
    let first = env.sdk.items_before(&t.id, 2, 3).await.unwrap();
    assert_eq!(
        (first.start, serde_json::to_value(first.items).unwrap()),
        (0, json!(all[..2]))
    );
    assert!(env.sdk.items_before("nope", 2, 3).await.is_err());
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
        mcp_servers: [(
            "echo".to_string(),
            McpServer::Stdio {
                command: "node".into(),
                args: vec!["echo.mjs".into()],
                env: [("ECHO_TOKEN".into(), "a-token".into())].into(),
                // Codex's alone: Claude Code takes MCP_TOOL_TIMEOUT from its environment.
                codex: [("tool_timeout_sec".into(), json!(600))].into_iter().collect(),
            },
        )]
        .into(),
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
    let mcp: Value = serde_json::from_str(&std::fs::read_to_string(flag("--mcp-config")).unwrap()).unwrap();
    assert_eq!(
        mcp["mcpServers"]["docs"],
        json!({"type": "http", "url": "https://example.com/mcp"})
    );
    assert_eq!(
        mcp["mcpServers"]["echo"],
        json!({"type": "stdio", "command": "node", "args": ["echo.mjs"], "env": {"ECHO_TOKEN": "a-token"}})
    );
    assert_eq!(flag("--append-system-prompt"), "You help.");
    assert!(contains_all(&argv, &["--setting-sources", "", "--strict-mcp-config"]));
}

/// Starts a thread with an MCP server whose environment has a secret, under `spawner`: the secret
/// isn't on any process's command line while it runs (Claude's --mcp-config is a file, readable by
/// the user only), and the file goes with the run.
async fn mcp_config_in_a_private_file(spawner: Option<Arc<dyn Spawner>>) {
    let secret = format!("secret-{}-{}", std::process::id(), rand_suffix());
    let env = setup(Setup {
        spawner,
        capabilities: Capabilities {
            permissions: Some(PermissionPolicy::allow()),
            mcp_servers: [
                (
                    "echo".to_string(),
                    McpServer::Stdio {
                        command: "node".into(),
                        args: vec!["echo.mjs".into()],
                        env: [("ECHO_TOKEN".into(), secret.clone())].into(),
                        codex: Default::default(),
                    },
                ),
                (
                    "docs".to_string(),
                    McpServer::Http {
                        url: "https://example.com/mcp".into(),
                        headers: [("authorization".into(), format!("Bearer {secret}"))].into(),
                        codex: Default::default(),
                    },
                ),
            ]
            .into(),
            ..Default::default()
        },
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk.send(&t.id, "reply hi", SendOptions::default()).await.unwrap();
    settle(&env.sdk, &t.id).await;
    let argv = env.runs()[0].argv.clone();
    assert!(!argv.iter().any(|a| a.contains(&secret)), "{argv:?}");
    // Claude stays up between turns: nothing running has the secret on its command line.
    #[cfg(target_os = "linux")]
    for entry in std::fs::read_dir("/proc").unwrap().flatten() {
        if let Ok(cmdline) = std::fs::read(entry.path().join("cmdline")) {
            assert!(
                !String::from_utf8_lossy(&cmdline).contains(&secret),
                "{} has the secret on its command line",
                entry.path().display()
            );
        }
    }
    let file = PathBuf::from(&argv[argv.iter().position(|a| a == "--mcp-config").unwrap() + 1]);
    assert!(file.file_name().unwrap().to_string_lossy().starts_with("mcp-"));
    let mcp: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(mcp["mcpServers"]["echo"]["env"]["ECHO_TOKEN"], json!(secret));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    }
    // It goes with the run.
    env.sdk.close(true).await.unwrap();
    assert!(!file.exists());
}

fn rand_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}

#[tokio::test(flavor = "multi_thread")]
async fn writes_the_mcp_config_to_a_private_file_not_the_command_line() {
    mcp_config_in_a_private_file(None).await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn writes_the_mcp_config_to_a_private_file_under_the_shim_too() {
    let runs = common::temp_dir();
    mcp_config_in_a_private_file(Some(agent_threads::shim(
        common::shim_path(),
        agent_threads::ShimOptions::new(&runs),
    )))
    .await;
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
        open_requests(&env.sdk.snapshot(&t.id).await.unwrap()).next().cloned()
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
    let crashed = common::crashed(&MemoryStore::with_state(state), &t.id).await;
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

#[tokio::test(flavor = "multi_thread")]
async fn keeps_the_mark_claude_gave_a_turn_the_backend_lost_so_a_rewind_past_it_resumes_after_it() {
    let store = Arc::new(MemoryStore::new());
    let env = setup(Setup {
        store: Some(store.clone()),
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk.send(&t.id, "reply one", SendOptions::default()).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    let first = results(&s)[0]["session"]["at"].clone();
    env.sdk
        .send(&t.id, "streamhang cut short", SendOptions::default())
        .await
        .unwrap();
    // It has the message (its echo is the turn's mark so far), and is answering.
    let at = until(5, || async {
        let x = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
        let at = x["thread"].get("turn_at").cloned();
        texts(&x).iter().any(|t| t == "cut short ").then_some(at).flatten()
    })
    .await;
    assert_ne!(at, first);
    env.sdk.events_since(&t.id, 0, None).await.unwrap(); // saved
    let crashed = common::crashed(store.as_ref(), &t.id).await;
    env.sdk.close(false).await.unwrap();

    let next = env.make(Arc::new(crashed));
    let s = serde_json::to_value(next.snapshot(&t.id).await.unwrap()).unwrap();
    let lost = results(&s)[1];
    assert_eq!(lost["ok"], false);
    assert_eq!(lost["session"], json!({"id": s["thread"]["session_id"], "at": at}));
    next.send(&t.id, "reply three", SendOptions::default()).await.unwrap();
    let s = settle(&next, &t.id).await;
    let third = results(&s)[2]["turn_id"].as_str().unwrap().to_string();
    next.rewind(&t.id, &third).await.unwrap();
    let thread = serde_json::to_value(next.snapshot(&t.id).await.unwrap()).unwrap()["thread"].clone();
    assert_eq!(
        (&thread["session_id"], &thread["resume_at"]),
        (&s["thread"]["session_id"], &at)
    );
    next.send(&t.id, "reply four", SendOptions::default()).await.unwrap();
    settle(&next, &t.id).await;
    let argv = env.runs().last().unwrap().argv.clone();
    assert!(has(&argv, "--resume-session-at", at.as_str().unwrap()), "{argv:?}");
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

/// A thread's launch options: (args, env, add_dirs, config_dir).
fn launch(args: &[&str], env: &[(&str, Option<&str>)], add_dirs: &[&str], config_dir: &str) -> LaunchOptions {
    LaunchOptions {
        args: args.iter().map(|a| a.to_string()).collect(),
        env: env.iter().map(|(k, v)| (k.to_string(), v.map(String::from))).collect(),
        add_dirs: add_dirs.iter().map(PathBuf::from).collect(),
        config_dir: Some(PathBuf::from(config_dir)),
    }
}

/// The values `flag` is given in `argv`, in order.
fn flag_values(argv: &[String], flag: &str) -> Vec<String> {
    argv.windows(2).filter(|a| a[0] == flag).map(|a| a[1].clone()).collect()
}

/// Launch options with the claude harness's own options, stored with the thread but not sent to
/// clients, for every process it starts: after set_options changes them, and after a restart.
#[tokio::test(flavor = "multi_thread")]
async fn starts_claude_with_the_threads_launch_options_and_keeps_them_across_a_restart() {
    let store: Arc<dyn Store> = Arc::new(FileStore::open(common::temp_dir()).unwrap());
    let mut claude = ClaudeCodeOptions {
        args: vec!["--own".into()],
        config_dir: Some("/instance-config".into()),
        ..Default::default()
    };
    claude.env.insert("AT_GONE".into(), Some("instance".into()));
    let mut env = setup(Setup {
        claude,
        store: Some(store.clone()),
        env: vec![
            ("MINI_LOG_ENV", "AT_SET,AT_GONE,AT_KEPT".into()),
            ("AT_KEPT", "kept".into()),
        ],
        ..Default::default()
    });
    let first = launch(
        &["--allowedTools", "Read Edit", "--settings", "{\"a\":1}"],
        &[("AT_SET", Some("a b")), ("AT_GONE", None)],
        &["/one", "/two"],
        "/profile-a",
    );
    let t = env
        .sdk
        .create(CreateOptions {
            launch: first.clone(),
            ..create()
        })
        .await
        .unwrap();
    env.sdk.send(&t.id, "reply one", SendOptions::default()).await.unwrap();
    settle(&env.sdk, &t.id).await;
    let run = &env.runs()[0];
    assert_eq!(flag_values(&run.argv, "--add-dir"), ["/one", "/two"]);
    // After the driver's arguments and the harness options'.
    let n = run.argv.len();
    assert_eq!(
        run.argv[n - 5..],
        ["--own", "--allowedTools", "Read Edit", "--settings", "{\"a\":1}"]
    );
    assert_eq!(run.config_dir.as_deref(), Some("/profile-a"));
    assert_eq!(run.env, json!({"AT_SET": "a b", "AT_GONE": null, "AT_KEPT": "kept"}));
    // Stored with the thread, and never sent to clients.
    let stored = store.get_thread(&t.id).await.unwrap().unwrap();
    assert_eq!(stored["launch"]["env"], json!({"AT_SET": "a b", "AT_GONE": null}));
    assert!(env.events_json().iter().all(|e| !e.to_string().contains("profile-a")));
    assert!(
        serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap()["thread"]
            .get("launch")
            .is_none()
    );

    // Changed: the next turn's process has the new ones.
    let second = launch(
        &["--disallowedTools", "Bash"],
        &[("AT_SET", Some("b"))],
        &["/three"],
        "/profile-b",
    );
    env.sdk
        .set_options(
            &t.id,
            ThreadOptions {
                launch: Some(second.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    env.sdk.send(&t.id, "reply two", SendOptions::default()).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    let runs = env.runs();
    assert_eq!(runs.len(), 2);
    assert_eq!(flag_values(&runs[1].argv, "--add-dir"), ["/three"]);
    assert_eq!(runs[1].argv[runs[1].argv.len() - 2..], ["--disallowedTools", "Bash"]);
    assert!(!runs[1].argv.contains(&"--allowedTools".to_string()));
    assert_eq!(runs[1].config_dir.as_deref(), Some("/profile-b"));
    assert_eq!(
        runs[1].env,
        json!({"AT_SET": "b", "AT_GONE": "instance", "AT_KEPT": "kept"})
    );

    // A new backend on the same store resumes the thread with them.
    env.sdk.close(false).await.unwrap();
    let again = env.make(store.clone());
    again.send(&t.id, "reply three", SendOptions::default()).await.unwrap();
    settle(&again, &t.id).await;
    let runs = env.runs();
    assert_eq!(runs.len(), 3);
    assert!(has(
        &runs[2].argv,
        "--resume",
        s["thread"]["session_id"].as_str().unwrap()
    ));
    assert_eq!(flag_values(&runs[2].argv, "--add-dir"), ["/three"]);
    assert_eq!(runs[2].argv[runs[2].argv.len() - 2..], ["--disallowedTools", "Bash"]);
    assert_eq!(runs[2].config_dir.as_deref(), Some("/profile-b"));
    assert_eq!(runs[2].env["AT_SET"], "b");
    again.close(false).await.unwrap();
}

/// Under the shim, the process is started with the thread's launch options too.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn starts_claude_under_the_shim_with_the_threads_launch_options() {
    let runs_dir = KillRuns(common::temp_dir());
    let env = setup(Setup {
        spawner: Some(agent_threads::shim(
            common::shim_path(),
            agent_threads::ShimOptions::new(&runs_dir.0),
        )),
        env: vec![("MINI_LOG_ENV", "AT_SET".into())],
        ..Default::default()
    });
    let t = env
        .sdk
        .create(CreateOptions {
            launch: launch(&["--settings", "{}"], &[("AT_SET", Some("x y"))], &["/one"], "/profile"),
            ..create()
        })
        .await
        .unwrap();
    env.sdk.send(&t.id, "reply one", SendOptions::default()).await.unwrap();
    assert_eq!(texts(&settle(&env.sdk, &t.id).await), ["one"]);
    let run = &env.runs()[0];
    assert_eq!(flag_values(&run.argv, "--add-dir"), ["/one"]);
    assert_eq!(run.argv[run.argv.len() - 2..], ["--settings", "{}"]);
    assert_eq!(run.config_dir.as_deref(), Some("/profile"));
    assert_eq!(run.env, json!({"AT_SET": "x y"}));
    env.sdk.close(true).await.unwrap();
}

/// A question kept open after its turn belongs to the conversation that asked it: a rewind or a new
/// session cancels it, and answering it then starts nothing, before a restart or after.
#[tokio::test(flavor = "multi_thread")]
async fn a_session_change_cancels_a_question_kept_open_after_its_turn() {
    for change in ["rewind", "new_session"] {
        let state = MemoryState::new();
        let late = || Setup {
            store: Some(Arc::new(MemoryStore::with_state(state.clone()))),
            late_answers: true,
            ..asking(PermissionPolicy::ask())
        };
        let mut env = setup(late());
        let t = env.sdk.create(create()).await.unwrap();
        env.sdk.send(&t.id, "reply one", SendOptions::default()).await.unwrap();
        settle(&env.sdk, &t.id).await;
        env.sdk
            .send(
                &t.id,
                &format!("asking AskUserQuestion {QUESTION}"),
                SendOptions::default(),
            )
            .await
            .unwrap();
        let q = open_request(&env.sdk, &t.id, "question", None).await;
        env.sdk.interrupt(&t.id).await.unwrap();
        let s = settle(&env.sdk, &t.id).await;
        assert_eq!(open(&s).len(), 1, "{change}");
        if change == "rewind" {
            let turn = results(&s)[1]["turn_id"].as_str().unwrap().to_string();
            env.sdk.rewind(&t.id, &turn).await.unwrap();
        } else {
            env.sdk.new_session(&t.id).await.unwrap();
        }
        let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
        assert!(open(&s).is_empty(), "{change}: {s}");
        let last = env
            .events_json()
            .into_iter()
            .rfind(|e| e["type"] == "request.resolved")
            .unwrap();
        assert_eq!(
            (last["request_id"].clone(), last["resolution"]["outcome"].clone()),
            (q["id"].clone(), json!("cancel")),
            "{change}"
        );
        let respond = json!({"type": "respond", "thread_id": t.id, "request_id": q["id"],
            "resolution": {"outcome": "answer", "answers": {"Colour?": ["Blue"]}}});
        let before = items(&s, "user_message").len();
        let _ = env.sdk.handle_json(respond.clone()).await;
        let s = settle(&env.sdk, &t.id).await;
        assert_eq!(items(&s, "user_message").len(), before, "{change}: {s}");
        env.sdk.close(false).await.unwrap();

        let env = setup(late());
        let s = serde_json::to_value(env.sdk.snapshot(&t.id).await.unwrap()).unwrap();
        assert!(open(&s).is_empty(), "{change} after a restart: {s}");
        let _ = env.sdk.handle_json(respond).await;
        let s = settle(&env.sdk, &t.id).await;
        assert_eq!(items(&s, "user_message").len(), before, "{change} after a restart: {s}");
        env.sdk.close(false).await.unwrap();
    }
}

// ---------- letting an idle process go (idle_close, release) ----------

/// The thread's snapshot as JSON.
async fn snap(env: &Env, id: &str) -> Value {
    serde_json::to_value(env.sdk.snapshot(id).await.unwrap()).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn lets_an_idle_process_go_and_resumes_its_session_in_a_new_one() {
    let env = setup(Setup {
        idle_close: Some(Duration::ZERO),
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk.send(&t.id, "reply one", SendOptions::default()).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    let session = s["thread"]["session_id"].as_str().unwrap().to_string();
    // Its input is closed, so it exits; the thread has no run, and keeps its session.
    until(5, || async {
        env.runs().first().is_some_and(|r| r.exited).then_some(())
    })
    .await;
    let s = snap(&env, &t.id).await;
    assert!(s["thread"].get("run").is_none(), "{s}");
    assert_eq!(s["thread"]["session_id"], session.as_str());
    assert_eq!(s["thread"]["status"], "idle");
    env.sdk.send(&t.id, "reply two", SendOptions::default()).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    assert_eq!(texts(&s), ["one", "two"]);
    let runs = env.runs();
    assert_eq!(runs.len(), 2);
    assert!(has(&runs[1].argv, "--resume", &session));
    let r = results(&s);
    assert_eq!(r[1]["session"]["id"], session.as_str());
    assert!(r[1]["session"].get("started").is_none());
    assert!(env.setup.errors.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_message_sent_before_the_idle_time_is_up_goes_to_the_live_process() {
    let env = setup(Setup {
        idle_close: Some(Duration::from_millis(400)),
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk.send(&t.id, "reply one", SendOptions::default()).await.unwrap();
    settle(&env.sdk, &t.id).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    env.sdk.send(&t.id, "reply two", SendOptions::default()).await.unwrap();
    settle(&env.sdk, &t.id).await;
    assert_eq!(env.runs().len(), 1);
    // The wait starts again when a turn ends.
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(!env.runs()[0].exited);
    until(5, || async { env.runs()[0].exited.then_some(()) }).await;
    assert!(snap(&env, &t.id).await["thread"].get("run").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_steered_message_carried_over_goes_to_the_live_process_before_its_let_go() {
    // Claude takes the steered message in after its turn's result: the next turn, in the same
    // process.
    let env = setup(Setup {
        steer: "late",
        idle_close: Some(Duration::ZERO),
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, "sleep 200 first", SendOptions::default())
        .await
        .unwrap();
    until(5, || async {
        env.sdk.snapshot(&t.id).await.unwrap().thread.session_id.map(|_| ())
    })
    .await;
    env.sdk
        .send(&t.id, "reply second", SendOptions::default())
        .await
        .unwrap();
    let s = until(5, || async {
        let s = snap(&env, &t.id).await;
        (results(&s).len() == 2 && s["thread"]["status"] == "idle").then_some(s)
    })
    .await;
    assert_eq!(texts(&s), ["first", "second"]);
    until(5, || async { env.runs()[0].exited.then_some(()) }).await;
    assert_eq!(env.runs().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_the_process_while_a_background_subagent_runs_and_lets_it_go_after() {
    // Claude reports the subagent a while after it ends: the process is kept for that turn too.
    let env = setup(Setup {
        idle_close: Some(Duration::ZERO),
        env: vec![("MINI_CLAUDE_REPORT_DELAY", "200".into())],
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, "background 400 apple", SendOptions::default())
        .await
        .unwrap();
    until(5, || async {
        (results(&snap(&env, &t.id).await).len() == 1).then_some(())
    })
    .await;
    // Refused while the subagent runs.
    assert!(matches!(env.sdk.release(&t.id).await, Err(Error::Command(_))));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!env.runs()[0].exited);
    // Claude's own turn says how it went, and then it's let go.
    let s = until(5, || async {
        let s = snap(&env, &t.id).await;
        (results(&s).len() == 2 && s["thread"]["status"] == "idle").then_some(s)
    })
    .await;
    assert_eq!(texts(&s).last().unwrap(), "the subagent said apple");
    until(5, || async { env.runs()[0].exited.then_some(()) }).await;
    assert_eq!(env.runs().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_the_process_while_a_background_subagents_request_is_open() {
    let policy = PermissionPolicy::from_fn(|q, _| match q.kind {
        ToolKind::Shell => PermissionDecision::Ask,
        _ => PermissionDecision::Allow,
    });
    let env = setup(Setup {
        capabilities: Capabilities {
            permissions: Some(policy),
            ..Default::default()
        },
        idle_close: Some(Duration::ZERO),
        ..Default::default()
    });
    let t = env.sdk.create(create()).await.unwrap();
    env.sdk
        .send(&t.id, "background 0 apple", SendOptions::default())
        .await
        .unwrap();
    let s = until(5, || async {
        let s = snap(&env, &t.id).await;
        (results(&s).len() == 1 && s["thread"]["status"] == "waiting").then_some(s)
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!env.runs()[0].exited);
    let request = open(&s)[0]["id"].as_str().unwrap().to_string();
    env.sdk
        .respond(&t.id, &request, resolution(json!({"outcome": "allow"})))
        .await
        .unwrap();
    until(5, || async {
        let s = snap(&env, &t.id).await;
        (results(&s).len() == 2 && s["thread"]["status"] == "idle").then_some(())
    })
    .await;
    until(5, || async { env.runs()[0].exited.then_some(()) }).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn release_lets_an_idle_threads_process_go_and_is_refused_while_a_turn_runs() {
    let env = setup(Setup::default());
    let t = env.sdk.create(create()).await.unwrap();
    // No process yet.
    assert!(!env.sdk.release(&t.id).await.unwrap());
    env.sdk.send(&t.id, "slow", SendOptions::default()).await.unwrap();
    until(5, || async {
        env.sdk.snapshot(&t.id).await.unwrap().thread.session_id.map(|_| ())
    })
    .await;
    assert!(matches!(env.sdk.release(&t.id).await, Err(Error::Command(_))));
    env.sdk.interrupt(&t.id).await.unwrap();
    let s = settle(&env.sdk, &t.id).await;
    // Without idle_close, it's kept.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!env.runs()[0].exited);
    assert!(env.sdk.release(&t.id).await.unwrap());
    until(5, || async { env.runs()[0].exited.then_some(()) }).await;
    assert!(snap(&env, &t.id).await["thread"].get("run").is_none());
    assert!(!env.sdk.release(&t.id).await.unwrap());
    env.sdk
        .send(&t.id, "reply again", SendOptions::default())
        .await
        .unwrap();
    let after = settle(&env.sdk, &t.id).await;
    assert_eq!(texts(&after).last().unwrap(), "again");
    assert!(has(
        &env.runs()[1].argv,
        "--resume",
        s["thread"]["session_id"].as_str().unwrap()
    ));
}
