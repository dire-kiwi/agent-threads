//! The server end to end, as the frontend uses it (examples/PROTOCOL.md): over its WebSocket, with
//! the fake CLI replaying a recorded session in place of the real `claude`. And who may connect.

use std::process::Stdio;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio_tungstenite::tungstenite::{self, Message, client::IntoClientRequest};

fn repo() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

/// The server on a free port, with a data directory of its own; killed when dropped.
struct Server {
    port: u16,
    _child: tokio::process::Child,
    _data: tempfile::TempDir,
}

async fn start(fixture: &str) -> Server {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let data = tempfile::tempdir().unwrap();
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_chat-rust"))
        .env("PORT", port.to_string())
        .env("CHAT_DATA", data.path())
        .env("CHAT_FAKE_CLAUDE", repo().join("spec/fixtures").join(fixture))
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = tokio::time::timeout(Duration::from_secs(20), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(line.starts_with("chat-rust on"), "{line}");
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    Server {
        port,
        _child: child,
        _data: data,
    }
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// A client, as the frontend is: its requests' replies by id, and the events pushed to it.
struct Client {
    ws: Socket,
    next: u64,
    events: Vec<Value>,
}

impl Client {
    async fn connect(port: u16, origin: Option<&str>) -> Result<Client, tungstenite::Error> {
        let mut req = format!("ws://127.0.0.1:{port}/ws").into_client_request().unwrap();
        if let Some(o) = origin {
            req.headers_mut().insert("Origin", o.parse().unwrap());
        }
        let (ws, _) = tokio_tungstenite::connect_async(req).await?;
        Ok(Client {
            ws,
            next: 1,
            events: Vec::new(),
        })
    }

    async fn recv(&mut self) -> Value {
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(15), self.ws.next())
                .await
                .expect("a frame")
                .unwrap()
                .unwrap();
            if let Message::Text(t) = msg {
                return serde_json::from_str(&t).unwrap();
            }
        }
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next;
        self.next += 1;
        self.ws
            .send(Message::Text(
                json!({"id": id, "method": method, "params": params}).to_string().into(),
            ))
            .await
            .unwrap();
        loop {
            let msg = self.recv().await;
            if msg["type"] == "event" {
                self.events.push(msg["event"].clone());
            } else if msg["id"] == id {
                return match msg.get("error") {
                    Some(e) => Err(e.as_str().unwrap().to_string()),
                    None => Ok(msg["result"].clone()),
                };
            }
        }
    }

    async fn wait_for(&mut self, pred: impl Fn(&Value) -> bool) -> Value {
        if let Some(e) = self.events.iter().find(|e| pred(e)) {
            return e.clone();
        }
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            let msg = self.recv().await;
            if msg["type"] == "event" {
                self.events.push(msg["event"].clone());
                if pred(&msg["event"]) {
                    return msg["event"].clone();
                }
            }
        }
        panic!("no such event; got {:?}", self.events);
    }
}

