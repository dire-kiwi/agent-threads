# @dire-kiwi/agent-threads-react

React hooks and components that draw an agent-threads thread from its events and send the user's
actions back as commands. There's no network layer: the app brings the events over its own
transport and carries the commands back ([docs/transport.md](../../../docs/transport.md) has
WebSocket, SSE, Electron and Tauri versions; [spec/PROTOCOL.md](../../../spec/PROTOCOL.md) the
events and commands). It works with any of the backends (Node, Go, Rust), and needs React 18+.
Nothing is published yet: build it from a checkout and link it into your app, telling the bundler
to use the app's one React (Vite's `resolve.dedupe: ["react", "react-dom"]`), as
[the root README](../../../README.md#typescript-packages) says.

## Use it

```tsx
import { Thread, type ThreadSource } from "@dire-kiwi/agent-threads-react";
import "@dire-kiwi/agent-threads-react/styles.css";

// Wired to the app's own transport (onThreadEvent, fetchEventsSince and sendCommand are the app's:
// docs/transport.md has them over WebSocket, SSE, Electron and Tauri).
const source: ThreadSource = {
  snapshot,                                         // sdk.snapshot(threadId), sent to the client
  subscribe: (fn) => onThreadEvent(threadId, fn),   // returns how to stop
  resync: (seq) => fetchEventsSince(threadId, seq), // sdk.eventsSince(threadId, seq), or a fresh snapshot
};

<Thread source={source} onCommand={(command) => sendCommand(command)} />;
```

A `ThreadSource` is the thread's `snapshot` (from the backend's `snapshot(threadId)`), a
`subscribe` to its events, deltas included, that returns how to stop, and an optional `resync(seq)`
that resolves with the saved events after `seq` (the backend's `eventsSince`) or a fresh snapshot.
Keep the same `source` object for a connection (memoize it): a new one starts again from its
snapshot. [examples/chat-node](../../../examples/chat-node/README.md) is a whole app wired
this way, over a WebSocket. `onCommand` can return a promise, and the components show a failure.

### Long threads

A thread can run to thousands of items. Start from a window of its latest instead of all of them
(the backend's `snapshot(threadId, { limit })`), and give the source a `loadEarlier(before)` that
resolves with the page of items before index `before` (the backend's `itemsBefore(threadId, before,
limit)`, with as many as you like to load at a time):

```tsx
const source: ThreadSource = {
  snapshot,                                                  // sdk.snapshot(threadId, { limit: 200 })
  subscribe: (fn) => onThreadEvent(threadId, fn),
  resync: (seq) => fetchEventsSince(threadId, seq),
  loadEarlier: (before) => fetchItemsBefore(threadId, before), // sdk.itemsBefore(threadId, before, 200)
};
```

`<Thread>` then shows "Load earlier messages" at the top, and loads the page before as it's
scrolled near there, keeping what's on screen where it was; tool groups keep their rows (and what's
opened in them) as earlier calls are put in front. A window has the subagent calls its items and
open requests belong to even when they started before it: opening one, or revealing it (from its
request's "from", or `<AgentsPill>`), loads back to where it started. Events that come while a page
loads apply to its items too ([spec/PROTOCOL.md](../../../spec/PROTOCOL.md#windows) has the rules).
A `resync` that brings a fresh snapshot starts again from that snapshot's window, so prefer
resolving it with events.

## Headless

- `useThread(source)`: the thread's state, `{snapshot, streaming, resyncing, view}`. Events are
  applied with `applyEvent`; a saved event whose `seq` skips ahead is held while `source.resync`
  fetches the missing ones (or a snapshot), and deltas that come meanwhile are dropped (the
  message's final text puts it right). Each time it connects, `source.resync` is called too, for
  what was sent while it wasn't listening (since the snapshot was taken, or while it was
  disconnected). That's on every mount, so twice in StrictMode, and again on each remount.
- `<ThreadProvider source onCommand>` gives the components a thread. Inside it,
  `useThreadState(pick)` redraws only when what it picks changes, and `useSend()`,
  `useInterrupt()`, `useRespond()` and `useSetOptions()` send the commands (`useCommand()` any
  command, with the thread's id filled in). `useReveal()` scrolls to and opens a subagent's row, and
  `useThreadConfig()` is the app's renderers.
- `ThreadStore` is the state machine under `useThread`, with no React in it: `useThreadStore(source)`
  gives a component its store, or make one yourself for another framework. `loadEarlier({ to? })`
  loads a page of earlier items (or back to item `to`), and the state's `loadingEarlier` and
  `earlierError` say how that's going; inside a provider, `useLoadEarlier()` and `useHasEarlier()`.
- `buildView` and `groupRows` arrange the items for drawing: each subagent's items under it,
  tool calls in a row grouped, answered requests where they were asked, and unchanged lists and
  rows kept as the same objects, so memoized rows don't redraw.

## Requests

Open requests are cards at the end of the thread (`<OpenRequests>`), to allow or deny, or to
answer. Once one's resolved the snapshot keeps it with its `resolution`, and its card stays in the
thread, greyed out with how it went ("Allowed", "Denied" and the note, "Answered" with the picks,
or "Not answered" for one dismissed or whose turn ended first): a permission just before the call it
was for, and a question in place of its call. `openRequests(snapshot)` is the ones still open.

## Components

`<Thread>`, `<MessageList>` (a `parentId` draws a subagent's own thread), `<StreamingText>`,
`<ToolCall>`, `<Subagent>`, `<PermissionCard>`, `<QuestionCard>`, `<PlanCard>` (approve a plan
in a permission mode, or keep planning with feedback), `<RequestCard>`, `<OpenRequests>`,
`<LoadEarlier>`,
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
pick one; a dark-only app passes `theme="dark"`. Set any variable on an element to change the
components inside it.

### Your app's own tokens

To draw a thread in your app's colours, point the `--at-*` variables at your own tokens, on
`.at-root` (every component's outer element), in a stylesheet loaded after `styles.css`, and leave
`theme` unset (or set them on `.at-root.at-theme-dark` too). With Tailwind v4, whose theme is CSS
variables (`--color-*`), say for a dark app with `bg`, `panel`, `fg`, `muted`... tokens:

```css
@import "@dire-kiwi/agent-threads-react/styles.css";

.at-root {
  --at-font: var(--font-sans);
  --at-mono: var(--font-mono);
  --at-radius: var(--radius-lg);

  --at-bg: var(--color-bg);              /* the thread's background */
  --at-panel: var(--color-panel);        /* cards, tool bodies, answered requests */
  --at-panel-2: var(--color-panel-2);    /* inputs and buttons on a panel */
  --at-raised: var(--color-raised);      /* hovered buttons, the user's chips */
  --at-hover: color-mix(in oklab, var(--color-fg) 4%, transparent);
  --at-fg: var(--color-fg);
  --at-muted: var(--color-muted);
  --at-faint: var(--color-faint);
  --at-line: var(--color-line);
  --at-line-strong: var(--color-line-strong);
  --at-accent: var(--color-accent);
  --at-accent-strong: var(--color-accent);
  --at-accent-fg: var(--color-white);
  --at-accent-soft: color-mix(in oklab, var(--color-accent) 12%, transparent);
  --at-attention: var(--color-amber-400); /* open requests */
  --at-attention-soft: color-mix(in oklab, var(--color-amber-400) 7%, transparent);
  --at-progress: var(--color-blue-400);
  --at-good: var(--color-emerald-400);
  --at-bad: var(--color-red-400);
  --at-bad-soft: color-mix(in oklab, var(--color-red-400) 10%, transparent);
  --at-warn: var(--color-amber-400);
  --at-code-bg: var(--color-code);
  --at-code-fg: var(--color-fg);
  --at-add-bg: color-mix(in oklab, var(--color-emerald-500) 10%, transparent);
  --at-add-fg: var(--color-emerald-300);
  --at-del-bg: color-mix(in oklab, var(--color-red-500) 10%, transparent);
  --at-del-fg: var(--color-red-300);
  --at-user-bg: var(--color-raised);     /* the user's messages */
  --at-user-border: var(--color-line-strong);
}
```

With Tailwind v3 (a JS config), use its `theme()` function in place of `var()`, or make your
tokens CSS variables first. Every variable is listed, with both presets, at the top of
`styles.css`; anything you don't set keeps the preset's value.

## Stories

`pnpm stories` opens Ladle, with a page per component fed by the recorded fixtures in
`spec/fixtures`. `Thread › Replay` plays a fixture as its backend sent it, waiting for you to
answer each request.
