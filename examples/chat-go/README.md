# chat-go: the chat example's server, in Go

The support-chat app of [chat-node](../chat-node/README.md), with its server in Go on the
[Go backend](../../go/README.md). It speaks the same wire protocol ([../PROTOCOL.md](../PROTOCOL.md))
over its own WebSocket, so chat-node's React frontend talks to it unchanged. The SDK has no network
layer, and [main.go](main.go) is the whole seam: events out (`sdk.Subscribe` to every client),
commands in (a client's `command` to `sdk.HandleJSON`), plus `Snapshot` and `EventsSince` for
clients that connect or reconnect.

It has what chat-node's server has:

- **Threads on Claude Code or Codex**, kept in SQLite ([sqlitestore](../../go/sqlitestore)) and
  resumed after a restart.
- **An app tool**, `lookup_order` ([orders.go](orders.go)), run in process, whose structured output
  the frontend draws as an order card.
- **An external MCP server**, `shipping` ([shipping.go](shipping.go)), a stdio server with
  `track_parcel`, which the harness starts (as `chat-go shipping-mcp`).
- **A skill**, [skills/order-support](skills/order-support/SKILL.md).
- **A permission policy** ([policy.go](policy.go)) that allows what only reads and asks the user
  about everything else.
- **Runs that outlive the server**, with `CHAT_SHIM`, and a **Restart server** button when it's run
  under `chat-go supervise`.
- The same checks: WebSockets only from its own pages on a loopback host, frames that aren't
  requests ignored, a bad frame (not UTF-8, or over 16MB) closing only its connection, and a path
  that doesn't decode answered with 400.

## Running it

You need Go 1.26+, `claude` and/or `codex` installed and logged in, and the frontend built from
chat-node (it serves `../chat-node/web/dist`, or `CHAT_WEB`):

```sh
cd ts && pnpm install && pnpm build    # the SDK's packages
cd ../examples/chat-node && pnpm build # chat-node's frontend, into web/dist
cd ../chat-go
go run .                              # http://127.0.0.1:3001
```

Or with chat-node's Vite dev server, which proxies `/ws` to port 3001: `CHAT_DEV=1 go run .` here
(so the server trusts pages from Vite's port), and `pnpm exec vite` in `examples/chat-node`, then
open http://localhost:5173.

The restart demo:

```sh
make shim                             # from the repository's root
CHAT_SHIM=1 go run . supervise
```

Ask something that needs a permission, and while the card waits, click **Restart server**: the
server leaves its runs going, `supervise` starts it again, and `Recover` re-attaches to them. The
button is offered only with the shim, since without it a restart loses the running turn.

The environment is chat-node's: `PORT`, `CHAT_DATA`, `CHAT_HARNESSES`, `CHAT_CLAUDE_MODEL`,
`CHAT_CODEX_MODEL`, `CHAT_CODEX_EFFORT`, `CHAT_SHIM`, `CHAT_FAKE_CLAUDE`, `CHAT_FAKE_CODEX` and
`CHAT_FAKE_STATE` (see [config.go](config.go)), plus `CHAT_WEB`, the built frontend to serve, and
`CHAT_DEV=1`, which chat-node's `pnpm dev` sets, to trust Vite's port.

## Tests

```sh
go test ./...
```

They run the server and talk to it over its WebSocket as the frontend does, with Claude Code played
by the fake CLI replaying a recorded session (no login, no cost; it needs `node`): a thread created,
the app's tool called and its order in the call's result, a catch-up with `events_since`, and the
checks that keep other pages and bad input out. chat-node's Playwright tests (`e2e/`) pass against
this server too, with their `e2e/server.ts` starting `chat-go` instead of `server/main.ts`.
