// The app's renderer for its own tool, lookup_order: an order card in place of the built-in tool
// row, drawn from the call's input and its result's structured output (examples/PROTOCOL.md).

import type { ToolRenderer, ToolRowProps } from "@dire-kiwi/agent-threads-react";

interface Order {
  order_id: string;
  status: "processing" | "shipped" | "delivered" | "cancelled";
  items: { name: string; qty: number }[];
  shipped_on?: string;
  total?: string;
}

const STATUS: { [s in Order["status"]]: string } = {
  processing: "Processing",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

function OrderCard({ call, request }: ToolRowProps) {
  const id = String((call.input as { order_id?: unknown })?.order_id ?? "?");
  const order = call.result?.structured as Order | undefined;
  const done = call.status === "completed" && order;
  return (
    <div className="order-card" data-testid="order-card" data-status={call.status}>
      <div className="order-card-head">
        <span className="order-card-icon" aria-hidden>
          📦
        </span>
        <span className="order-card-title">Order #{id}</span>
        {done ? (
          <span className={`order-badge order-badge-${order.status}`}>{STATUS[order.status] ?? order.status}</span>
        ) : (
          <span className="order-card-state">{request ? "needs approval" : call.status === "running" || call.status === "pending" ? "looking it up…" : call.status}</span>
        )}
      </div>
      {done ? (
        <div className="order-card-body">
          <ul>
            {order.items.map((i) => (
              <li key={i.name}>
                <span className="order-qty">{i.qty}×</span> {i.name}
              </li>
            ))}
          </ul>
          <div className="order-card-foot">
            {order.shipped_on && <span>Shipped {order.shipped_on}</span>}
            {order.total && <span className="order-total">{order.total}</span>}
          </div>
        </div>
      ) : (
        call.result && <div className="order-card-body order-card-text">{call.result.content}</div>
      )}
    </div>
  );
}

export const tools: Record<string, ToolRenderer> = {
  lookup_order: { Row: OrderCard, alone: true },
};
