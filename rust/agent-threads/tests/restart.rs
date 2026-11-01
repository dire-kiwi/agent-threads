//! Runs that survive a backend restart: a backend (this test binary, run as `backend_process`, in a
//! process of its own) runs a fixture's turn under the shim, and is killed with SIGKILL partway
//! through it. A new backend recovers, and the thread finishes as if nothing had happened: the store
//! has exactly the fixture's events (with a notice that the run was picked up again), none lost and
//! none twice. As the Node backend's restart.test.ts does.
#![cfg(unix)]

mod common;

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_threads::{
    AgentThreads, Capabilities, ClaudeCodeOptions, CodexOptions, CreateOptions, FileStore, Options, PermissionPolicy,
    ShimOptions, Store, claude_code, codex, shim, tool,
};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::oneshot;

/// A backend process, and what it has said.
struct Backend {
    child: Child,
    stdin: ChildStdin,
    events: Arc<Mutex<Vec<Value>>>,
    replies: Arc<Mutex<std::collections::HashMap<u64, oneshot::Sender<Value>>>>,
    next: u64,
}

impl Backend {
    fn start(env: &[(String, String)]) -> Backend {
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["backend_process", "--exact", "--nocapture", "--test-threads=1"])
            .envs(env.iter().cloned())
            .env("AGENT_THREADS_BACKEND", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let events: Arc<Mutex<Vec<Value>>> = Arc::default();
        let replies: Arc<Mutex<std::collections::HashMap<u64, oneshot::Sender<Value>>>> = Arc::default();
        let (ev, rep) = (events.clone(), replies.clone());
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                // The test harness's own output is mixed in: only our JSON counts.
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(e) = msg.get("event") {
                    ev.lock().unwrap().push(e.clone());
                } else if let Some(id) = msg["reply"].as_u64()
                    && let Some(tx) = rep.lock().unwrap().remove(&id)
                {
                    let _ = tx.send(msg);
                }
            }
        });
        Backend { child, stdin, events, replies, next: 1 }
    }

    async fn call(&mut self, op: &str, args: Value) -> Value {
        let id = self.next;
        self.next += 1;
        let (tx, rx) = oneshot::channel();
        self.replies.lock().unwrap().insert(id, tx);
        let line = json!({"id": id, "op": op, "args": args}).to_string() + "\n";
        self.stdin.write_all(line.as_bytes()).await.unwrap();
        let r = tokio::time::timeout(Duration::from_secs(30), rx).await.expect("the backend answers").unwrap();
        assert!(r.get("error").is_none(), "{op}: {}", r["error"]);
        r["result"].clone()
    }

    async fn wait_for(&self, pattern: &Value) -> Value {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(e) = self.events.lock().unwrap().iter().find(|e| matches(e, pattern)) {
                return e.clone();
            }
            assert!(Instant::now() < deadline, "no event like {pattern}; got:\n{}", self.show());
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn show(&self) -> String {
        self.events.lock().unwrap().iter().map(|e| e.to_string().chars().take(200).collect::<String>()).collect::<Vec<_>>().join("\n")
    }

    /// Kills it as a crash would: no chance to save anything or stop anything.
    async fn crash(mut self) {
        self.child.kill().await.unwrap();
    }

    async fn exited(mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(30), self.child.wait()).await.expect("the backend exits");
    }
}

fn matches(v: &Value, p: &Value) -> bool {
    match p {
        Value::Object(p) => v.is_object() && p.iter().all(|(k, x)| matches(v.get(k).unwrap_or(&Value::Null), x)),
        _ => v == p,
    }
}

