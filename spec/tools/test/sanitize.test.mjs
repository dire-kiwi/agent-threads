// The recorder's sanitizer cleans a path even when a stream of deltas splits it, and the
// recording machine's details wherever they are.

import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizer } from "../lib/sanitize.mjs";

const PRIVATE = "/home/private-account/project";

/** Two pieces of a stream, split inside the private path, as session entries. */
const split = (make) => [make("Working in /home/private-"), make("account/project now")].map((msg) => ({ run: 1, t: 0, dir: "out", msg }));

const joined = (entries, get) => entries.map((e) => get(e.msg)).join("");

for (const method of ["item/agentMessage/delta", "item/reasoning/textDelta", "item/commandExecution/outputDelta"]) {
  test(`cleans a path split across Codex's ${method} pieces`, () => {
    const clean = sanitizer([[PRIVATE, "/work"]]);
    const out = clean(split((delta) => ({ method, params: { threadId: "th", turnId: "tu", itemId: "it", delta } })));
    assert.equal(joined(out, (m) => m.params.delta), "Working in /work now");
  });
}

test("cleans a path split across Claude's text deltas", () => {
  const clean = sanitizer([[PRIVATE, "/work"]]);
  const out = clean(
    split((text) => ({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      parent_tool_use_id: null,
      api_message_id: "msg_1",
    })),
  );
  assert.equal(joined(out, (m) => m.event.delta.text), "Working in /work now");
});

test("keeps separate streams apart", () => {
  const clean = sanitizer([[PRIVATE, "/work"]]);
  const entries = split((delta) => ({ method: "item/agentMessage/delta", params: { threadId: "th", itemId: "a", delta } }));
  entries[1].msg.params.itemId = "b"; // a different message: nothing to join
  const out = clean(entries);
  assert.equal(joined(out, (m) => m.params.delta), "Working in /home/private-account/project now");
});

test("replaces the machine's git name and email, and its host name in any case", () => {
  const git = (key) => {
    try {
      return execFileSync("git", ["config", key], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  const [name, email, host] = [git("user.name"), git("user.email"), hostname()];
  const text = [name, email, host.length > 3 ? host.toUpperCase() : ""].filter(Boolean).join(" | ");
  const [out] = sanitizer([])([{ run: 1, dir: "out", msg: { text: `Git user: ${text}` } }]);
  for (const v of [name, email, host.length > 3 ? host : ""].filter(Boolean)) assert.ok(!out.msg.text.toLowerCase().includes(v.toLowerCase()), out.msg.text);
});

test("leaves out the skills the recording machine has, keeping Codex's own", () => {
  const skill = (name, scope) => ({ name, description: name, path: `/x/${name}/SKILL.md`, scope, enabled: true });
  const [list, start] = sanitizer([])([
    { run: 1, dir: "out", msg: { id: 2, result: { data: [{ cwd: "/work", skills: [skill("imagegen", "system"), skill("mine", "user")], errors: [] }] } } },
    { run: 1, dir: "in", msg: { id: 3, method: "thread/start", params: { model: "m", config: { "features.x": true, skills: { config: [{ path: "/x/mine/SKILL.md", enabled: false }] } } } } },
  ]);
  assert.deepEqual(list.msg.result.data[0].skills.map((s) => s.name), ["imagegen"]);
  assert.deepEqual(start.msg.params.config, { "features.x": true });
});
