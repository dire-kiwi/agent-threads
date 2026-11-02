//! Every fixture in spec/fixtures (Claude Code and Codex), run as spec/fixtures/README.md says: the
//! SDK drives the fake CLI (which replays the recording and checks what it's sent), and its events
//! must match expected.jsonl by spec/tools/check-events.mjs's rules. Its snapshot must be its
//! events, folded. Each runs with the harness as a child process, and under the shim. The
//! pass-through fixtures' control requests, harness messages and raw payloads are checked too.

mod common;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_threads::reducer::{apply_events, initial_state, open_requests};
use agent_threads::{
    AgentThreads, Capabilities, ClaudeCodeOptions, CodexOptions, CreateOptions, Error, HarnessMessage, McpServer,
    MemoryStore, Options, PermissionPolicy, Spawner, ThreadEvent, claude_code, codex, direct, tool,
};
use serde_json::{Value, json};
use tokio::sync::broadcast;

/// Whether a value has everything a pattern has (objects field by field, everything else exactly).
fn matches(v: &Value, p: &Value) -> bool {
    match p {
        Value::Object(p) => v.is_object() && p.iter().all(|(k, x)| matches(v.get(k).unwrap_or(&Value::Null), x)),
        _ => v == p,
    }
}

const WAIT: Duration = Duration::from_secs(10);

/// Every event the SDK has sent so far, taken from its subscription as they're asked for (so an
/// event sent before a command is always counted before it).
struct Events {
    rx: broadcast::Receiver<ThreadEvent>,
    all: Vec<ThreadEvent>,
}

impl Events {
    fn pump(&mut self) -> &[ThreadEvent] {
        loop {
            match self.rx.try_recv() {
                Ok(e) => self.all.push(e),
                Err(broadcast::error::TryRecvError::Lagged(n)) => panic!("the test missed {n} events"),
                Err(_) => return &self.all,
            }
        }
    }

