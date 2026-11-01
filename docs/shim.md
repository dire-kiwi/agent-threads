# Runs that outlive the backend: the shim

By default a backend runs each harness (`claude`, `codex app-server`) as its own child process, so
when the backend stops, the harness does too: a turn that was running ends, with a `run.lost`
notice, and the thread carries on from its next message (its harness session is resumed). With
**`agent-threads-shim`**, the harness runs detached from the backend, its output recorded in a run
directory, and a backend that restarts **re-attaches** to it: the turn carries on as if nothing
happened, with no events lost or made twice, and a permission request the user hadn't answered can
still be answered.

## When to use it

Use the shim when the backend may restart while agents are working:

- a server that's deployed, or restarted by its supervisor, during long turns;
- a desktop app that quits (or updates) while an agent works, and picks it up at the next launch;
- development, with a server that reloads on every change.

You don't need it when turns are short and a lost one is cheap (the user sends the message again),
or when the harness can't outlive the backend anyway:

- **On Windows** the shim doesn't run, and the shim spawner is the direct one.
- **In a container**, restarting the container stops everything in it, shims included. The shim
  helps when the backend restarts *inside* the container (under a supervisor), with the run
  directory and the store on a volume.
- **Under systemd**, stopping or restarting a unit kills its whole control group by default,
  shims included. Set `KillMode=process`, so only the backend is signalled.

## Getting the binary

`agent-threads-shim` is a small Rust binary in [shim/](../shim/README.md), with no dependency but
libc. Build it from the repository, or install it from git:

```sh
make shim                                   # shim/target/debug/agent-threads-shim
(cd shim && cargo build --release)          # shim/target/release/agent-threads-shim
cargo install --git https://github.com/dire-kiwi/agent-threads agent-threads-shim   # into ~/.cargo/bin
```

Ship it with the app and give the backend its path. Running shims aren't upgraded when the app is:
each run keeps the shim it started with, and the run directory has a format version
([spec/RUNDIR.md](../spec/RUNDIR.md)) so a backend can tell a run it can't follow.

## Using it

Give the backend the shim spawner, with a directory for its runs, and call `recover()` at startup,
before taking commands:

```ts
// Node
import { AgentThreads, SqliteStore, shim } from "@dire-kiwi/agent-threads-node";

const sdk = new AgentThreads({
  store: new SqliteStore("data/threads.db"),
  spawner: shim("/usr/local/lib/myapp/agent-threads-shim", { runsDir: "data/runs" }),
});
const { reattached, lost } = await sdk.recover();
// ... serve clients ...
await sdk.close(); // on shutdown: leaves the runs going, for the next start
```

```go
// Go
sdk := agentthreads.New(agentthreads.Options{
	Store:   store, // sqlitestore.Open("data/threads.db"), or NewFileStore
	Spawner: agentthreads.Shim("/usr/local/lib/myapp/agent-threads-shim", agentthreads.ShimOptions{RunsDir: "data/runs"}),
})
recovered, err := sdk.Recover(ctx)
// ... serve clients ...
err = sdk.Close(ctx) // leaves the runs going; sdk.Stop(ctx) stops them
```

```rust
// Rust
let sdk = AgentThreads::new(Options {
    store: Some(Arc::new(SqliteStore::open("data/threads.db")?)),
    spawner: Some(shim("/usr/local/lib/myapp/agent-threads-shim", ShimOptions::new("data/runs"))),
    ..Default::default()
});
let recovered = sdk.recover().await?;
// ... serve clients ...
sdk.close(false).await?; // leaves the runs going; close(true) stops them
```

