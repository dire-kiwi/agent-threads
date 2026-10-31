// The examples in spec/examples are valid against the schemas.

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { readJson, readJsonl } from "./examples.js";

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats.default(ajv);
ajv.addSchema(readJson("protocol.schema.json") as object, "protocol");
const validator = (def: string) => ajv.getSchema(`protocol#/$defs/${def}`)!;

function expectValid(def: string, value: unknown) {
  const validate = validator(def);
  validate(value);
  expect(validate.errors ?? []).toEqual([]);
}

describe("spec/examples", () => {
  it.each(readJsonl("examples/thread.events.jsonl").map((e, i) => [i + 1, e]))("event %i is a ThreadEvent", (_, event) =>
    expectValid("ThreadEvent", event),
  );
  it.each(readJsonl("examples/commands.jsonl").map((c, i) => [i + 1, c]))("command %i is a Command", (_, command) =>
    expectValid("Command", command),
  );
  it("thread.snapshot.json is a Snapshot", () => expectValid("Snapshot", readJson("examples/thread.snapshot.json")));
});

describe("the schemas", () => {
  it("tell union variants apart by type", () => {
    expect(validator("Item")({ id: "x", type: "notice", text: "no level" })).toBe(false);
    expect(validator("Item")({ id: "x", type: "other", text: "hi" })).toBe(false);
    expect(validator("Command")({ type: "interrupt", thread_id: "t", text: "hi" })).toBe(true);
    expect(validator("Command")({ type: "send", thread_id: "t" })).toBe(false);
  });
});
