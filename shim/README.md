# agent-threads-shim

A small Unix-only binary that runs one harness process (`claude`, `codex app-server`) detached from
the backend that started it, so the run outlives the backend: it keeps going while the backend
restarts, and the restarted backend picks it up again. It's a port of Huntaway's `ia-shim`, in
Rust, with no dependency but libc.

```
agent-threads-shim <rundir> -- <program> [args...]
```

It forks (the launcher returns at once), calls `setsid`, and runs the program in a process group of
its own, with stdout appended to `<rundir>/out.jsonl` and stderr to `err.log`. The program's stdin
is `prompt`, then whatever is appended to `input.jsonl`, until `input.closed` appears. It writes
`shim.pid` and `pid` (the program's, which is its process group's id) and, once the program exits,
`exit`: `{"code":0,"signal":null}`, with an `error` if it couldn't start it. Everything about the
directory, and how a backend follows it, is in [spec/RUNDIR.md](../spec/RUNDIR.md).

Shims that are running aren't upgraded, so it's kept small and should rarely change.

[docs/shim.md](../docs/shim.md) says when an app wants it, and how a backend recovers its runs
after a restart.

## Building and installing

```sh
cargo build --release   # target/release/agent-threads-shim
cargo test              # runs the shim on sh scripts
make shim               # from the repository's root: shim/target/debug/agent-threads-shim, which the backend's tests use
cargo install --git https://github.com/dire-kiwi/agent-threads agent-threads-shim
```

Ship the binary with the app (it's not published anywhere yet), and give the backend its path.

## Using it

An app doesn't run it itself: a backend's shim spawner does, for each harness process, with a
directory of its own for the runs:

| Backend | |
| --- | --- |
| Node | `shim(path, { runsDir })` ([ts/packages/node](../ts/packages/node/README.md#processes-and-runs-that-survive-a-restart)) |

Then `recover()` at startup re-attaches to the runs the last process left going. It runs on Unix
only: on Windows the backend's shim spawner is the direct one.
