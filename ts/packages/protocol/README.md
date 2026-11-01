# @dire-kiwi/agent-threads-protocol

The agent-threads protocol in TypeScript: the types of [spec/](../../../spec/PROTOCOL.md), generated
from its JSON Schemas, the `applyEvent` reducer that folds a thread's events into its state, and a
validator. It has no dependencies, and runs anywhere (Node, browsers, workers). The Node backend
makes its snapshots with this reducer and checks commands with this validator, and the React
package draws its state, so all three agree by construction.

You seldom need it directly: [@dire-kiwi/agent-threads-node](../node/README.md) and
[@dire-kiwi/agent-threads-react](../react/README.md) re-export its types (and React its reducer).
Use it for a client that isn't React (a CLI, a bot, a test), or to check JSON from elsewhere.

```ts
import { applyEvent, initialState, isGap, validate, type Command, type Snapshot, type ThreadEvent } from "@dire-kiwi/agent-threads-protocol";

let state: Snapshot = snapshotFromTheBackend; // or initialState(thread)

function onEvent(event: ThreadEvent) {
  if (isGap(state, event)) return catchUp(state.seq); // missed events: fetch eventsSince(state.seq), or a fresh snapshot
  state = applyEvent(state, event);
}

const problems = validate(json, "Command"); // [] when it's a valid Command
```

## API

- **Types**: everything in the spec, by its schema name. `Thread` (`ThreadStatus`, `PermissionMode`,
  `Run`, `Usage`); `Item`, a union of `UserMessage`, `AssistantMessage`, `Reasoning`, `ToolCall`,
  `Compaction`, `Notice` and `TurnResult` (with `ToolKind`, `ToolStatus`, `ToolResult`,
  `FileChange`, `Todo`, `Attachment`); `ThreadRequest`, a `PermissionRequest` or `QuestionRequest`
  (`Question`, `QuestionOption`), answered with a `Resolution`; `ThreadEvent`, a union of
  `ThreadUpdatedEvent`, `TurnStartedEvent`, `TurnCompletedEvent`, `ItemAddedEvent`,
  `ItemUpdatedEvent`, `DeltaEvent`, `RequestOpenedEvent` and `RequestResolvedEvent`; `Command`, a
  union of `SendCommand`, `InterruptCommand`, `RespondCommand` and `SetOptionsCommand`; and
  `Snapshot`, `{thread, items, requests, seq}`. Unions are told apart by `type`.
- **`initialState(thread)`**: the state before any events (`seq` 0, no items or requests).
- **`applyEvent(state, event)`**: the state after the event, by the protocol's
  [rules](../../../spec/PROTOCOL.md#applying-events). It never changes the state it's given, and
  what an event leaves alone keeps its identity (the other items are the same objects), so
  memoized UI rows don't redraw; an event that changes nothing (another thread's, a saved event at
  or below `seq`, a delta already applied) returns the state itself. So events can be applied more
  than once, and a snapshot taken after subscribing is safe. `applyEvents(state, events)` applies
  several.
- **`isGap(state, event)`**: whether a saved event's `seq` is more than one past the state's, so
  events before it were missed and the client should catch up first.
- **`validate(value, name)`**: what's wrong with `value` as the schema definition `name`
  (`"Command"`, `"ThreadEvent"`, `"Snapshot"`... a `SchemaName`), as `"path: problem"` strings; none
  when it's valid. It knows the subset of JSON Schema the spec uses, and allows fields the schema
  doesn't name (receivers ignore those). `schema` is the bundled schema itself.

## Building

The types (`src/generated.ts`) and the bundled schema (`src/schema.ts`) are generated from
`spec/schema/`: run `make gen` at the repository's root after changing a schema (CI checks they're
up to date). `pnpm build` compiles to `dist/`, which is what the package exports, so build it before
using it from a checkout ([the root README](../../../README.md#using-it-from-this-repository)).
`pnpm test` runs the reducer and validator against `spec/examples` and every fixture's events.
