//! The external MCP server: a stand-in for a courier's tracking service, as a stdio MCP server with
//! one tool, track_parcel. The harness (Claude Code or Codex) starts it (`chat-rust shipping-mcp`),
//! not the backend, and its calls go through the app's permission policy like any other tool's.
//! The same as chat-node's server/shipping-mcp.ts.

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn parcel(order: &str) -> Option<(&'static str, &'static [&'static str])> {
    match order {
        "42" => Some((
            "NZP-4410-2291",
            &[
                "2026-10-30 09:12 Picked up in Auckland",
                "2026-10-31 06:40 At the Christchurch depot",
                "2026-11-01 08:05 Out for delivery",
            ],
        )),
        "1001" => Some((
            "NZP-3982-0017",
            &[
                "2026-10-21 10:30 Picked up in Auckland",
                "2026-10-22 14:02 Delivered, left at the front door",
            ],
        )),
        _ => None,
    }
}

pub async fn serve() {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut out = tokio::io::stdout();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(id) = msg.get("id").cloned() else { continue }; // a notification
        let reply = match msg["method"].as_str().unwrap_or("") {
            "initialize" => {
                let version = msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18");
                json!({"result": {"protocolVersion": version, "capabilities": {"tools": {}}, "serverInfo": {"name": "shipping", "version": "1.0.0"}}})
            }
            "tools/list" => json!({"result": {"tools": [{
                "name": "track_parcel",
                "description": "Tracks the parcel an order was shipped in: its tracking number and where it has been.",
                "inputSchema": {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]},
            }]}}),
            "tools/call" => {
                let order = match &msg["params"]["arguments"]["order_id"] {
                    Value::String(s) => s.trim_start_matches('#').to_string(),
                    Value::Null => String::new(),
                    v => v.to_string(),
                };
                match parcel(&order) {
                    Some((tracking, events)) => {
                        let text = format!("Parcel {tracking} for order {order}:\n{}", events.join("\n"));
                        json!({"result": {"content": [{"type": "text", "text": text}]}})
                    }
                    None => {
                        let text = format!("No parcel has been shipped for order {order}.");
                        json!({"result": {"content": [{"type": "text", "text": text}], "isError": true}})
                    }
                }
            }
            "ping" => json!({"result": {}}),
            other => json!({"error": {"code": -32601, "message": format!("no method {other}")}}),
        };
        let mut msg = json!({"jsonrpc": "2.0", "id": id});
        for (k, v) in reply.as_object().unwrap() {
            msg[k] = v.clone();
        }
        let _ = out.write_all(format!("{msg}\n").as_bytes()).await;
        let _ = out.flush().await;
    }
}
