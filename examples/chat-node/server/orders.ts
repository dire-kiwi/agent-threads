// The app's own tool: lookup_order, which the backend runs in process when the agent calls it. Its
// text goes to the agent, and its structured output to the frontend's order card (see
// examples/PROTOCOL.md).

import { defineTool } from "@dire-kiwi/agent-threads-node";

export interface Order {
  order_id: string;
  status: "processing" | "shipped" | "delivered" | "cancelled";
  items: { name: string; qty: number }[];
  shipped_on?: string;
  total?: string;
}

// A tiny "database". Order 42 is the one the recorded fixtures look up, and its text is theirs.
const ORDERS: Order[] = [
  { order_id: "42", status: "shipped", items: [{ name: "blue widget", qty: 3 }], shipped_on: "2026-10-30", total: "$36.00" },
  { order_id: "7", status: "processing", items: [{ name: "red sprocket", qty: 1 }, { name: "spare gasket", qty: 4 }], total: "$19.50" },
  { order_id: "1001", status: "delivered", items: [{ name: "green gizmo", qty: 2 }], shipped_on: "2026-10-21", total: "$58.00" },
  { order_id: "1002", status: "cancelled", items: [{ name: "yellow doohickey", qty: 10 }], total: "$12.00" },
];

export const findOrder = (id: string): Order | undefined => ORDERS.find((o) => o.order_id === id.replace(/^#/, "").trim());

/** What the agent is told about an order. */
export function describe(o: Order): string {
  const items = o.items.map((i) => `${i.qty} ${i.qty === 1 ? i.name : `${i.name}s`}`).join(" and ");
  switch (o.status) {
    case "processing":
      return `Order ${o.order_id}: ${items}, not shipped yet.`;
    case "shipped":
      return `Order ${o.order_id}: ${items}, shipped on ${o.shipped_on}.`;
    case "delivered":
      return `Order ${o.order_id}: ${items}, delivered (shipped on ${o.shipped_on}).`;
    case "cancelled":
      return `Order ${o.order_id}: ${items}, cancelled.`;
  }
}

export const lookupOrder = defineTool<{ order_id: string }>({
  name: "lookup_order",
  description: "Looks up an order by its id and says what's in it and whether it has shipped.",
  input: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
  run: ({ order_id }) => {
    const order = findOrder(String(order_id));
    if (!order) return { text: `There's no order ${order_id}.`, isError: true };
    return { text: describe(order), structured: order };
  },
});
