# @dire-kiwi/agent-threads-react

React hooks and components that draw an agent-threads thread from its events and send the user's
actions back as commands. There's no network layer: the app brings the events over its own
transport and carries the commands back (see [spec/PROTOCOL.md](../../../spec/PROTOCOL.md)).

## Use it

```tsx
import { Thread, type ThreadSource } from "@dire-kiwi/agent-threads-react";
import "@dire-kiwi/agent-threads-react/styles.css";

// Wired to the app's transport: a snapshot from the backend, its events, and catching up after a gap.
const source: ThreadSource = {
  snapshot,                                   // sdk.snapshot(threadId), sent to the client
  subscribe: (fn) => ws.on("event", fn),      // returns how to stop
  resync: (seq) => api.eventsAfter(threadId, seq), // or a fresh snapshot
};

<Thread source={source} onCommand={(command) => ws.send(command)} />;
```

Keep the same `source` object for a connection (memoize it): a new one starts again from its
snapshot. [examples/chat-node](../../../examples/chat-node/README.md) is a whole app wired
this way, over a WebSocket. `onCommand` can return a promise, and the components show a failure.

## Headless

- `useThread(source)`: the thread's state, `{snapshot, streaming, resyncing, view}`. Events are
  applied with `applyEvent`; a saved event whose `seq` skips ahead is held while `source.resync`
  fetches the missing ones (or a snapshot), and deltas that come meanwhile are dropped (the
  message's final text puts it right). Each time it connects, `source.resync` is called too, for
  what was sent while it wasn't listening (since the snapshot was taken, or while it was
  disconnected). That's on every mount, so twice in StrictMode, and again on each remount.
- `<ThreadProvider source onCommand>` gives the components a thread. Inside it,
  `useThreadState(pick)` redraws only when what it picks changes, and `useSend()`,
  `useInterrupt()`, `useRespond()` and `useSetOptions()` send the commands.
- `buildView` and `groupRows` arrange the items for drawing: each subagent's items under it,
  tool calls in a row grouped, and unchanged lists and rows kept as the same objects, so memoized
  rows don't redraw.

## Components

`<Thread>`, `<MessageList>` (a `parentId` draws a subagent's own thread), `<StreamingText>`,
`<ToolCall>`, `<Subagent>`, `<PermissionCard>`, `<QuestionCard>`, `<OpenRequests>`,
`<CompactionLine>`, `<TurnResult>`, `<Notice>`, `<Composer>` and `<AgentsPill>`. Each takes a
`className`.

## Extending

Give `ThreadProvider` (or `Thread`):

- `tools`: renderers by tool name, e.g. `{ lookup_order: { Row: OrderCard, alone: true } }`. A
  renderer can change the summary line (`meta`), the opened body (`Body`), or the whole row
  (`Row`); `alone` keeps it out of tool groups.
- `toolKinds`: renderers by kind, in place of the built-in ones.
- `renderMarkdown(text)`: the built-in one only does paragraphs and code; pass e.g.
  `react-markdown`.
- `renderItem(item)`: any item's row; return `undefined` for the built-in one. Tool calls drawn
  in a group don't go through it: use `tools` or `toolKinds` for those.

Make these once (or memoize them): new ones redraw every row.

## Styling

One stylesheet, `styles.css`, themed with `--at-*` CSS variables. Light is the default, dark
follows `prefers-color-scheme`, and `.at-theme-light` / `.at-theme-dark` (or `<Thread theme>`)
pick one. Set any variable on an element to change the components inside it.

## Stories

`pnpm stories` opens Ladle, with a page per component fed by the recorded fixtures in
`spec/fixtures`. `Thread › Replay` plays a fixture as its backend sent it, waiting for you to
answer each request.
