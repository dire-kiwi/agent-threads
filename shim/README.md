# agent-threads-shim

Reserved for `agent-threads-shim`, a port of Huntaway's `ia-shim`
(`server/shim/src/main.rs`): a small Unix-only binary that runs a harness CLI detached, in its own
session and process group, so that a run outlives the backend that started it. The backend follows
the run's `out.jsonl` and re-attaches to it after a restart.

It isn't written yet. A later task ports it here and specifies the run-directory protocol
(`out.jsonl`, `err.log`, `input.jsonl`, `input.closed`, `pid`, `exit`, `run.json`) in `spec/`.
See [docs/design.md](../docs/design.md#the-shim-runs-that-outlive-the-backend).
