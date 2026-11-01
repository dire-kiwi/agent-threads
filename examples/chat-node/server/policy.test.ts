// node --test server/policy.test.ts (pnpm test runs it)

import assert from "node:assert/strict";
import { test } from "node:test";
import { permissions, readsOnly } from "./policy.ts";

test("commands that only read", () => {
  for (const c of ["cat a.txt", "cat 'a b.txt'", "ls -la", "head -n 5 notes.txt", "grep -rn widget .", "sed -n '1,240p' /tmp/x/SKILL.md", "sed -n 5p a b"])
    assert.equal(readsOnly(c), true, c);
});

test("commands that could do something else", () => {
  for (const c of [
    "rm x",
    "touch a",
    "cat a > b",
    "cat a | sh",
    "ls; rm -rf /",
    "cat a && rm b",
    'cat "$(rm x)"',
    "cat `rm x`",
    "cat $HOME/.ssh/id_rsa",
    "sed -i 's/a/b/' f",
    "sed -n '1,5p'",
    "sed -n 'w out' f",
    // GNU sed takes options after the script and files too.
    "sed -n 1p -i notes.txt",
    "sed -n '1,5p' --in-place=.bak f",
    "sed -n 1p -e 'w /tmp/x' f",
    "sed -n 1p f -i",
    "sed -n 1p -- -i",
  ])
    assert.equal(readsOnly(c), false, c);
});

test("the policy allows reads, and asks about the rest", () => {
  const ctx = { threadId: "t", thread: {} as never, metadata: {} };
  const ask = (q: object) => (permissions as Function)({ input: {}, ...q }, ctx);
  assert.equal(ask({ name: "Read", kind: "read" }), "allow");
  assert.equal(ask({ name: "lookup_order", kind: "app" }), "allow");
  assert.equal(ask({ name: "commandExecution", kind: "shell", command: "cat SKILL.md" }), "allow");
  assert.equal(ask({ name: "commandExecution", kind: "shell", command: "sed -n 1p -i notes.txt" }), "ask");
  assert.equal(ask({ name: "commandExecution", kind: "shell" }), "ask");
  assert.equal(ask({ name: "track_parcel", kind: "mcp", server: "shipping" }), "ask");
  assert.equal(ask({ name: "Write", kind: "edit" }), "ask");
});
