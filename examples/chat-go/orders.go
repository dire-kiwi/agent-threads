package main

// The app's own tool: lookup_order, which the backend runs in process when the agent calls it. Its
// text goes to the agent, and its structured output to the frontend's order card (see
// examples/PROTOCOL.md).

import (
	"context"
	"fmt"
	"strings"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
)

type item struct {
	Name string `json:"name"`
	Qty  int    `json:"qty"`
}

type order struct {
	OrderID   string `json:"order_id"`
	Status    string `json:"status"` // processing, shipped, delivered or cancelled
	Items     []item `json:"items"`
	ShippedOn string `json:"shipped_on,omitempty"`
	Total     string `json:"total,omitempty"`
}

// orders is a tiny "database". Order 42 is the one the recorded fixtures look up, and its text is theirs.
var orders = []order{
	{OrderID: "42", Status: "shipped", Items: []item{{"blue widget", 3}}, ShippedOn: "2026-10-30", Total: "$36.00"},
	{OrderID: "7", Status: "processing", Items: []item{{"red sprocket", 1}, {"spare gasket", 4}}, Total: "$19.50"},
	{OrderID: "1001", Status: "delivered", Items: []item{{"green gizmo", 2}}, ShippedOn: "2026-10-21", Total: "$58.00"},
	{OrderID: "1002", Status: "cancelled", Items: []item{{"yellow doohickey", 10}}, Total: "$12.00"},
}

func findOrder(id string) *order {
	id = strings.TrimSpace(strings.TrimPrefix(id, "#"))
	for i := range orders {
		if orders[i].OrderID == id {
			return &orders[i]
		}
	}
	return nil
}

// describe is what the agent is told about an order.
func describe(o *order) string {
	var parts []string
	for _, i := range o.Items {
		name := i.Name
		if i.Qty != 1 {
			name += "s"
		}
		parts = append(parts, fmt.Sprintf("%d %s", i.Qty, name))
	}
	items := strings.Join(parts, " and ")
	switch o.Status {
	case "processing":
		return fmt.Sprintf("Order %s: %s, not shipped yet.", o.OrderID, items)
	case "shipped":
		return fmt.Sprintf("Order %s: %s, shipped on %s.", o.OrderID, items, o.ShippedOn)
	case "delivered":
		return fmt.Sprintf("Order %s: %s, delivered (shipped on %s).", o.OrderID, items, o.ShippedOn)
	}
	return fmt.Sprintf("Order %s: %s, cancelled.", o.OrderID, items)
}

var lookupOrder = agentthreads.TypedTool("lookup_order", "Looks up an order by its id and says what's in it and whether it has shipped.",
	`{"type":"object","properties":{"order_id":{"type":"string"}},"required":["order_id"]}`,
	func(_ context.Context, args struct {
		OrderID string `json:"order_id"`
	}, _ agentthreads.ToolContext) (agentthreads.ToolOutput, error) {
		o := findOrder(args.OrderID)
		if o == nil {
			return agentthreads.ToolOutput{Text: fmt.Sprintf("There's no order %s.", args.OrderID), IsError: true}, nil
		}
		return agentthreads.ToolOutput{Text: describe(o), Structured: o}, nil
	})
