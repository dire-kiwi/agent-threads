package agentthreads

import (
	"context"
	"encoding/json"
	"fmt"
)

// The app's own tools, which the agent calls like any other and the backend runs in process.

// Tool is a tool the app defines. ToolFunc and TypedTool make one from a function.
type Tool interface {
	Name() string
	Description() string
	// InputSchema is the JSON Schema of its arguments (an object schema).
	InputSchema() json.RawMessage
	// Run runs it. ctx is cancelled when the thread's harness process goes away before it returns.
	// An error is returned to the agent as the tool's (failed) result.
	Run(ctx context.Context, args json.RawMessage, call ToolContext) (ToolOutput, error)
}

// ToolContext is what a tool is told about the call.
type ToolContext struct {
	ThreadID string
	// Metadata is the thread's, as the app gave it: e.g. which user the thread is for.
	Metadata map[string]json.RawMessage
	// ToolCallID is the tool_call item this call is, when the harness says.
	ToolCallID string
}

// ToolOutput is what a tool returns: text for the agent, structured output if it has some, and
// whether it's an error.
type ToolOutput struct {
	Text       string
	IsError    bool
	Structured any
}

// Text is a ToolOutput of just text.
func Text(s string) ToolOutput { return ToolOutput{Text: s} }

type funcTool struct {
	name, description string
	input             json.RawMessage
	run               func(context.Context, json.RawMessage, ToolContext) (ToolOutput, error)
}

func (t *funcTool) Name() string                 { return t.name }
func (t *funcTool) Description() string          { return t.description }
func (t *funcTool) InputSchema() json.RawMessage { return t.input }
func (t *funcTool) Run(ctx context.Context, args json.RawMessage, call ToolContext) (ToolOutput, error) {
	return t.run(ctx, args, call)
}

// ToolFunc is a Tool that runs run. input is its arguments' JSON Schema: JSON (a string,
// []byte or json.RawMessage) or a value that marshals to it (a map, say).
func ToolFunc(name, description string, input any, run func(ctx context.Context, args json.RawMessage, call ToolContext) (ToolOutput, error)) Tool {
	return &funcTool{name: name, description: description, input: schemaJSON(input), run: run}
}

// TypedTool is a Tool whose arguments are decoded into an A for run.
func TypedTool[A any](name, description string, input any, run func(ctx context.Context, args A, call ToolContext) (ToolOutput, error)) Tool {
	return ToolFunc(name, description, input, func(ctx context.Context, raw json.RawMessage, call ToolContext) (ToolOutput, error) {
		var args A
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &args); err != nil {
				return ToolOutput{}, fmt.Errorf("the arguments aren't right: %w", err)
			}
		}
		return run(ctx, args, call)
	})
}

func schemaJSON(input any) json.RawMessage {
	switch s := input.(type) {
	case nil:
		return json.RawMessage(`{"type":"object","properties":{}}`)
	case json.RawMessage:
		return s
	case []byte:
		return json.RawMessage(s)
	case string:
		return json.RawMessage(s)
	}
	data, err := json.Marshal(input)
	if err != nil {
		panic(fmt.Sprintf("agentthreads: a tool's input schema doesn't marshal: %v", err))
	}
	return data
}

// toolResult is a tool's output in one shape; a tool that fails (or panics) returns its error to
// the agent.
func runTool(ctx context.Context, tool Tool, args json.RawMessage, call ToolContext) (out ToolOutput) {
	defer func() {
		if r := recover(); r != nil {
			out = ToolOutput{Text: fmt.Sprintf("The tool failed: %v", r), IsError: true}
		}
	}()
	if len(args) == 0 {
		args = json.RawMessage("{}")
	}
	out, err := tool.Run(ctx, args, call)
	if err != nil {
		return ToolOutput{Text: err.Error(), IsError: true}
	}
	return out
}

func findTool(tools []Tool, name string) Tool {
	for _, t := range tools {
		if t.Name() == name {
			return t
		}
	}
	return nil
}
