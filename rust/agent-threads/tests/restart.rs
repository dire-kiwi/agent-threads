//! Runs that survive a backend restart: a backend (this test binary, run as `backend_process`, in a
//! process of its own) runs a fixture's turn under the shim, and is killed with SIGKILL partway
//! through it. A new backend recovers, and the thread finishes as if nothing had happened: the store
//! has exactly the fixture's events (with a notice that the run was picked up again), none lost and
//! none twice. As the Node backend's restart.test.ts does.
#![cfg(unix)]

mod common;

use std::path::{Path, PathBuf};

use agent_threads::{RunRecord, StoreResult};
use async_trait::async_trait;
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
                // The test harness's own output is mixed in (`test backend_process ... ` goes before
                // the first line, with no newline): only our JSON counts.
                let Some(at) = line.find('{') else { continue };
                let Ok(msg) = serde_json::from_str::<Value>(&line[at..]) else {
                    continue;
                };
                if let Some(e) = msg.get("event") {
                    ev.lock().unwrap().push(e.clone());
                } else if let Some(id) = msg["reply"].as_u64()
                    && let Some(tx) = rep.lock().unwrap().remove(&id)
                {
                    let _ = tx.send(msg);
                }
            }
        });
        Backend {
            child,
            stdin,
            events,
            replies,
            next: 1,
        }
    }

    async fn call(&mut self, op: &str, args: Value) -> Value {
        let id = self.next;
        self.next += 1;
        let (tx, rx) = oneshot::channel();
        self.replies.lock().unwrap().insert(id, tx);
        let line = json!({"id": id, "op": op, "args": args}).to_string() + "\n";
        self.stdin.write_all(line.as_bytes()).await.unwrap();
        let r = tokio::time::timeout(Duration::from_secs(30), rx)
            .await
            .expect("the backend answers")
            .unwrap();
        assert!(r.get("error").is_none(), "{op}: {}", r["error"]);
        r["result"].clone()
    }

    /// Sends a request without waiting for its reply.
    async fn send_only(&mut self, op: &str, args: Value) {
        let id = self.next;
        self.next += 1;
        let line = json!({"id": id, "op": op, "args": args}).to_string() + "\n";
        self.stdin.write_all(line.as_bytes()).await.unwrap();
    }

    async fn wait_for(&self, pattern: &Value) -> Value {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(e) = self.events.lock().unwrap().iter().find(|e| matches(e, pattern)) {
                return e.clone();
            }
            assert!(
                Instant::now() < deadline,
                "no event like {pattern}; got:\n{}",
                self.show()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn show(&self) -> String {
        self.events
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.to_string().chars().take(200).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Kills it as a crash would: no chance to save anything or stop anything.
    async fn crash(mut self) {
        self.child.kill().await.unwrap();
    }

    async fn exited(mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(30), self.child.wait())
            .await
            .expect("the backend exits");
    }
}

/// A snapshot's open requests (those without a resolution), as JSON.
fn open_requests(snap: &Value) -> Vec<&Value> {
    snap["requests"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r.get("resolution").is_none())
        .collect()
}

fn matches(v: &Value, p: &Value) -> bool {
    match p {
        Value::Object(p) => v.is_object() && p.iter().all(|(k, x)| matches(v.get(k).unwrap_or(&Value::Null), x)),
        _ => v == p,
    }
}

/// Waits until `what` holds, for up to 30s (failing where it was called from).
#[track_caller]
fn until(what: impl Fn() -> bool) -> impl std::future::Future<Output = ()> {
    let at = std::panic::Location::caller();
    async move {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !what() {
            assert!(Instant::now() < deadline, "timed out waiting at {at}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

/// One test at a time, as the Node backend's restart tests run: each has backends, harnesses and
/// shims of its own, with graces and save delays that a loaded machine would stretch.
async fn serial() -> tokio::sync::MutexGuard<'static, ()> {
    static ONE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    ONE.lock().await
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
    let (store, runs, state, cwd) = (
        common::temp_dir(),
        common::temp_dir(),
        common::temp_dir(),
        common::temp_dir(),
    );
    let f = common::read_json(&format!("fixtures/{fixture}/fixture.json"));
    let s = |p: &Path| p.to_string_lossy().to_string();
    let mut env = vec![
        ("STORE".into(), s(&store)),
        ("RUNS".into(), s(&runs)),
        ("CODEX_HOME_DIR".into(), s(&common::temp_dir())),
        ("SHIM".into(), s(&common::shim_path())),
        ("FAKE_CLI".into(), s(&common::spec_dir().join("tools/fake-cli.mjs"))),
        (
            "AGENT_THREADS_FIXTURE".into(),
            s(&common::spec_dir().join("fixtures").join(fixture)),
        ),
        ("AGENT_THREADS_FIXTURE_STATE".into(), s(&state)),
        ("POLICY".into(), f["permissions"].as_str().unwrap_or("allow").into()),
    ];
    for (k, v) in extra {
        env.retain(|(x, _)| x != k);
        env.push((k.to_string(), v.to_string()));
    }
    Scene {
        store,
        runs,
        state,
        cwd,
        env,
        fixture: f,
    }
}

impl Drop for Scene {
    /// Kills the runs its backends left (which outlive them), so a test that fails leaves nothing
    /// running.
    fn drop(&mut self) {
        agent_threads::kill_runs(&self.runs);
    }
}

impl Scene {
    fn start(&self) -> Backend {
        Backend::start(&self.env)
    }

    /// A backend with more environment.
    fn start_with(&self, more: &[(&str, &str)]) -> Backend {
        let mut env = self.env.clone();
        env.extend(more.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        Backend::start(&env)
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
    let is_notice =
        |e: &Value| e["type"] == "item.added" && e["item"]["type"] == "notice" && e["item"]["code"] == "run.reattached";
    assert_eq!(
        saved.iter().filter(|e| is_notice(e)).count(),
        reattached,
        "run.reattached notices"
    );
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
        panic!(
            "{e}\n\nSaved events:\n{}",
            saved
                .iter()
                .map(|e| e.to_string().chars().take(300).collect::<String>())
                .collect::<Vec<_>>()
                .join("\n")
        );
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
    assert_eq!(
        b.call("recover", json!(null)).await,
        json!({"reattached": [id], "lost": []})
    );
    let snap = b.call("snapshot", json!(id)).await;
    assert_eq!(snap["thread"]["status"], "waiting");
    assert!(snap["thread"]["run"]["reattached_at"].is_string());
    let open = open_requests(&snap);
    assert_eq!(open.len(), 1);
    let respond =
        json!({"type": "respond", "thread_id": id, "request_id": open[0]["id"], "resolution": {"outcome": "allow"}});
    b.call("handle", respond).await;
    b.wait_for(&json!({"type": "thread.updated", "thread": {"status": "idle"}}))
        .await;
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
    a.wait_for(&json!({"type": "item.added", "item": {"type": "tool_call"}}))
        .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    a.crash().await;

    let mut b = s.start();
    assert_eq!(
        b.call("recover", json!(null)).await,
        json!({"reattached": [id], "lost": []})
    );
    // The rest of the turn includes approvals the policy answers.
    b.wait_for(&json!({"type": "thread.updated", "thread": {"status": "idle"}}))
        .await;
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
    until(|| {
        std::fs::read_dir(&runs)
            .map(|mut d| d.next().is_some())
            .unwrap_or(false)
    })
    .await;
    let run_id = std::fs::read_dir(&s.runs)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .file_name()
        .to_string_lossy()
        .to_string();
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
    assert_eq!(
        b.call("recover", json!(null)).await,
        json!({"reattached": [id], "lost": []})
    );
    b.wait_for(&json!({"type": "thread.updated", "thread": {"status": "idle"}}))
        .await;
    // The run's over, and the backend is done with it.
    let events = b.events.clone();
    until(|| {
        events.lock().unwrap().iter().any(|e| {
            e["type"] == "thread.updated" && e["thread"]["status"] == "idle" && e["thread"].get("run").is_none()
        })
    })
    .await;
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
    let _one = serial().await;
    while_waiting("claude", false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn codex_while_the_turn_waits_on_the_user() {
    let _one = serial().await;
    while_waiting("codex", false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_while_output_streams_in() {
    let _one = serial().await;
    while_streaming("claude").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn codex_while_output_streams_in() {
    let _one = serial().await;
    while_streaming("codex").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_when_the_run_ends_while_its_down() {
    let _one = serial().await;
    ends_while_down("claude").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn codex_when_the_run_ends_while_its_down() {
    let _one = serial().await;
    ends_while_down("codex").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_when_its_shut_down_close_leaves_the_run_going() {
    let _one = serial().await;
    while_waiting("claude", true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn codex_when_its_shut_down_close_leaves_the_run_going() {
    let _one = serial().await;
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
    a.call(
        "handle",
        json!({"type": "send", "thread_id": id, "text": "app lookup {}"}),
    )
    .await;
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
    assert_eq!(
        b.call("recover", json!(null)).await,
        json!({"reattached": [id], "lost": []})
    );
    b.wait_for(&json!({"type": "thread.updated", "thread": {"status": "idle"}}))
        .await;
    let snap = b.call("snapshot", json!(id)).await;
    b.call("close", json!({"stop": true})).await;
    b.exited().await;
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "ran\n");
    // The agent was told it may have finished.
    let said: Vec<&str> = snap["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["type"] == "assistant_message")
        .filter_map(|i| i["text"].as_str())
        .collect();
    assert!(said.join("\n").contains("may or may not have finished"), "{said:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_doesnt_run_an_app_tool_again_that_was_running_when_the_backend_died() {
    let _one = serial().await;
    app_tool_not_run_again("claude", true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn codex_doesnt_run_an_app_tool_again_that_was_running_when_the_backend_died() {
    let _one = serial().await;
    app_tool_not_run_again("codex", true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_doesnt_run_an_app_tool_again_that_was_running_when_the_backend_shut_down() {
    let _one = serial().await;
    app_tool_not_run_again("claude", false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn codex_doesnt_run_an_app_tool_again_that_was_running_when_the_backend_shut_down() {
    let _one = serial().await;
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
    let fake_env: std::collections::HashMap<String, Option<String>> = std::env::vars()
        .filter(|(k, _)| k.starts_with("AGENT_THREADS_FIXTURE"))
        .map(|(k, v)| (k, Some(v)))
        .collect();
    let file: Arc<dyn Store> = Arc::new(FileStore::open(env("STORE").unwrap()).unwrap());
    // With SAVE_DELAY_MS, each save (append_events) takes that long.
    let store: Arc<dyn Store> = match env("SAVE_DELAY_MS") {
        Some(ms) => Arc::new(SlowStore {
            inner: file,
            delay: Duration::from_millis(ms.parse().unwrap()),
        }),
        None => file,
    };
    let ms = |k: &str| env(k).map(|v| Duration::from_millis(v.parse().unwrap()));
    let (stop_grace, close_grace) = (ms("STOP_GRACE_MS"), ms("CLOSE_GRACE_MS"));
    let fake = env("FAKE_CLI").unwrap();
    let mut tools = Vec::new();
    if let Some(marker) = env("TOOL_MARKER") {
        let hang = env("TOOL_HANG").is_some();
        tools.push(tool(
            "lookup",
            "Looks something up.",
            json!({"type": "object"}),
            move |_, ctx| {
                let marker = marker.clone();
                async move {
                    use std::io::Write;
                    let mut f = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&marker)
                        .unwrap();
                    f.write_all(b"ran\n").unwrap();
                    if hang {
                        ctx.cancelled.cancelled().await;
                    }
                    "found it"
                }
            },
        ));
    }
    let mut shim_options = ShimOptions::new(env("RUNS").unwrap());
    shim_options.poll = Duration::from_millis(50);
    let sdk = AgentThreads::new(Options {
        store: Some(store.clone()),
        harnesses: vec![
            claude_code(ClaudeCodeOptions {
                bin: env("CLAUDE_BIN").unwrap_or(fake.clone()),
                env: fake_env.clone(),
                stop_grace: stop_grace.unwrap_or(Duration::from_secs(10)),
                close_grace: close_grace.unwrap_or(Duration::from_secs(5)),
                ..Default::default()
            }),
            codex(CodexOptions {
                bin: env("CODEX_BIN").unwrap_or(fake),
                env: fake_env,
                home: env("CODEX_HOME_DIR").map(PathBuf::from),
                login: None,
                stop_grace: stop_grace.unwrap_or(Duration::from_secs(10)),
                close_grace: close_grace.unwrap_or(Duration::from_secs(5)),
                ..Default::default()
            }),
        ],
        spawner: Some(shim(env("SHIM").unwrap(), shim_options)),
        capabilities: Capabilities {
            tools,
            permissions: Some(if env("POLICY").as_deref() == Some("ask") {
                PermissionPolicy::ask()
            } else {
                PermissionPolicy::allow()
            }),
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
        let (id, op, args) = (
            msg["id"].clone(),
            msg["op"].as_str().unwrap().to_string(),
            msg["args"].clone(),
        );
        let result: Result<Value, String> = match op.as_str() {
            "create" => {
                let o = CreateOptions {
                    harness: args["harness"].as_str().map(String::from),
                    model: args["model"].as_str().map(String::from),
                    effort: args["effort"].as_str().map(String::from),
                    permission_mode: args
                        .get("permission_mode")
                        .and_then(|m| serde_json::from_value(m.clone()).ok()),
                    cwd: args["cwd"].as_str().map(PathBuf::from),
                    ..Default::default()
                };
                sdk.create(o)
                    .await
                    .map(|t| serde_json::to_value(t).unwrap())
                    .map_err(|e| e.to_string())
            }
            "handle" => sdk
                .handle_json(args)
                .await
                .map(|_| Value::Null)
                .map_err(|e| e.to_string()),
            "snapshot" => sdk
                .snapshot(args.as_str().unwrap())
                .await
                .map(|s| serde_json::to_value(s).unwrap())
                .map_err(|e| e.to_string()),
            // Resolves once every event so far is saved (and the run with them).
            "saved" => sdk
                .events_since(args.as_str().unwrap(), 0, None)
                .await
                .map(|_| Value::Null)
                .map_err(|e| e.to_string()),
            "recover" => sdk
                .recover()
                .await
                .map(|r| json!({"reattached": r.reattached, "lost": r.lost}))
                .map_err(|e| e.to_string()),
            "close" => {
                let r = sdk
                    .close(args["stop"].as_bool().unwrap_or(false))
                    .await
                    .map(|_| Value::Null)
                    .map_err(|e| e.to_string());
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

/// A store whose appends take a while.
struct SlowStore {
    inner: Arc<dyn Store>,
    delay: Duration,
}

#[async_trait]
impl Store for SlowStore {
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
        tokio::time::sleep(self.delay).await;
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
        self.inner.get_run(id).await
    }
    async fn active_runs(&self) -> StoreResult<Vec<RunRecord>> {
        self.inner.active_runs().await
    }
    async fn close(&self) -> StoreResult<()> {
        self.inner.close().await
    }
}

/// A scene with mini-claude.mjs as Claude and mini-codex.mjs as Codex, for what the recordings don't
/// cover.
fn mini_scene(extra: &[(&str, &str)]) -> Scene {
    let (claude, codex) = (common::mini("claude"), common::mini("codex"));
    let log = common::temp_dir().join("log.jsonl");
    let mut all = vec![
        ("CLAUDE_BIN", claude.to_string_lossy().to_string()),
        ("CODEX_BIN", codex.to_string_lossy().to_string()),
        ("MINI_CLAUDE_LOG", log.to_string_lossy().to_string()),
    ];
    all.extend(extra.iter().map(|(k, v)| (*k, v.to_string())));
    let all: Vec<(&str, &str)> = all.iter().map(|(k, v)| (*k, v.as_str())).collect();
    scene("claude/plain-reply", &all)
}

fn pid_alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

/// A run that ignores an interrupt is still stopped when the backend dies right after sending it:
/// the interrupt is saved before it's sent.
async fn stops_a_run_that_ignores_an_interrupt(harness: &str, interrupt: &str, shut_down: bool) {
    // Shutting down waits on a save or two (SAVE_DELAY_MS), which must end within the grace.
    let grace = if shut_down { "4000" } else { "1000" };
    let s = mini_scene(&[("STOP_GRACE_MS", grace), ("CLOSE_GRACE_MS", "500")]);
    // Saving takes a while, so the backend is killed after the interrupt is sent, and before any
    // save that comes after it would be done.
    let mut a = s.start_with(&[("SAVE_DELAY_MS", "500")]);
    let thread = a.call("create", json!({"harness": harness, "cwd": s.cwd})).await;
    let id = thread["id"].as_str().unwrap().to_string();
    a.call("handle", json!({"type": "send", "thread_id": id, "text": "stubborn"}))
        .await;
    a.wait_for(&json!({"type": "turn.started"})).await;
    let runs = s.runs.clone();
    until(|| {
        std::fs::read_dir(&runs)
            .map(|mut d| d.next().is_some())
            .unwrap_or(false)
    })
    .await;
    let run_dir = std::fs::read_dir(&s.runs).unwrap().next().unwrap().unwrap().path();
    let pid_file = run_dir.join("pid");
    until(|| pid_file.exists()).await;
    // It has taken in the message, and ignores interrupts from now on.
    tokio::time::sleep(Duration::from_millis(500)).await;
    a.call("saved", json!(id)).await;
    a.send_only("handle", json!({"type": "interrupt", "thread_id": id}))
        .await;
    let input = run_dir.join("input.jsonl");
    until(|| std::fs::read_to_string(&input).unwrap_or_default().contains(interrupt)).await;
    if shut_down {
        // Shut down before the interrupt's grace is over: the stop it's due is saved with the run.
        a.call("close", json!({"stop": false})).await;
        a.exited().await;
    } else {
        a.crash().await;
    }
    let pid: i32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
    assert!(pid_alive(pid));

    let mut b = s.start();
    assert_eq!(
        b.call("recover", json!(null)).await,
        json!({"reattached": [id], "lost": []})
    );
    // Stopped once the interrupt's grace is over, and the turn ends as interrupted.
    until(|| !pid_alive(pid)).await;
    b.wait_for(&json!({"type": "turn.completed"})).await;
    let result = b
        .wait_for(&json!({"type": "item.added", "item": {"type": "turn_result"}}))
        .await;
    assert_eq!(result["item"]["interrupted"], true);
    let stopping = run_dir.join("stopping");
    until(|| !stopping.exists()).await;
    b.call("close", json!({"stop": true})).await;
    b.exited().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_stops_a_run_that_ignores_an_interrupt_when_the_backend_dies_right_after_it() {
    let _one = serial().await;
    stops_a_run_that_ignores_an_interrupt("claude", r#""subtype":"interrupt""#, false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_stops_a_run_that_ignores_an_interrupt_after_the_backend_shuts_down_during_its_grace() {
    let _one = serial().await;
    stops_a_run_that_ignores_an_interrupt("claude", r#""subtype":"interrupt""#, true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn codex_stops_a_run_that_ignores_an_interrupt_after_the_backend_shuts_down_during_its_grace() {
    let _one = serial().await;
    stops_a_run_that_ignores_an_interrupt("codex", r#""method":"turn/interrupt""#, true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn codex_stops_a_run_that_ignores_an_interrupt_when_the_backend_dies_right_after_it() {
    let _one = serial().await;
    stops_a_run_that_ignores_an_interrupt("codex", r#""method":"turn/interrupt""#, false).await;
}

/// What the user answered just before the backend died isn't asked again (whether or not the
/// request's opening was saved), and is answered once.
async fn doesnt_ask_again(harness: &str, opening_saved: bool, text: &str, answer: &str) {
    // Claude asks a while after the tool call, and the turn runs on for a while after it's allowed
    // (Codex's turn waits before and after the command).
    let s = mini_scene(&[
        ("POLICY", "ask"),
        ("MINI_CLAUDE_ASK_DELAY", "1000"),
        ("MINI_CLAUDE_TOOL_RUN_MS", "3000"),
    ]);
    // Saving takes a while, so the backend is killed after the answer is sent, and before the save
    // that has it is done: and, unless the request's opening is saved first, before that is.
    let mut a = s.start_with(&[("SAVE_DELAY_MS", "500")]);
    let thread = a.call("create", json!({"harness": harness, "cwd": s.cwd})).await;
    let id = thread["id"].as_str().unwrap().to_string();
    a.call("handle", json!({"type": "send", "thread_id": id, "text": text}))
        .await;
    a.wait_for(&json!({"type": "turn.started"})).await;
    // The run and its turn are saved before the request comes.
    a.call("saved", json!(id)).await;
    let opened = a.wait_for(&json!({"type": "request.opened"})).await;
    let request_id = opened["request"]["id"].as_str().unwrap().to_string();
    if opening_saved {
        a.call("saved", json!(id)).await;
    }
    let run_dir = std::fs::read_dir(&s.runs).unwrap().next().unwrap().unwrap().path();
    let input = run_dir.join("input.jsonl");
    let read = move || std::fs::read_to_string(&input).unwrap_or_default();
    let respond =
        json!({"type": "respond", "thread_id": id, "request_id": request_id, "resolution": {"outcome": "allow"}});
    a.send_only("handle", respond).await;
    let r = read.clone();
    until(move || r().contains(answer)).await;
    a.crash().await;

    let mut b = s.start();
    assert_eq!(
        b.call("recover", json!(null)).await,
        json!({"reattached": [id], "lost": []})
    );
    // The tool's still running: nothing's asked of the user, and the turn runs on.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let snap = b.call("snapshot", json!(id)).await;
    assert_eq!(open_requests(&snap), Vec::<&Value>::new());
    assert_eq!(snap["thread"]["status"], "running");
    let events = b.events.lock().unwrap().clone();
    assert!(!events.iter().any(|e| e["type"] == "request.opened"));
    if opening_saved {
        // Closed as the run's picked up again.
        let resolved = events
            .iter()
            .position(|e| e["type"] == "request.resolved" && e["request_id"] == request_id);
        let notice = events
            .iter()
            .position(|e| e["type"] == "item.added" && e["item"]["code"] == "run.reattached");
        assert!(resolved.is_some() && resolved < notice, "{resolved:?} {notice:?}");
    }
    b.wait_for(&json!({"type": "turn.completed"})).await;
    b.call("close", json!({"stop": true})).await;
    b.exited().await;
    // Answered once.
    assert_eq!(read().matches(answer).count(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_doesnt_ask_again_what_the_user_answered_just_before_the_backend_died_saved() {
    let _one = serial().await;
    doesnt_ask_again("claude", true, "tool Bash {}", r#""behavior":"allow""#).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn codex_doesnt_ask_again_what_the_user_answered_just_before_the_backend_died_saved() {
    let _one = serial().await;
    doesnt_ask_again(
        "codex",
        true,
        "sleep 1000\nexec ls\nsleep 3000",
        r#""decision":"accept""#,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_doesnt_ask_again_what_the_user_answered_just_before_the_backend_died_not_saved() {
    let _one = serial().await;
    doesnt_ask_again("claude", false, "tool Bash {}", r#""behavior":"allow""#).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn codex_doesnt_ask_again_what_the_user_answered_just_before_the_backend_died_not_saved() {
    let _one = serial().await;
    doesnt_ask_again(
        "codex",
        false,
        "sleep 1000\nexec ls\nsleep 3000",
        r#""decision":"accept""#,
    )
    .await;
}
