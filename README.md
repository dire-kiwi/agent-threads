# agent-threads

A library for apps to run threads of agents on Claude Code (`claude -p`, stream-json) and Codex
(`codex app-server`), with native Go, Rust and TypeScript (Node) backends and React components. It
has no network layer: backends emit JSON events and accept JSON commands, and the app carries them.

It's early: so far there's the spec, the generated types, the `applyEvent` reducer, the
conformance suite the backends run (recorded sessions replayed by a fake CLI, and store cases),
the Node backend with its stores and its Claude Code and Codex drivers
([ts/packages/node](ts/packages/node/README.md)), the Rust backend
([rust/agent-threads](rust/agent-threads/README.md)), `agent-threads-shim`, which keeps runs going
while a backend restarts ([shim/](shim/README.md)), the React package, and example chat apps
([examples/chat-node](examples/chat-node/README.md), and
[examples/chat-rust](examples/chat-rust/README.md) on the Rust backend). See [docs/design.md](docs/design.md) for the design and [spec/PROTOCOL.md](spec/PROTOCOL.md)
for the protocol.

| Path | What |
| --- | --- |
| `spec/` | JSON Schemas (the source of truth), the protocol doc and examples |
| `spec/fixtures/` | Recorded Claude and Codex sessions with the events they must produce ([README](spec/fixtures/README.md)) |
| `spec/tools/` | The fake CLI that replays them in backends' tests, the recorder, and the event comparator ([README](spec/tools/README.md)) |
| `spec/conformance/` | The cases every store must pass ([store.md](spec/conformance/store.md)) |
| `ts/` | pnpm workspace: `@dire-kiwi/agent-threads-protocol`, `-node`, `-react` |
| `go/` | Go module `github.com/dire-kiwi/agent-threads/go`: the Go backend ([README](go/README.md)) |
| `rust/` | Cargo workspace with the `agent-threads` crate, the Rust backend ([README](rust/agent-threads/README.md)) |
| `shim/` | `agent-threads-shim`, which keeps runs alive across backend restarts ([README](shim/README.md), [spec/RUNDIR.md](spec/RUNDIR.md)) |
| `examples/` | Example apps: [chat-node](examples/chat-node/README.md), a chat app on the Node backend and the React package over its own WebSocket ([the wire protocol](examples/PROTOCOL.md) its frontend speaks), [chat-go](examples/chat-go/README.md), its server in Go on the Go backend, and [chat-rust](examples/chat-rust/README.md), in Rust on the Rust backend |

## Building

You need Node 24+ with pnpm 10, Go 1.26+ and stable Rust (the Node and Go tests build the shim with cargo).

```sh
(cd ts && pnpm install)
make test        # build and test TS, Go and Rust (and the Rust example), and the fixtures' tools
make gen         # regenerate the types after changing spec/schema/
make check-gen   # fail if the generated code is out of date (CI runs it)
```

Nothing is published yet: use the packages from this repository (workspace links or git
dependencies).
