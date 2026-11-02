//! The chat example's server: agent-threads' Rust backend, and the app's own transport, a
//! WebSocket (axum). The SDK has no network layer, so this file is the whole "seam": events out
//! (`sdk.subscribe()` → every client), commands in (a client's `command` → `sdk.handle_json`), plus
//! snapshots and `events_since` for clients that connect or reconnect. examples/PROTOCOL.md has the
//! wire format, which the React frontend in examples/chat-node speaks.
//!
//!   cargo run                  the server, on http://127.0.0.1:3001
//!   cargo run -- supervise     the same, started again when it asks to (the restart demo)

mod config;
mod orders;
mod policy;
mod shipping;

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use agent_threads::{
    AgentThreads, Capabilities, ClaudeCodeOptions, CodexOptions, CreateOptions, Error, Harness, McpServer, Options,
    ShimOptions, Skill, SqliteStore, Store, Thread, claude_code, codex, direct, shim,
};
use axum::Router;
use axum::body::Body;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use config::{Config, DEV_PORT, HarnessInfo, RESTART_CODE};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};

#[derive(Clone)]
struct App {
    cfg: Arc<Config>,
    sdk: AgentThreads,
    store: Arc<dyn Store>,
    workspace: PathBuf,
    /// Set to an exit code to shut down with.
    shutdown: watch::Sender<Option<i32>>,
}

#[tokio::main]
async fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("shipping-mcp") => return shipping::serve().await,
        Some("supervise") => std::process::exit(supervise().await),
        _ => {}
    }
    let cfg = match config::config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("chat-rust: {e}");
            std::process::exit(2);
        }
    };
    std::process::exit(serve(cfg).await);
}

// ---------- the backend ----------

/// A harness, or the fake CLI replaying a fixture's recorded session in its place.
fn harness(cfg: &Config, h: &HarnessInfo) -> Arc<dyn Harness> {
    let mut bin = None;
    let mut env = HashMap::new();
    if let Some(fixture) = &h.fake {
        // Where it keeps which of the session's runs is next: afresh each time, or kept across
        // restarts in CHAT_FAKE_STATE, for a session that has several runs.
        let state = match &cfg.fake_state {
            Some(s) => s.join(&h.name),
            None => {
                let s = cfg.data.join(format!("fake-{}", h.name));
                let _ = std::fs::remove_dir_all(&s);
                s
            }
        };
        let _ = std::fs::create_dir_all(&state);
        bin = Some((
            "node".to_string(),
            vec![
                config::repo()
                    .join("spec/tools/fake-cli.mjs")
                    .to_string_lossy()
                    .to_string(),
            ],
        ));
        env.insert(
            "AGENT_THREADS_FIXTURE".to_string(),
            Some(fixture.to_string_lossy().to_string()),
        );
        env.insert(
            "AGENT_THREADS_FIXTURE_STATE".to_string(),
            Some(state.to_string_lossy().to_string()),
        );
    }
    if h.name == "claude" {
        let mut o = ClaudeCodeOptions {
            env,
            ..Default::default()
        };
        if let Some((b, args)) = bin {
            (o.bin, o.bin_args) = (b, args);
        }
        return claude_code(o);
    }
    // Codex keeps the app's sessions in a CODEX_HOME of the app's own (with the user's login linked
    // in).
    let mut o = CodexOptions {
        env,
        home: Some(cfg.data.join("codex-home")),
        ..Default::default()
    };
    if let Some((b, args)) = bin {
        (o.bin, o.bin_args) = (b, args);
    }
    codex(o)
}

