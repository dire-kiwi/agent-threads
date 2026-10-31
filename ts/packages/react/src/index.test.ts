// The package's types: the protocol's, with those a component shares a name with under another.
import { expectTypeOf, it } from "vitest";
import type * as react from "./index.js";
import type * as protocol from "@dire-kiwi/agent-threads-protocol";

it("exports the protocol's types", () => {
  expectTypeOf<react.ToolCallItem>().toEqualTypeOf<protocol.ToolCall>();
  expectTypeOf<react.ThreadInfo>().toEqualTypeOf<protocol.Thread>();
  expectTypeOf<react.NoticeItem>().toEqualTypeOf<protocol.Notice>();
  expectTypeOf<react.ThreadEvent>().toEqualTypeOf<protocol.ThreadEvent>();
  expectTypeOf<react.Snapshot>().toEqualTypeOf<protocol.Snapshot>();
  expectTypeOf<react.Item>().toEqualTypeOf<protocol.Item>();
});