#[tokio::test]
async fn runs_a_thread_over_the_websocket_as_the_frontend_does() {
    let server = start("claude/app-tool").await;
    let mut c = Client::connect(server.port, Some(&format!("http://127.0.0.1:{}", server.port)))
        .await
        .unwrap();
    let hello = c.call("hello", json!({})).await.unwrap();
    assert_eq!(
        hello["harnesses"],
        json!([{"name": "claude", "label": "Claude Code", "model": "haiku", "models": ["haiku"]}])
    );
    assert_eq!(hello["restart"], false);
    assert_eq!(c.call("list", json!({})).await.unwrap(), json!([]));

    let fixture: Value = serde_json::from_str(
        &std::fs::read_to_string(repo().join("spec/fixtures/claude/app-tool/fixture.json")).unwrap(),
    )
    .unwrap();
    let thread = c
        .call("create", json!({"harness": "claude", "title": "Order 42"}))
        .await
        .unwrap();
    let id = thread["id"].as_str().unwrap().to_string();
    assert_eq!(
        (thread["model"].clone(), thread["title"].clone()),
        (json!("haiku"), json!("Order 42"))
    );
    let mut command = fixture["steps"][0]["command"].clone();
    command["thread_id"] = json!(id);
    assert_eq!(
        c.call("command", json!({"command": command})).await.unwrap(),
        Value::Null
    );
    c.wait_for(|e| {
        e["type"] == "thread.updated"
            && e["thread"]["status"] == "idle"
            && e["thread"]["id"] == id
            && e["seq"].as_u64() > Some(2)
    })
    .await;

    let snap = c.call("snapshot", json!({"thread_id": id})).await.unwrap();
    let call = snap["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["type"] == "tool_call" && i["kind"] == "app")
        .unwrap()
        .clone();
    assert_eq!(call["name"], "lookup_order");
    assert_eq!(
        call["result"]["content"],
        "Order 42: 3 blue widgets, shipped on 2026-10-30."
    );
    // The structured output the frontend draws as an order card.
    assert_eq!(call["result"]["structured"]["status"], "shipped");
    assert_eq!(
        call["result"]["structured"]["items"],
        json!([{"name": "blue widget", "qty": 3}])
    );
    let since = c
        .call("events_since", json!({"thread_id": id, "seq": 0}))
        .await
        .unwrap();
    assert_eq!(since.as_array().unwrap().last().unwrap()["seq"], snap["seq"]);
    // Every pushed event was the thread's, deltas included.
    assert!(c.events.iter().any(|e| e["type"] == "delta"));
    assert_eq!(c.call("list", json!({})).await.unwrap()[0]["id"], json!(id));

    // What it refuses.
    assert!(
        c.call("command", json!({"command": {"type": "dance", "thread_id": id}}))
            .await
            .unwrap_err()
            .contains("valid command")
    );
    assert!(
        c.call("create", json!({"harness": "grok"}))
            .await
            .unwrap_err()
            .contains("no harness")
    );
    assert!(c.call("nope", json!({})).await.unwrap_err().contains("no method"));
    assert!(c.call("restart", json!({})).await.is_err());
    // Frames that aren't requests are ignored, and the socket carries on.
    for junk in [
        "null",
        "[]",
        "{\"id\":1}",
        "not json",
        "{\"id\":{},\"method\":\"hello\"}",
        "{\"id\":2,\"method\":\"hello\",\"params\":5}",
    ] {
        c.ws.send(Message::Text(junk.into())).await.unwrap();
    }
    assert!(c.call("hello", json!({})).await.is_ok());
}

#[tokio::test]
async fn takes_websockets_only_from_the_apps_own_page_on_a_loopback_host() {
    let server = start("claude/plain-reply").await;
    let p = server.port;
    // No Origin (not a browser), or the page's own.
    assert!(Client::connect(p, None).await.is_ok());
    assert!(Client::connect(p, Some(&format!("http://127.0.0.1:{p}"))).await.is_ok());
    // Another site's page.
    for origin in ["http://evil.example", "http://127.0.0.1:9999", "null"] {
        match Client::connect(p, Some(origin)).await {
            Err(tungstenite::Error::Http(r)) => assert_eq!(r.status(), 403, "{origin}"),
            other => panic!("{origin}: {:?}", other.map(|_| ())),
        }
    }
    // A Host that isn't loopback (DNS rebinding).
    let raw = raw(p, &format!("GET /ws HTTP/1.1\r\nHost: rebound.example:{p}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")).await;
    assert!(raw.starts_with("HTTP/1.1 403"), "{raw}");
}

#[tokio::test]
async fn answers_a_path_that_doesnt_decode_with_400() {
    let server = start("claude/plain-reply").await;
    let r = raw(
        server.port,
        &format!(
            "GET /%E0 HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            server.port
        ),
    )
    .await;
    assert!(r.starts_with("HTTP/1.1 400"), "{r}");
    let r = raw(
        server.port,
        &format!(
            "GET /%zz HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            server.port
        ),
    )
    .await;
    assert!(r.starts_with("HTTP/1.1 400"), "{r}");
}

/// What the server answers to a raw HTTP request.
async fn raw(port: u16, request: &str) -> String {
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    s.write_all(request.as_bytes()).await.unwrap();
    let mut buf = vec![0; 4096];
    let n = tokio::time::timeout(Duration::from_secs(5), s.read(&mut buf))
        .await
        .unwrap()
        .unwrap();
    String::from_utf8_lossy(&buf[..n]).to_string()
}
