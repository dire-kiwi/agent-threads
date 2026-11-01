//! The app's own tool: lookup_order, which the backend runs in process when the agent calls it. Its
//! text goes to the agent, and its structured output to the frontend's order card (see
//! examples/PROTOCOL.md). The same as chat-node's server/orders.ts.

use std::sync::Arc;

use agent_threads::{Tool, ToolOutput, tool};
use serde_json::{Value, json};

struct Order {
    id: &'static str,
    status: &'static str,
    items: &'static [(&'static str, u32)],
    shipped_on: Option<&'static str>,
    total: &'static str,
}

// A tiny "database". Order 42 is the one the recorded fixtures look up, and its text is theirs.
const ORDERS: &[Order] = &[
    Order {
        id: "42",
        status: "shipped",
        items: &[("blue widget", 3)],
        shipped_on: Some("2026-10-30"),
        total: "$36.00",
    },
    Order {
        id: "7",
        status: "processing",
        items: &[("red sprocket", 1), ("spare gasket", 4)],
        shipped_on: None,
        total: "$19.50",
    },
    Order {
        id: "1001",
        status: "delivered",
        items: &[("green gizmo", 2)],
        shipped_on: Some("2026-10-21"),
        total: "$58.00",
    },
    Order {
        id: "1002",
        status: "cancelled",
        items: &[("yellow doohickey", 10)],
        shipped_on: None,
        total: "$12.00",
    },
];

fn find(id: &str) -> Option<&'static Order> {
    let id = id.trim().trim_start_matches('#').trim();
    ORDERS.iter().find(|o| o.id == id)
}

/// What the agent is told about an order.
fn describe(o: &Order) -> String {
    let items: Vec<String> = o
        .items
        .iter()
        .map(|(name, qty)| {
            if *qty == 1 {
                format!("1 {name}")
            } else {
                format!("{qty} {name}s")
            }
        })
        .collect();
    let items = items.join(" and ");
    let shipped = o.shipped_on.unwrap_or("");
    match o.status {
        "processing" => format!("Order {}: {items}, not shipped yet.", o.id),
        "shipped" => format!("Order {}: {items}, shipped on {shipped}.", o.id),
        "delivered" => format!("Order {}: {items}, delivered (shipped on {shipped}).", o.id),
        _ => format!("Order {}: {items}, cancelled.", o.id),
    }
}

fn structured(o: &Order) -> Value {
    let items: Vec<Value> = o
        .items
        .iter()
        .map(|(name, qty)| json!({"name": name, "qty": qty}))
        .collect();
    let mut v = json!({"order_id": o.id, "status": o.status, "items": items, "total": o.total});
    if let Some(s) = o.shipped_on {
        v["shipped_on"] = json!(s);
    }
    v
}

pub fn lookup_order() -> Arc<dyn Tool> {
    let schema = json!({"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]});
    tool(
        "lookup_order",
        "Looks up an order by its id and says what's in it and whether it has shipped.",
        schema,
        |args, _| async move {
            let id = match &args["order_id"] {
                Value::String(s) => s.clone(),
                v => v.to_string(),
            };
            match find(&id) {
                Some(o) => ToolOutput::text(describe(o)).with_structured(structured(o)),
                None => ToolOutput::error(format!("There's no order {id}.")),
            }
        },
    )
}
