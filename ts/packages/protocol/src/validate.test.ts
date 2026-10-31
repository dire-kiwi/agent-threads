// validate() agrees with Ajv (a full JSON Schema validator) on the protocol's schemas: on the
// examples and fixtures, which are valid, and on commands that aren't.

import { readdirSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { readJson, readJsonl, specDir } from "./examples.js";
import { validate } from "./validate.js";

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats.default(ajv);
ajv.addSchema(readJson("protocol.schema.json") as object, "protocol");
const ajvValid = (def: string, v: unknown) => ajv.getSchema(`protocol#/$defs/${def}`)!(v) as boolean;

const fixtures = readdirSync(specDir + "fixtures", { withFileTypes: true })
  .filter((h) => h.isDirectory())
  .flatMap((h) => readdirSync(`${specDir}fixtures/${h.name}`).map((s) => `fixtures/${h.name}/${s}/expected.jsonl`));

describe("validate", () => {
  it("passes the examples and every fixture's events", () => {
    for (const c of readJsonl("examples/commands.jsonl")) expect(validate(c, "Command")).toEqual([]);
    for (const e of readJsonl("examples/thread.events.jsonl")) expect(validate(e, "ThreadEvent")).toEqual([]);
    expect(validate(readJson("examples/thread.snapshot.json"), "Snapshot")).toEqual([]);
    for (const f of fixtures) for (const e of readJsonl(f)) expect(validate(e, "ThreadEvent"), f).toEqual([]);
  });

  const bad: [string, unknown][] = [
    ["not an object", "send"],
    ["an unknown type", { type: "dance", thread_id: "t" }],
    ["no thread_id", { type: "interrupt" }],
    ["a thread_id that isn't a string", { type: "interrupt", thread_id: 7 }],
    ["send without text", { type: "send", thread_id: "t" }],
    ["send with text that isn't a string", { type: "send", thread_id: "t", text: ["hi"] }],
    ["attachments that aren't an array", { type: "send", thread_id: "t", text: "hi", attachments: {} }],
    ["an attachment without kind", { type: "send", thread_id: "t", text: "hi", attachments: [{ name: "a" }] }],
    ["an attachment of an unknown kind", { type: "send", thread_id: "t", text: "hi", attachments: [{ kind: "video" }] }],
    ["an attachment's path that isn't a string", { type: "send", thread_id: "t", text: "hi", attachments: [{ kind: "file", path: 1 }] }],
    ["a client_id that isn't a string", { type: "send", thread_id: "t", text: "hi", client_id: 3 }],
    ["respond without a resolution", { type: "respond", thread_id: "t", request_id: "r" }],
    ["an unknown outcome", { type: "respond", thread_id: "t", request_id: "r", resolution: { outcome: "maybe" } }],
    ["always that isn't a boolean", { type: "respond", thread_id: "t", request_id: "r", resolution: { outcome: "allow", always: "yes" } }],
    ["answers that aren't arrays", { type: "respond", thread_id: "t", request_id: "r", resolution: { outcome: "answer", answers: { q: "Blue" } } }],
    ["answers that aren't strings", { type: "respond", thread_id: "t", request_id: "r", resolution: { outcome: "answer", answers: { q: [1] } } }],
    ["a model that isn't a string", { type: "set_options", thread_id: "t", model: 4 }],
    ["an unknown permission mode", { type: "set_options", thread_id: "t", permission_mode: "yolo" }],
  ];
  it.each(bad)("rejects a command with %s, as Ajv does", (_, command) => {
    expect(ajvValid("Command", command)).toBe(false);
    expect(validate(command, "Command")).not.toEqual([]);
  });

  it("rejects attachment data that isn't base64", () => {
    expect(validate({ type: "send", thread_id: "t", text: "hi", attachments: [{ kind: "file", data: "not base64!" }] }, "Command")).toEqual([
      ".attachments[0].data: should be base64",
    ]);
  });

  it("allows fields the schema doesn't name", () => {
    expect(validate({ type: "interrupt", thread_id: "t", from: "a newer client" }, "Command")).toEqual([]);
  });
});