    async fn wait_for(&mut self, from: usize, pattern: &Value) -> Option<usize> {
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            for (i, e) in self.pump().iter().enumerate().skip(from) {
                if matches(&serde_json::to_value(e).unwrap(), pattern) {
                    return Some(i);
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        None
    }
}

fn show(events: &[ThreadEvent]) -> String {
    events
        .iter()
        .filter(|e| !matches!(e, ThreadEvent::Delta(_)))
        .map(|e| serde_json::to_string(e).unwrap().chars().take(300).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

struct Setup<'a> {
    fixture: &'a Value,
    dir: &'a std::path::Path,
    state: &'a std::path::Path,
    codex_home: &'a std::path::Path,
    spawner: Arc<dyn Spawner>,
    store: Arc<dyn agent_threads::Store>,
    errors: Arc<Mutex<Vec<String>>>,
    messages: Arc<Mutex<Vec<HarnessMessage>>>,
}

fn make(s: &Setup) -> AgentThreads {
    let (fixture, dir, state, codex_home) = (s.fixture, s.dir, s.state, s.codex_home);
    let errors = s.errors.clone();
    let messages = s.messages.clone();
    let fake = common::spec_dir()
        .join("tools/fake-cli.mjs")
        .to_string_lossy()
        .to_string();
    let env = [
        (
            "AGENT_THREADS_FIXTURE".to_string(),
            Some(dir.to_string_lossy().to_string()),
        ),
        (
            "AGENT_THREADS_FIXTURE_STATE".to_string(),
            Some(state.to_string_lossy().to_string()),
        ),
    ]
    .into_iter()
    .collect::<std::collections::HashMap<_, _>>();
    let tools = fixture["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| {
            let result = t["result"].as_str().unwrap().to_string();
            tool(
                t["name"].as_str().unwrap(),
                t["description"].as_str().unwrap(),
                t["input"].clone(),
                move |_, _| {
                    let result = result.clone();
                    async move { result }
                },
            )
        })
        .collect();
    let mcp_servers = fixture["mcp_servers"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| (k.clone(), McpServer::from_json(v).unwrap()))
        .collect();
    let permissions = match fixture["permissions"].as_str() {
        Some("ask") => PermissionPolicy::ask(),
        _ => PermissionPolicy::allow(),
    };
    AgentThreads::new(Options {
        store: Some(s.store.clone()),
        harnesses: vec![
            claude_code(ClaudeCodeOptions {
                bin: fake.clone(),
                env: env.clone(),
                ..Default::default()
            }),
            codex(CodexOptions {
                bin: fake,
                env,
                home: Some(codex_home.to_path_buf()),
                login: None,
                ..Default::default()
            }),
        ],
        spawner: Some(s.spawner.clone()),
        capabilities: Capabilities {
            tools,
            mcp_servers,
            skills: vec![],
            permissions: Some(permissions),
            system_prompt: None,
        },
        on_error: Some(Arc::new(move |e| errors.lock().unwrap().push(e.to_string()))),
        event_capacity: 1 << 16,
        raw: fixture["raw"] == true,
        on_harness_message: (fixture["raw"] == true)
            .then(|| Arc::new(move |m: &HarnessMessage| messages.lock().unwrap().push(m.clone())) as _),
    })
}

async fn run_fixture(scenario: &str, spawner_name: &str) {
    let dir = common::spec_dir().join("fixtures").join(scenario);
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("fixture.json")).unwrap()).unwrap();
    let cwd = common::temp_dir();
    let state = common::temp_dir();
    let codex_home = common::temp_dir();
    let store: Arc<dyn agent_threads::Store> = Arc::new(MemoryStore::new());
    let spawner = match spawner_name {
        "shim" => agent_threads::shim(common::shim_path(), agent_threads::ShimOptions::new(common::temp_dir())),
        _ => direct(),
    };
    let errors = Arc::new(Mutex::new(Vec::new()));
    let messages = Arc::new(Mutex::new(Vec::new()));

    // The same store each time, as an app that restarts has.
    let setup = Setup {
        fixture: &fixture,
        dir: &dir,
        state: &state,
        codex_home: &codex_home,
        spawner,
        store,
        errors: errors.clone(),
        messages: messages.clone(),
    };
    let mut sdk = make(&setup);
    let mut events = Events {
        rx: sdk.subscribe(),
        all: Vec::new(),
    };
    let t = &fixture["thread"];
    let thread = sdk
        .create(CreateOptions {
            harness: t["harness"].as_str().map(String::from),
            model: t["model"].as_str().map(String::from),
            effort: t["effort"].as_str().map(String::from),
            permission_mode: t
                .get("permission_mode")
                .map(|m| serde_json::from_value(m.clone()).unwrap()),
            cwd: Some(cwd.clone()),
            ..Default::default()
        })
        .await
        .unwrap();
    let mut from = 0;
    for (i, step) in fixture["steps"].as_array().unwrap().iter().enumerate() {
        let at = format!("{scenario} ({spawner_name}) step {}: {step}", i + 1);
        if step.get("restart").is_some() {
            sdk.close(true).await.unwrap();
            events.pump();
            sdk = make(&setup);
            events.rx = sdk.subscribe();
            from = events.all.len();
        } else if let Some(request) = step.get("control") {
            let answer = sdk.control(&thread.id, request.clone()).await;
            match step.get("error").and_then(Value::as_str) {
                Some(want) => match answer {
                    Err(Error::Control { message, .. }) => {
                        assert!(message.contains(want), "{at}: the error {message:?}")
                    }
                    other => panic!("{at}: expected a control error, got {other:?}"),
                },
                None => assert_eq!(answer.unwrap_or_else(|e| panic!("{at}: {e}")), step["result"], "{at}"),
            }
        } else if let Some(command) = step.get("command") {
            let mut command = command.clone();
            command["thread_id"] = json!(thread.id);
            if command["type"] == "respond" {
                let snap = sdk.snapshot(&thread.id).await.unwrap();
                let open: Vec<_> = open_requests(&snap).collect();
                assert_eq!(open.len(), 1, "{at}: open requests");
                command["request_id"] = json!(open[0].id());
            }
            from = events.pump().len();
            sdk.handle_json(command).await.unwrap_or_else(|e| panic!("{at}: {e}"));
        } else {
            let found = events.wait_for(from, &step["wait"]).await;
            let Some(found) = found else {
                let since = events.all[from..].to_vec();
                panic!(
                    "{at}: no such event within {WAIT:?}. Events since the step before:\n{}",
                    show(&since)
                );
            };
            from = found + 1;
        }
    }

