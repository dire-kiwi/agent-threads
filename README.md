# agent-threads

A library for apps to run threads of agents on Claude Code (`claude -p`, stream-json) and Codex
(`codex app-server`), with native Go, Rust and TypeScript (Node) backends and React components. It
has no network layer: backends emit JSON events and accept JSON commands, and the app carries them.

It's early: so far there's the spec, the generated types, the `applyEvent` reducer, the
conformance suite the backends run (recorded sessions replayed by a fake CLI, and store cases),
and the Node backend with its stores and Claude Code driver
([ts/packages/node](ts/packages/node/README.md)). See [docs/design.md](docs/design.md) for the design and [spec/PROTOCOL.md](spec/PROTOCOL.md)
for the protocol.

| Path | What |
| --- | --- |
| `spec/` | JSON Schemas (the source of truth), the protocol doc and examples |
| `spec/fixtures/` | Recorded Claude and Codex sessions with the events they must produce ([README](spec/fixtures/README.md)) |
| `spec/tools/` | The fake CLI that replays them in backends' tests, the recorder, and the event comparator ([README](spec/tools/README.md)) |
| `spec/conformance/` | The cases every store must pass ([store.md](spec/conformance/store.md)) |
| `ts/` | pnpm workspace: `@dire-kiwi/agent-threads-protocol`, `-node`, `-react` |
| `go/` | Go module `github.com/dire-kiwi/agent-threads/go` |
| `rust/` | Cargo workspace with the `agent-threads` crate |
| `shim/` | `agent-threads-shim`, which keeps runs alive across backend restarts (not written yet) |

## Building

You need Node 24+ with pnpm 10, Go 1.24+ and stable Rust.

```sh
(cd ts && pnpm install)
make test        # build and test TS, Go and Rust, and the fixtures' tools
make gen         # regenerate the types after changing spec/schema/
make check-gen   # fail if the generated code is out of date (CI runs it)
```

Nothing is published yet: use the packages from this repository (workspace links or git
dependencies).