async fn serve(cfg: Config) -> i32 {
    let workspace = cfg.data.join("workspace"); // the agents' working directory
    if let Err(e) = std::fs::create_dir_all(&workspace) {
        eprintln!("chat-rust: {}: {e}", workspace.display());
        return 1;
    }
    let store: Arc<dyn Store> = match SqliteStore::open(cfg.data.join("threads.db")) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("chat-rust: the store can't be opened: {e}");
            return 1;
        }
    };
    let me = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or("chat-rust".into());
    // The recorded sessions had no MCP server or skill, and the fake CLI checks that.
    let (tools, mcp_servers, skills) = match cfg.fake {
        Some(with_tools) => (
            if with_tools {
                vec![orders::lookup_order()]
            } else {
                vec![]
            },
            Default::default(),
            vec![],
        ),
        None => (
            vec![orders::lookup_order()],
            [("shipping".to_string(), McpServer::stdio(me, ["shipping-mcp"]))].into(),
            vec![Skill::Dir(config::root().join("skills/order-support"))],
        ),
    };
    let spawner = match &cfg.shim {
        Some(path) => shim(path, ShimOptions::new(cfg.data.join("runs"))),
        None => direct(),
    };
    let sdk = AgentThreads::new(Options {
        store: Some(store.clone()),
        harnesses: cfg.harnesses.iter().map(|h| harness(&cfg, h)).collect(),
        spawner: Some(spawner),
        capabilities: Capabilities {
            tools,
            mcp_servers,
            skills,
            permissions: Some(policy::permissions()),
            system_prompt: Some(
                "You're the support agent for Widget Co., a small online shop. Use the order-support skill for questions about orders."
                    .into(),
            ),
        },
        on_error: Some(Arc::new(|e| eprintln!("agent-threads: {e}"))),
        ..Default::default()
    });

    // Runs that outlived the last server (with the shim) carry on from where it left them.
    if cfg.shim.is_some() {
        match sdk.recover().await {
            Ok(r) if !r.reattached.is_empty() || !r.lost.is_empty() => {
                println!(
                    "recovered: {} run(s) re-attached, {} lost",
                    r.reattached.len(),
                    r.lost.len()
                )
            }
            Ok(_) => {}
            Err(e) => eprintln!("recover: {e}"),
        }
    }

    // ---------- the transport ----------

    let (shutdown, mut stop) = watch::channel(None);
    let app = App {
        cfg: Arc::new(cfg.clone()),
        sdk: sdk.clone(),
        store,
        workspace,
        shutdown,
    };
    let router = Router::new()
        .route("/ws", get(ws))
        .fallback(files)
        .with_state(app.clone());
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", cfg.port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("chat-rust: port {}: {e}", cfg.port);
            return 1;
        }
    };
    let what: Vec<String> = cfg
        .harnesses
        .iter()
        .map(|h| format!("{}{}", h.name, if h.fake.is_some() { " (fake)" } else { "" }))
        .collect();
    println!(
        "chat-rust on http://127.0.0.1:{} with {}{}; data in {}",
        cfg.port,
        what.join(", "),
        if cfg.shim.is_some() { ", under the shim" } else { "" },
        cfg.data.display()
    );
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let signals = app.shutdown.clone();
    tokio::spawn(async move {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
        signals.send_replace(Some(0));
    });
    let code = loop {
        if let Some(code) = *stop.borrow_and_update() {
            break code;
        }
        if stop.changed().await.is_err() {
            break 0;
        }
    };
    // Stops the harness processes, or with the shim leaves them running for the next server to
    // re-attach to. The WebSockets go with the process.
    if let Err(e) = app.sdk.close(false).await {
        eprintln!("close: {e}");
    }
    let _ = app.store.close().await; // The store is the app's to close.
    code
}

/// Whether a WebSocket may connect. Listening on 127.0.0.1 isn't enough: any page the user has open
/// can open a WebSocket to it, and the socket can read every thread, send the agent anything and
/// allow its own permission requests. So it must come from this app's own page (its Origin is the
/// host it connects to), on a loopback name (which a rebound DNS name isn't), at this server or,
/// with CHAT_DEV, Vite's dev server (whose proxy keeps the Host and Origin). Clients that aren't browsers send no
/// Origin. This is the example's only check: a real app authenticates its users here too.
fn trusted(headers: &HeaderMap, port: u16, dev: bool) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|h| h.to_str().ok()) else {
        return false;
    };
    let ok = ["localhost", "127.0.0.1", "[::1]"].iter().any(|name| {
        [Some(port), dev.then_some(DEV_PORT)]
            .iter()
            .flatten()
            .any(|p| host == format!("{name}:{p}"))
    });
    if !ok {
        return false;
    }
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else { return false };
    // scheme://host[:port], nothing after.
    origin
        .split_once("://")
        .is_some_and(|(scheme, rest)| (scheme == "http" || scheme == "https") && rest == host)
}