    // Its snapshot is its events, folded (deltas included).
    let snapshot = sdk.snapshot(&thread.id).await.unwrap();
    let all = events.pump().to_vec();
    let first = match &all[0] {
        ThreadEvent::ThreadUpdated(e) => e.thread.clone(),
        _ => thread.clone(),
    };
    let mut folded = initial_state(first);
    apply_events(&mut folded, &all);
    assert_eq!(
        serde_json::to_value(&snapshot).unwrap(),
        serde_json::to_value(&folded).unwrap(),
        "{scenario}: snapshot"
    );

    sdk.close(true).await.unwrap();
    let all = events.pump().to_vec();

    // The fake CLI was sent what the recording has, in every run.
    let runs = common::read_jsonl(&format!("fixtures/{scenario}/session.jsonl"))
        .iter()
        .filter(|e| e["dir"] == "spawn")
        .count();
    let mut reports: Vec<String> = std::fs::read_dir(&state)
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|f| f.starts_with("run-") && f.ends_with(".json"))
        .collect();
    reports.sort();
    let want: Vec<String> = (1..=runs).map(|n| format!("run-{n}.json")).collect();
    assert_eq!(reports, want, "{scenario} ({spawner_name}): the fake CLI's reports");
    for r in &reports {
        let report: Value = serde_json::from_str(&std::fs::read_to_string(state.join(r)).unwrap()).unwrap();
        assert_eq!(
            report["ok"],
            json!(true),
            "{scenario} ({spawner_name}) {r}: {report}\nErrors: {:?}\nEvents:\n{}",
            errors.lock().unwrap(),
            show(&all)
        );
    }

    let path = common::temp_dir().join("events.jsonl");
    let text: String = all.iter().map(|e| serde_json::to_string(e).unwrap() + "\n").collect();
    std::fs::write(&path, text).unwrap();
    let out = std::process::Command::new("node")
        .arg(common::spec_dir().join("tools/check-events.mjs"))
        .arg(&dir)
        .arg(&path)
        .output()
        .expect("node runs check-events.mjs");
    assert!(
        out.status.success(),
        "{scenario} ({spawner_name}): the events don't match expected.jsonl:\n{}{}\nEvents:\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
        show(&all)
    );
    let errors = errors.lock().unwrap();
    assert!(errors.is_empty(), "{scenario} ({spawner_name}): errors: {errors:?}");

    // What the protocol leaves out came through.
    let messages = messages.lock().unwrap();
    for m in messages.iter() {
        assert_eq!(m.thread_id, thread.id, "{scenario}: a harness message's thread");
        assert_eq!(
            m.harness,
            t["harness"].as_str().unwrap(),
            "{scenario}: a harness message's harness"
        );
        assert_eq!(
            m.message,
            serde_json::from_str::<Value>(&m.line).ok(),
            "{scenario}: a harness message's line"
        );
    }
    for p in fixture["harness_messages"].as_array().into_iter().flatten() {
        assert!(
            messages
                .iter()
                .any(|m| m.message.as_ref().is_some_and(|v| matches(v, p))),
            "{scenario} ({spawner_name}): no harness message like {p}"
        );
    }
    for check in fixture["raw_checks"].as_array().into_iter().flatten() {
        let (pattern, raw) = (&check["event"], &check["raw"]);
        let matching: Vec<Value> = all
            .iter()
            .map(|e| serde_json::to_value(e).unwrap())
            .filter(|e| matches(e, pattern))
            .collect();
        assert!(
            !matching.is_empty(),
            "{scenario} ({spawner_name}): no event like {pattern}"
        );
        for e in matching {
            let got = match e["type"].as_str() {
                Some("item.added") => e["item"].get("raw"),
                Some("request.opened") => e["request"].get("raw"),
                _ => e.get("raw"),
            };
            let shown: String = e.to_string().chars().take(300).collect();
            match got {
                None => assert!(raw.is_null(), "{scenario} ({spawner_name}): {shown} has no raw"),
                Some(got) => assert!(
                    !raw.is_null() && matches(got, raw),
                    "{scenario} ({spawner_name}): {shown} has a raw like {raw}: {}",
                    got.to_string().chars().take(300).collect::<String>()
                ),
            }
        }
    }
}

