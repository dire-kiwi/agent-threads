# chat-rust: the chat example on the Rust backend

The same small support-chat app as [chat-node](../chat-node/README.md), with its server in Rust: the
[agent-threads crate](../../rust/agent-threads/README.md), and an axum WebSocket that speaks
[../PROTOCOL.md](../PROTOCOL.md), so chat-node's React frontend talks to it unchanged. It has the same
app tool (`lookup_order`, whose structured output the frontend draws as an order card), MCP server
(`shipping`, with `track_parcel`: this binary, run as `chat-rust shipping-mcp`), skill
([skills/order-support](skills/order-support/SKILL.md)) and permission policy (allow what only
reads, ask about everything else), and the restart demo under the shim.

```sh
(cd ../chat-node && pnpm build)      # the frontend (see chat-node's README); or point CHAT_WEB at one
cargo run                            # http://127.0.0.1:3001
make -C ../.. shim && CHAT_SHIM=1 cargo run -- supervise   # the restart demo
```

It takes the same environment as chat-node's server (`PORT`, `CHAT_DATA`, `CHAT_HARNESSES`,
`CHAT_CLAUDE_MODEL`, `CHAT_CODEX_MODEL`, `CHAT_CODEX_EFFORT`, `CHAT_SHIM`, `CHAT_FAKE_CLAUDE`,
`CHAT_FAKE_CODEX`, `CHAT_FAKE_STATE`), plus `CHAT_WEB`, the built frontend (`../chat-node/web/dist`
by default). `chat-rust supervise` runs the server and starts it again when the frontend's **Restart
server** asks it to.

The whole seam is in [src/main.rs](src/main.rs): every thread's events from `sdk.subscribe()` to
every client, `command` requests to `sdk.handle_json`, and `snapshot` and `events_since` for clients
that connect or reconnect. Like chat-node, it takes WebSockets only from its own page on a loopback
host (403 otherwise), ignores frames that aren't requests, ends only the socket a bad frame comes
on, and answers a path that doesn't decode with 400.

## Tests

`cargo test` runs the server with the fake CLI replaying a recorded session, and drives it over the
WebSocket as the frontend does. chat-node's Playwright smoke tests run against it too:

```sh
cd ../chat-node && CHAT_E2E_SERVER=$PWD/../chat-rust/target/debug/chat-rust pnpm test:e2e
```