async fn ws(State(app): State<App>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    if !trusted(&headers, app.cfg.port, app.cfg.dev) {
        return (StatusCode::FORBIDDEN, "Forbidden\n").into_response();
    }
    // Enough for a message with attachments.
    upgrade
        .max_message_size(16 * 1024 * 1024)
        .on_upgrade(move |socket| client(app, socket))
}

/// One client: every thread's events out, its requests in, one reply each.
async fn client(app: App, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (out, mut frames) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(frame) = frames.recv().await {
            if sink.send(frame).await.is_err() {
                return;
            }
        }
    });
    // Events out: every thread's events (deltas included), as they happen. A client that falls
    // too far behind misses some, and catches up with events_since when it sees the gap.
    let mut events = app.sdk.subscribe();
    let pusher = {
        let out = out.clone();
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event) => {
                        let frame = json!({"type": "event", "event": event}).to_string();
                        if out.send(Message::Text(frame.into())).is_err() {
                            return;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => return,
                }
            }
        })
    };
    let mut restarting = app.shutdown.subscribe();
    loop {
        let frame = tokio::select! {
            f = stream.next() => f,
            _ = restarting.changed() => {
                let _ = out.send(Message::Close(Some(CloseFrame { code: 1012, reason: "restarting".into() })));
                break;
            }
        };
        // A frame the socket can't take (text that isn't UTF-8, one too big) ends this socket only.
        let Some(Ok(frame)) = frame else { break };
        let Message::Text(text) = frame else { continue };
        // Anything that isn't a request is ignored: with no id, it can't be answered.
        let Ok(req) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(id) = req.get("id").filter(|i| i.is_number() || i.is_string()).cloned() else {
            continue;
        };
        let Some(method) = req.get("method").and_then(Value::as_str).map(String::from) else {
            continue;
        };
        let params = match req.get("params") {
            None => json!({}),
            Some(p) if p.is_object() || p.is_array() => p.clone(),
            Some(_) => continue,
        };
        let (app, out) = (app.clone(), out.clone());
        tokio::spawn(async move {
            let reply = match call(&app, &method, params).await {
                Ok(result) => json!({"id": id, "result": result}),
                Err(error) => json!({"id": id, "error": error}),
            };
            let _ = out.send(Message::Text(reply.to_string().into()));
        });
    }
    pusher.abort();
    drop(out);
    let _ = writer.await;
}