/// The spawners to run fixtures with: both, or those in $AGENT_THREADS_SPAWNERS (comma-separated).
fn spawners() -> Vec<String> {
    let all = if cfg!(unix) { "direct,shim" } else { "direct" };
    std::env::var("AGENT_THREADS_SPAWNERS")
        .unwrap_or_else(|_| all.into())
        .split(',')
        .map(String::from)
        .collect()
}

macro_rules! fixtures {
    ($($name:ident: $scenario:literal,)*) => {
        $(
            #[tokio::test(flavor = "multi_thread")]
            async fn $name() {
                for spawner in spawners() {
                    run_fixture($scenario, &spawner).await;
                }
            }
        )*

        #[test]
        fn every_fixture_has_a_test() {
            let mut have: Vec<&str> = vec![$($scenario),*];
            have.sort();
            let mut all = Vec::new();
            for harness in ["claude", "codex"] {
                for e in std::fs::read_dir(common::spec_dir().join("fixtures").join(harness)).unwrap() {
                    let e = e.unwrap();
                    if e.path().join("session.jsonl").exists() {
                        all.push(format!("{harness}/{}", e.file_name().to_string_lossy()));
                    }
                }
            }
            all.sort();
            assert_eq!(have, all);
        }
    };
}

fixtures! {
    claude_app_tool: "claude/app-tool",
    claude_ask_user_question: "claude/ask-user-question",
    claude_background_subagent: "claude/background-subagent",
    claude_compaction: "claude/compaction",
    claude_error: "claude/error",
    claude_interrupt: "claude/interrupt",
    claude_mcp_tool: "claude/mcp-tool",
    claude_pass_through: "claude/pass-through",
    claude_permission_allow: "claude/permission-allow",
    claude_permission_deny: "claude/permission-deny",
    claude_plain_reply: "claude/plain-reply",
    claude_resume: "claude/resume",
    claude_skill_fork: "claude/skill-fork",
    claude_steer: "claude/steer",
    claude_subagent: "claude/subagent",
    claude_tool_calls: "claude/tool-calls",
    codex_app_tool: "codex/app-tool",
    codex_ask_user_question: "codex/ask-user-question",
    codex_compaction: "codex/compaction",
    codex_error: "codex/error",
    codex_interrupt: "codex/interrupt",
    codex_mcp_tool: "codex/mcp-tool",
    codex_pass_through: "codex/pass-through",
    codex_permission_allow: "codex/permission-allow",
    codex_permission_deny: "codex/permission-deny",
    codex_plain_reply: "codex/plain-reply",
    codex_resume: "codex/resume",
    codex_steer: "codex/steer",
    codex_subagent: "codex/subagent",
    codex_tool_calls: "codex/tool-calls",
}
