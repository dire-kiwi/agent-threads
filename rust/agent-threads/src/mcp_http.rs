//! A loopback MCP server for the app's tools, over streamable HTTP: for a harness that can't take
//! them any other way (Codex without dynamic tools). It listens on 127.0.0.1 on a random port and
//! takes only requests with its bearer token. It answers each POST with JSON (no SSE streams),
//! which streamable HTTP allows.

use std::convert::Infallible;
use std::io;
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use tokio::sync::watch;

use crate::tools::ToolOutput;

/// What the server serves.
#[async_trait]
pub(crate) trait ToolServer: Send + Sync {
    /// The tools to list: `{name, description, inputSchema}`s.
    async fn tools(&self) -> Vec<Value>;
    /// Runs one.
    async fn call(&self, name: String, args: Value) -> ToolOutput;
}

pub(crate) struct LoopbackMcp {
    pub port: u16,
    pub token: String,
    stop: watch::Sender<bool>,
}

impl LoopbackMcp {
    /// Its endpoint, http://127.0.0.1:<port>/mcp.
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.port)
    }

    pub fn close(&self) {
        self.stop.send_replace(true);
    }
}

impl Drop for LoopbackMcp {
    fn drop(&mut self) {
        self.close();
    }
}

const MAX_BODY: usize = 16 * 1024 * 1024;

/// Starts a loopback MCP server for the tools: on a new port with a new token, or on those of one
/// before it (for a process configured with it that outlived the backend).
pub(crate) fn serve_tools(
    name: &str,
    server: Arc<dyn ToolServer>,
    again: Option<(u16, String)>,
) -> io::Result<LoopbackMcp> {
    let token = match &again {
        Some((_, t)) => t.clone(),
        None => crate::ids::token(24)?,
    };
    let listener = std::net::TcpListener::bind(("127.0.0.1", again.as_ref().map_or(0, |(p, _)| *p)))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let listener = tokio::net::TcpListener::from_std(listener)?;
    let (stop, stopped) = watch::channel(false);
    let expected = Arc::new(format!("Bearer {token}"));
    let name = Arc::new(name.to_string());
    let mut accept_stop = stopped.clone();
    tokio::spawn(async move {
        loop {
            let stream = tokio::select! {
                r = listener.accept() => match r { Ok((s, _)) => s, Err(_) => continue },
                _ = accept_stop.wait_for(|s| *s) => return,
            };
            let (server, expected, name) = (server.clone(), expected.clone(), name.clone());
            let mut conn_stop = stopped.clone();
            tokio::spawn(async move {
                let service = hyper::service::service_fn(move |req| {
                    let (server, expected, name) = (server.clone(), expected.clone(), name.clone());
                    async move { Ok::<_, Infallible>(handle(req, &server, &expected, &name).await) }
                });
                let conn = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service);
                tokio::select! {
                    _ = conn => {}
                    _ = conn_stop.wait_for(|s| *s) => {}
                }
            });
        }
    });
    Ok(LoopbackMcp { port, token, stop })
}

fn respond(status: StatusCode, body: Option<Value>) -> Response<Full<Bytes>> {
    let mut r = Response::builder().status(status);
    let body = match body {
        Some(v) => {
            r = r.header("Content-Type", "application/json");
            Full::new(Bytes::from(v.to_string()))
        }
        None => Full::new(Bytes::new()),
    };
    r.body(body).unwrap()
}

/// Compares in constant time, as far as the lengths allow.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn handle(
    req: Request<Incoming>,
    server: &Arc<dyn ToolServer>,
    expected: &str,
    name: &str,
) -> Response<Full<Bytes>> {
    if req.uri().path() != "/mcp" {
        return respond(StatusCode::NOT_FOUND, None);
    }
    let auth = req
        .headers()
        .get("authorization")
        .map(|v| v.as_bytes().to_vec())
        .unwrap_or_default();
    if !same(&auth, expected.as_bytes()) {
        let mut r = respond(StatusCode::UNAUTHORIZED, None);
        r.headers_mut().insert("WWW-Authenticate", "Bearer".parse().unwrap());
        return r;
    }
    match *req.method() {
        Method::DELETE => return respond(StatusCode::OK, None),
        Method::POST => {}
        _ => {
            let mut r = respond(StatusCode::METHOD_NOT_ALLOWED, None);
            r.headers_mut().insert("Allow", "POST, DELETE".parse().unwrap());
            return r;
        }
    }
    let body = match Limited::new(req.into_body(), MAX_BODY).collect().await {
        Ok(b) => b.to_bytes(),
        Err(_) => return respond(StatusCode::PAYLOAD_TOO_LARGE, None),
    };
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return respond(
            StatusCode::BAD_REQUEST,
            Some(json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "parse error"}})),
        );
    };
    let batch = body.is_array();
    let messages = match body {
        Value::Array(a) => a,
        m => vec![m],
    };
    let mut replies = Vec::new();
    for m in messages {
        if let Some(r) = answer(&m, server, name).await {
            replies.push(r);
        }
    }
    if replies.is_empty() {
        return respond(StatusCode::ACCEPTED, None);
    }
    respond(
        StatusCode::OK,
        Some(if batch {
            Value::Array(replies)
        } else {
            replies.remove(0)
        }),
    )
}

async fn answer(msg: &Value, server: &Arc<dyn ToolServer>, name: &str) -> Option<Value> {
    let id = msg.get("id").filter(|i| !i.is_null());
    if msg["jsonrpc"] != "2.0" || !msg["method"].is_string() {
        return id
            .map(|id| json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32600, "message": "invalid request"}}));
    }
    let id = id?; // a notification
    let reply = |body: Value| {
        let mut r = json!({"jsonrpc": "2.0", "id": id});
        for (k, v) in body.as_object().into_iter().flatten() {
            r[k] = v.clone();
        }
        r
    };
    Some(match msg["method"].as_str().unwrap() {
        "initialize" => {
            let version = msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18");
            reply(
                json!({"result": {"protocolVersion": version, "capabilities": {"tools": {}}, "serverInfo": {"name": name, "version": "1.0.0"}}}),
            )
        }
        "ping" => reply(json!({"result": {}})),
        "tools/list" => reply(json!({"result": {"tools": server.tools().await}})),
        "tools/call" => {
            let name = msg["params"]["name"].as_str().unwrap_or("").to_string();
            let args = match &msg["params"]["arguments"] {
                Value::Null => json!({}),
                a => a.clone(),
            };
            let out = server.call(name, args).await;
            let mut result = json!({"content": [{"type": "text", "text": out.text}]});
            if out.is_error {
                result["isError"] = json!(true);
            }
            if let Some(s) = out.structured {
                result["structuredContent"] = s;
            }
            reply(json!({"result": result}))
        }
        other => reply(json!({"error": {"code": -32601, "message": format!("method {other} isn't supported")}})),
    })
}