/// The app's methods: what a client asks for, and what the backend says (see
/// examples/PROTOCOL.md). An error is a message for the user.
async fn call(app: &App, method: &str, p: Value) -> Result<Value, String> {
    let sdk = &app.sdk;
    let text = |e: Error| e.to_string();
    let thread_id = || {
        p["thread_id"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| "thread_id is missing".to_string())
    };
    match method {
        "hello" => {
            let harnesses: Vec<Value> = app
                .cfg
                .harnesses
                .iter()
                .map(|h| json!({"name": h.name, "label": h.label, "model": h.model, "models": h.models}))
                .collect();
            Ok(json!({"harnesses": harnesses, "restart": app.cfg.restart()}))
        }
        "list" => {
            let mut threads: Vec<Thread> = sdk.list().await.map_err(text)?;
            threads.sort_by(|a, b| b.created_at.cmp(&a.created_at));
            Ok(json!(threads))
        }
        "create" => {
            let name = p["harness"].as_str().unwrap_or("");
            let Some(h) = app.cfg.harnesses.iter().find(|h| h.name == name) else {
                return Err(format!("there's no harness {}", p["harness"]));
            };
            let model = p["model"]
                .as_str()
                .filter(|m| !m.is_empty())
                .unwrap_or(&h.model)
                .to_string();
            let title = p["title"]
                .as_str()
                .filter(|t| !t.is_empty())
                .map(|t| t.chars().take(80).collect());
            let o = CreateOptions {
                harness: Some(h.name.clone()),
                model: Some(model),
                effort: h.effort.clone(),
                title,
                cwd: Some(app.workspace.clone()),
                ..Default::default()
            };
            Ok(json!(sdk.create(o).await.map_err(text)?))
        }
        "snapshot" => Ok(json!(sdk.snapshot(&thread_id()?).await.map_err(text)?)),
        "events_since" => {
            let seq = p["seq"].as_u64().unwrap_or(0);
            Ok(json!(sdk.events_since(&thread_id()?, seq, None).await.map_err(text)?))
        }
        // Commands in: send, interrupt, respond, set_options, rewind, new_session and compact,
        // checked and carried out by the backend.
        "command" => {
            sdk.handle_json(p["command"].clone()).await.map_err(text)?;
            Ok(Value::Null)
        }
        "restart" => {
            if !app.cfg.restart() {
                return Err("this server isn't run by `chat-rust supervise` with its runs under the shim, so it doesn't restart".into());
            }
            let shutdown = app.shutdown.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                shutdown.send_replace(Some(RESTART_CODE));
            });
            Ok(Value::Null)
        }
        other => Err(format!("there's no method {other:?}")),
    }
}

// ---------- the frontend ----------

/// Serves the built frontend, with index.html for any path that isn't a file.
async fn files(State(app): State<App>, req: Request) -> Response {
    let root = &app.cfg.web;
    let Some(path) = percent_decode(req.uri().path()) else {
        // A malformed escape (/%E0).
        return (StatusCode::BAD_REQUEST, "Bad request\n").into_response();
    };
    // Only plain names: nothing that climbs out of the root.
    let safe = Path::new(&path)
        .components()
        .all(|c| matches!(c, Component::RootDir | Component::Normal(_)));
    let mut file = root.join(path.trim_start_matches('/'));
    if !safe || !tokio::fs::metadata(&file).await.is_ok_and(|m| m.is_file()) {
        file = root.join("index.html");
    }
    let Ok(body) = tokio::fs::read(&file).await else {
        return (
            StatusCode::NOT_FOUND,
            "The frontend isn't built: run pnpm build in examples/chat-node.\n",
        )
            .into_response();
    };
    let kind = match file.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "json" | "map" => "application/json",
        _ => "application/octet-stream",
    };
    // Vite's assets have their hash in their names; index.html must be fetched fresh. Only the path
    // inside the root counts: an `assets` directory above it doesn't.
    let asset = file
        .strip_prefix(root)
        .is_ok_and(|p| p.components().any(|c| c.as_os_str() == "assets"));
    let cache = if asset {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    Response::builder()
        .header(header::CONTENT_TYPE, kind)
        .header(header::CACHE_CONTROL, cache)
        .body(Body::from(body))
        .unwrap()
}

/// A URL path with its %-escapes decoded, or none if one is malformed or the result isn't UTF-8.
fn percent_decode(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

// ---------- supervising ----------

/// Runs the server, and starts it again when it exits asking to (the frontend's Restart button, for
/// the restart demo): with CHAT_SHIM set, its harness runs carry on meanwhile, and the new server
/// re-attaches to them.
async fn supervise() -> i32 {
    let me = std::env::current_exe().expect("the server's own path");
    loop {
        let Ok(mut child) = tokio::process::Command::new(&me).env("CHAT_SUPERVISED", "1").spawn() else {
            eprintln!("chat-rust: the server couldn't be started");
            return 1;
        };
        // Ctrl-C goes to the whole process group, so the server gets it too and shuts down by itself.
        let status = loop {
            tokio::select! {
                s = child.wait() => break s,
                _ = tokio::signal::ctrl_c() => {}
            }
        };
        match status.ok().and_then(|s| s.code()) {
            Some(RESTART_CODE) => println!("restarting the server…"),
            Some(code) => return code,
            None => return 1,
        }
    }
}