async fn until(what: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !what() {
        assert!(Instant::now() < deadline, "timed out");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// A fixture's scene: the directories and environment its backends share.
struct Scene {
    store: PathBuf,
    runs: PathBuf,
    state: PathBuf,
    cwd: PathBuf,
    env: Vec<(String, String)>,
    fixture: Value,
}

fn scene(fixture: &str, extra: &[(&str, &str)]) -> Scene {
    let (store, runs, state, cwd) = (common::temp_dir(), common::temp_dir(), common::temp_dir(), common::temp_dir());
    let f = common::read_json(&format!("fixtures/{fixture}/fixture.json"));
    let s = |p: &Path| p.to_string_lossy().to_string();
    let mut env = vec![
        ("STORE".into(), s(&store)),
        ("RUNS".into(), s(&runs)),
        ("CODEX_HOME_DIR".into(), s(&common::temp_dir())),
        ("SHIM".into(), s(&common::shim_path())),
        ("FAKE_CLI".into(), s(&common::spec_dir().join("tools/fake-cli.mjs"))),
        ("AGENT_THREADS_FIXTURE".into(), s(&common::spec_dir().join("fixtures").join(fixture))),
        ("AGENT_THREADS_FIXTURE_STATE".into(), s(&state)),
        ("POLICY".into(), f["permissions"].as_str().unwrap_or("allow").into()),
    ];
    for (k, v) in extra {
        env.retain(|(x, _)| x != k);
        env.push((k.to_string(), v.to_string()));
    }
    Scene { store, runs, state, cwd, env, fixture: f }
}

impl Scene {
    fn start(&self) -> Backend {
        Backend::start(&self.env)
    }

    fn create_args(&self) -> Value {
        let mut t = self.fixture["thread"].clone();
        t["cwd"] = json!(self.cwd);
        t
    }
}

async fn saved_events(store: &Path, thread: &str) -> Vec<Value> {
    let store = FileStore::open(store).unwrap();
    let events = store.read_events(thread, 0, None).await.unwrap();
    store.close().await.unwrap();
    events
}

/// Checks the saved events are the fixture's expected events (without deltas, which aren't saved),
/// plus the notices that the run was picked up again, and that the fake CLI got what it should.
fn check_thread(fixture: &str, saved: &[Value], state: &Path, reattached: usize) {
    let is_notice = |e: &Value| e["type"] == "item.added" && e["item"]["type"] == "notice" && e["item"]["code"] == "run.reattached";
    assert_eq!(saved.iter().filter(|e| is_notice(e)).count(), reattached, "run.reattached notices");
    // Without them, renumbered, the events must be exactly the fixture's.
    let rest: Vec<Value> = saved
        .iter()
        .filter(|e| !is_notice(e))
        .enumerate()
        .map(|(i, e)| {
            let mut e = e.clone();
            e["seq"] = json!(i + 1);
            e
        })
        .collect();
    if let Err(e) = common::compare(fixture, &rest, true) {
        panic!("{e}\n\nSaved events:\n{}", saved.iter().map(|e| e.to_string().chars().take(300).collect::<String>()).collect::<Vec<_>>().join("\n"));
    }
    let reports: Vec<String> = std::fs::read_dir(state)
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|f| f.starts_with("run-") && f.ends_with(".json"))
        .collect();
    assert_eq!(reports, vec!["run-1.json".to_string()]);
    let report: Value = serde_json::from_str(&std::fs::read_to_string(state.join("run-1.json")).unwrap()).unwrap();
    assert_eq!(report["ok"], json!(true), "{report}");
}

/// The same with each harness: a fixture whose turn waits on the user, one that streams (with
/// approvals the policy answers), and one that needs no input after it starts, which can end while
/// the backend is down; the pace it's replayed at, when it's partway through that turn, and what
/// marks its end in its output.
struct Harness {
    waits: &'static str,
    streams: &'static str,
    ends: &'static str,
    pace: &'static str,
    partway: Partway,
    ended: &'static str,
}

enum Partway {
    Event(Value),
    Out(&'static str),
}

fn harness(name: &str) -> Harness {
    match name {
        "claude" => Harness {
            waits: "claude/permission-allow",
            streams: "claude/tool-calls",
            ends: "claude/subagent",
            pace: "0.2",
            partway: Partway::Event(json!({"type": "item.added", "item": {"type": "tool_call"}})),
            ended: r#""type":"result""#,
        },
        _ => Harness {
            waits: "codex/permission-allow",
            streams: "codex/tool-calls",
            ends: "codex/plain-reply",
            pace: "0.5",
            partway: Partway::Out(r#""method":"turn/started""#),
            ended: r#""method":"turn/completed""#,
        },
    }
}

async fn while_waiting(h: &str, shut_down: bool) {
    let f = harness(h).waits;
    let s = scene(f, &[]);
    let mut a = s.start();
    let thread = a.call("create", s.create_args()).await;
    let id = thread["id"].as_str().unwrap().to_string();
    let mut cmd = s.fixture["steps"][0]["command"].clone();
    cmd["thread_id"] = json!(id);
    a.call("handle", cmd).await;
    a.wait_for(&json!({"type": "request.opened"})).await;
    if shut_down {
        // close() leaves the run going, and recover() picks it up again.
        a.call("close", json!({"stop": false})).await;
        a.exited().await;
    } else {
        a.crash().await;
    }

    let mut b = s.start();
    assert_eq!(b.call("recover", json!(null)).await, json!({"reattached": [id], "lost": []}));
    let snap = b.call("snapshot", json!(id)).await;
    assert_eq!(snap["thread"]["status"], "waiting");
    assert!(snap["thread"]["run"]["reattached_at"].is_string());
    assert_eq!(snap["requests"].as_array().unwrap().len(), 1);
    let respond = json!({"type": "respond", "thread_id": id, "request_id": snap["requests"][0]["id"], "resolution": {"outcome": "allow"}});
    b.call("handle", respond).await;
    b.wait_for(&json!({"type": "thread.updated", "thread": {"status": "idle"}})).await;
    b.call("close", json!({"stop": true})).await;
    b.exited().await;

    check_thread(f, &saved_events(&s.store, &id).await, &s.state, 1);
}

async fn while_streaming(h: &str) {
    let f = harness(h).streams;
    // Replayed at a fifth of the recorded pace, so the backend is killed partway through the turn.
    let s = scene(f, &[("AGENT_THREADS_FIXTURE_SPEED", "0.2")]);
    let mut a = s.start();
    let thread = a.call("create", s.create_args()).await;
    let id = thread["id"].as_str().unwrap().to_string();
    let mut cmd = s.fixture["steps"][0]["command"].clone();
    cmd["thread_id"] = json!(id);
    a.call("handle", cmd).await;
    // The first of its tool calls; more comes after it.
    a.wait_for(&json!({"type": "item.added", "item": {"type": "tool_call"}})).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    a.crash().await;

    let mut b = s.start();
    assert_eq!(b.call("recover", json!(null)).await, json!({"reattached": [id], "lost": []}));
    // The rest of the turn includes approvals the policy answers.
    b.wait_for(&json!({"type": "thread.updated", "thread": {"status": "idle"}})).await;
    b.call("close", json!({"stop": true})).await;
    b.exited().await;

    check_thread(f, &saved_events(&s.store, &id).await, &s.state, 1);
}

async fn ends_while_down(h: &str) {
    let hs = harness(h);
    let s = scene(hs.ends, &[("AGENT_THREADS_FIXTURE_SPEED", hs.pace)]);
    let mut a = s.start();
    let thread = a.call("create", s.create_args()).await;
    let id = thread["id"].as_str().unwrap().to_string();
    let mut cmd = s.fixture["steps"][0]["command"].clone();
    cmd["thread_id"] = json!(id);
    a.call("handle", cmd).await;
    // Partway through the turn.
    let runs = s.runs.clone();
    until(|| std::fs::read_dir(&runs).map(|mut d| d.next().is_some()).unwrap_or(false)).await;
    let run_id = std::fs::read_dir(&s.runs).unwrap().next().unwrap().unwrap().file_name().to_string_lossy().to_string();
    let run_dir = s.runs.join(&run_id);
    let out = {
        let run_dir = run_dir.clone();
        move || std::fs::read_to_string(run_dir.join("out.jsonl")).unwrap_or_default()
    };
    match &hs.partway {
        Partway::Out(text) => until(|| out().contains(text)).await,
        Partway::Event(e) => {
            a.wait_for(e).await;
        }
    }
    a.crash().await;

    // While it's down, the turn finishes and the run ends (its input closed, as a backend would).
    assert!(!out().contains(hs.ended));
    until(|| out().contains(hs.ended)).await;
    std::fs::write(run_dir.join("input.closed"), "").unwrap();
    until(|| run_dir.join("exit").exists()).await;

    let mut b = s.start();
    assert_eq!(b.call("recover", json!(null)).await, json!({"reattached": [id], "lost": []}));
    b.wait_for(&json!({"type": "thread.updated", "thread": {"status": "idle"}})).await;
    // The run's over, and the backend is done with it.
    let events = b.events.clone();
    until(|| events.lock().unwrap().iter().any(|e| e["type"] == "thread.updated" && e["thread"]["status"] == "idle" && e["thread"].get("run").is_none())).await;
    b.call("close", json!({"stop": false})).await;
    b.exited().await;

    check_thread(hs.ends, &saved_events(&s.store, &id).await, &s.state, 1);
    let store = FileStore::open(&s.store).unwrap();
    assert!(store.active_runs().await.unwrap().is_empty());
    let size = std::fs::metadata(run_dir.join("out.jsonl")).unwrap().len();
    assert_eq!(store.get_run(&run_id).await.unwrap().unwrap().offset, Some(size));
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_while_the_turn_waits_on_the_user() {
    while_waiting("claude", false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn codex_while_the_turn_waits_on_the_user() {
    while_waiting("codex", false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_while_output_streams_in() {
    while_streaming("claude").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn codex_while_output_streams_in() {
    while_streaming("codex").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_when_the_run_ends_while_its_down() {
    ends_while_down("claude").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn codex_when_the_run_ends_while_its_down() {
    ends_while_down("codex").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_when_its_shut_down_close_leaves_the_run_going() {
    while_waiting("claude", true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn codex_when_its_shut_down_close_leaves_the_run_going() {
    while_waiting("codex", true).await;
}

/// With mini-claude.mjs as Claude (and mini-codex.mjs as Codex): an app tool that was running when
/// the backend died (or shut down) isn't run again, and the agent is told it may have finished.
async fn app_tool_not_run_again(h: &str, died: bool) {
    let marker = common::temp_dir().join("marker");
    let (claude, codex) = (common::mini("claude"), common::mini("codex"));
    let log = common::temp_dir().join("log.jsonl");
    let s = scene(
        "claude/plain-reply",
        &[
            ("CLAUDE_BIN", claude.to_str().unwrap()),
            ("CODEX_BIN", codex.to_str().unwrap()),
            ("MINI_CLAUDE_LOG", log.to_str().unwrap()),
            ("TOOL_MARKER", marker.to_str().unwrap()),
            ("TOOL_HANG", "1"),
            ("MINI_CLAUDE_TOOL_DELAY", "300"),
            ("MINI_CODEX_TOOL_DELAY", "300"),
        ],
    );
    let mut a = s.start();
    let thread = a.call("create", json!({"harness": h, "cwd": s.cwd})).await;
    let id = thread["id"].as_str().unwrap().to_string();
    a.call("handle", json!({"type": "send", "thread_id": id, "text": "app lookup {}"})).await;
    // It has done what it does, and hasn't returned.
    let m = marker.clone();
    until(move || m.exists()).await;
    if died {
        a.crash().await;
    } else {
        // Shutting down cancels it, which it returns on: it isn't answered, but left for the next.
        a.call("close", json!({"stop": false})).await;
        a.exited().await;
    }

    let mut b = s.start();
    assert_eq!(b.call("recover", json!(null)).await, json!({"reattached": [id], "lost": []}));
    b.wait_for(&json!({"type": "thread.updated", "thread": {"status": "idle"}})).await;
    let snap = b.call("snapshot", json!(id)).await;
    b.call("close", json!({"stop": true})).await;
    b.exited().await;
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "ran\n");
    // The agent was told it may have finished.
    let said: Vec<&str> = snap["items"].as_array().unwrap().iter().filter(|i| i["type"] == "assistant_message").filter_map(|i| i["text"].as_str()).collect();
    assert!(said.join("\n").contains("may or may not have finished"), "{said:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_doesnt_run_an_app_tool_again_that_was_running_when_the_backend_died() {
    app_tool_not_run_again("claude", true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn codex_doesnt_run_an_app_tool_again_that_was_running_when_the_backend_died() {
    app_tool_not_run_again("codex", true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_doesnt_run_an_app_tool_again_that_was_running_when_the_backend_shut_down() {
    app_tool_not_run_again("claude", false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn codex_doesnt_run_an_app_tool_again_that_was_running_when_the_backend_shut_down() {
    app_tool_not_run_again("codex", false).await;
}

/// The backend the tests start: a FileStore, the shim spawner, and Claude Code and Codex played by
/// the fake CLI (or mini-claude.mjs and mini-codex.mjs). It takes `{id, op, args}` lines on stdin
/// and writes `{reply, result}` (or `{reply, error}`) and `{event}` lines to stdout. When it isn't
/// run as one (AGENT_THREADS_BACKEND), it does nothing.
#[test]
fn backend_process() {
    if std::env::var("AGENT_THREADS_BACKEND").is_err() {
        return;
    }
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(backend());
    std::process::exit(0);
}

async fn backend() {
    let env = |k: &str| std::env::var(k).ok();
    let fake_env: std::collections::HashMap<String, Option<String>> =
        std::env::vars().filter(|(k, _)| k.starts_with("AGENT_THREADS_FIXTURE")).map(|(k, v)| (k, Some(v))).collect();
    let store: Arc<dyn Store> = Arc::new(FileStore::open(env("STORE").unwrap()).unwrap());
    let fake = env("FAKE_CLI").unwrap();
    let mut tools = Vec::new();
    if let Some(marker) = env("TOOL_MARKER") {
        let hang = env("TOOL_HANG").is_some();
        tools.push(tool("lookup", "Looks something up.", json!({"type": "object"}), move |_, ctx| {
            let marker = marker.clone();
            async move {
                use std::io::Write;
                let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&marker).unwrap();
                f.write_all(b"ran\n").unwrap();
                if hang {
                    ctx.cancelled.cancelled().await;
                }
                "found it"
            }
        }));
    }
    let mut shim_options = ShimOptions::new(env("RUNS").unwrap());
    shim_options.poll = Duration::from_millis(50);
    let sdk = AgentThreads::new(Options {
        store: Some(store.clone()),
        harnesses: vec![
            claude_code(ClaudeCodeOptions { bin: env("CLAUDE_BIN").unwrap_or(fake.clone()), env: fake_env.clone(), ..Default::default() }),
            codex(CodexOptions {
                bin: env("CODEX_BIN").unwrap_or(fake),
                env: fake_env,
                home: env("CODEX_HOME_DIR").map(PathBuf::from),
                login: None,
                ..Default::default()
            }),
        ],
        spawner: Some(shim(env("SHIM").unwrap(), shim_options)),
        capabilities: Capabilities {
            tools,
            permissions: Some(if env("POLICY").as_deref() == Some("ask") { PermissionPolicy::ask() } else { PermissionPolicy::allow() }),
            ..Default::default()
        },
        on_error: Some(Arc::new(|e| eprintln!("backend error: {e}"))),
        event_capacity: 1 << 16,
    });
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let say = {
        let out = out.clone();
        move |v: Value| {
            use std::io::Write;
            let mut o = out.lock().unwrap();
            let _ = writeln!(o, "{v}");
            let _ = o.flush();
        }
    };
    let mut rx = sdk.subscribe();
    let s = say.clone();
    tokio::spawn(async move {
        while let Ok(e) = rx.recv().await {
            s(json!({"event": e}));
        }
    });
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let msg: Value = serde_json::from_str(&line).unwrap();
        let (id, op, args) = (msg["id"].clone(), msg["op"].as_str().unwrap().to_string(), msg["args"].clone());
        let result: Result<Value, String> = match op.as_str() {
            "create" => {
                let o = CreateOptions {
                    harness: args["harness"].as_str().map(String::from),
                    model: args["model"].as_str().map(String::from),
                    effort: args["effort"].as_str().map(String::from),
                    permission_mode: args.get("permission_mode").and_then(|m| serde_json::from_value(m.clone()).ok()),
                    cwd: args["cwd"].as_str().map(PathBuf::from),
                    ..Default::default()
                };
                sdk.create(o).await.map(|t| serde_json::to_value(t).unwrap()).map_err(|e| e.to_string())
            }
            "handle" => sdk.handle_json(args).await.map(|_| Value::Null).map_err(|e| e.to_string()),
            "snapshot" => sdk.snapshot(args.as_str().unwrap()).await.map(|s| serde_json::to_value(s).unwrap()).map_err(|e| e.to_string()),
            "recover" => sdk.recover().await.map(|r| json!({"reattached": r.reattached, "lost": r.lost})).map_err(|e| e.to_string()),
            "close" => {
                let r = sdk.close(args["stop"].as_bool().unwrap_or(false)).await.map(|_| Value::Null).map_err(|e| e.to_string());
                let _ = store.close().await;
                // Let the subscriber write the last events.
                tokio::time::sleep(Duration::from_millis(50)).await;
                say(json!({"reply": id, "result": r.clone().unwrap_or(Value::Null)}));
                return;
            }
            other => Err(format!("no op {other}")),
        };
        say(match result {
            Ok(r) => json!({"reply": id, "result": r}),
            Err(e) => json!({"reply": id, "error": e}),
        });
    }
}
