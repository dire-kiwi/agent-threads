// Package agentthreads is agent-threads' Go backend: it runs threads of agents on Claude Code and
// Codex, sends their events to the app, and takes commands from it. The app carries the events and
// commands over its own transport.
//
//	sdk := agentthreads.New(agentthreads.Options{Store: agentthreads.NewMemoryStore()})
//	thread, _ := sdk.Create(ctx, agentthreads.CreateOptions{Model: "haiku"})
//	sdk.Subscribe(func(e protocol.ThreadEvent) { /* to the clients */ })
//	sdk.HandleJSON(ctx, frame) // a command from a client
//
// The types of the shared spec (spec/ in the repository) are in the protocol package; README.md
// has the rest.
package agentthreads