- **The store must last**: a `FileStore` or `SqliteStore` (or the app's own), not a memory store.
  A run's offset into its output is saved with the events made from it, which is what lets a
  restarted backend read on from exactly there.
- **`runsDir` must last too, and be the store's alone**: the backend prunes it, stopping and
  removing runs its store doesn't follow, so two stores sharing one would stop each other's runs.
  There's no default. A relative path is the backend's working directory's.
- **`close()` leaves the runs going** (Node `close()`, Go `Close`, Rust `close(false)`): that's
  the point. To stop them too, when the app is really going away (it's uninstalled, the user signs
  out), use `close({ stop: true })`, `Stop` or `close(true)`.
- `shim()` takes `keepDays` (14; Rust `keep`) for how long finished runs' directories are kept, for
  debugging, and `killGraceMs` (Go `KillGrace`, Rust `kill_grace`) for how long a run the spawner
  stops has between SIGTERM and SIGKILL.

## Recovering after a restart

`recover()` re-attaches to every run that was going when the backend last stopped:

- A run **still going** carries on: its turn, its streamed text and its open requests are as they
  were. A permission or question the user hadn't answered can still be answered; one they answered
  just before the backend went (the harness has the answer, though it wasn't saved) isn't asked
  again.
- A run that **ended while the backend was down** is read to its end, so its turn finishes as it
  would have.
- A run it **can't follow** (a newer run-directory format, or one still starting when the backend
  went) is stopped, and its turn ends with a `run.lost` notice.

It returns the threads it re-attached to and those it lost. Each re-attached thread gets a
`notice` with code `run.reattached` (the React package shows it) and its `run.reattached_at` is
set. A thread that a command loads before `recover()` gets to it is re-attached then, but call
`recover()` first: it's also what starts pruning (now, and every hour), which stops runs no thread
follows any more and removes old run directories.

**Give threads their own capabilities back first.** A thread's own tools, MCP servers, skills and
policy (given to `create`) aren't stored. If a re-attached run calls one of the thread's own tools,
the backend needs it, so `configure()` those threads before `recover()` (tools given to the backend
for every thread are there already). See [tools.md](tools.md#capabilities-for-every-thread-or-for-one).

**App tools that were running** when the backend stopped aren't run again (they may have done what
they do): the agent is told the call may or may not have finished. A tool is saved as running
before it runs, so this holds however the backend stopped.

**Clients** just reconnect: they take a fresh snapshot, which has the turn as it is now, and carry
on from there ([transport.md](transport.md#the-rules)). Nothing about the restart needs handling in
the frontend.

## How it works

The shim forks, calls `setsid` and runs the harness in a process group of its own, appending its
stdout to `out.jsonl` and stderr to `err.log` in the run's directory. The backend appends the
harness's input to `input.jsonl`, which the shim relays to its stdin, and follows `out.jsonl`. When
the harness exits, the shim writes `exit`. [spec/RUNDIR.md](../spec/RUNDIR.md) specifies the
directory, so the Node, Go and Rust backends all speak it.

Whenever a thread's events are saved, the run's offset into `out.jsonl` and what its driver needs to
carry on reading (Claude's open control requests, Codex's pending JSON-RPC requests, the text
streamed so far...) are saved with them, in the same store write. So whatever point the backend is
killed at, the next one reads on from exactly where the saved events end.

Stopping a run is the harness's interrupt, then closing its input, then SIGTERM and SIGKILL to its
process group. A process group is only ever signalled while it's still the run's (not after a
reboot gave its id to another process). A shim that dies without saying how its run ended
(SIGKILL, a reboot) is noticed: the run ends with an error.

## Trying it

The chat examples have a **Restart server** button when they run under the shim:

```sh
make shim
cd examples/chat-node && CHAT_SHIM=1 pnpm dev     # or chat-go: CHAT_SHIM=1 go run . supervise
```

Ask something that needs a permission, and while the card waits, restart the server: the thread
says it was picked up again, and the permission can still be answered. Each backend's tests do the
same unattended, killing a backend partway through each recorded session's turn and checking the
next one finishes it with exactly the recording's events (`restart.test.ts`, `restart_test.go`,
`tests/restart.rs`).
