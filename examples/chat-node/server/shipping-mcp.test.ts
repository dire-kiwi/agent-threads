// node --test server/shipping-mcp.test.ts (pnpm test runs it): the MCP server, run as a harness runs it.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("track_parcel finds the parcels it has, and says so for any other order id, however it's spelled", async () => {
  const proc = spawn(process.execPath, [fileURLToPath(new URL("./shipping-mcp.ts", import.meta.url))], { stdio: ["pipe", "pipe", "inherit"] });
  const replies = new Map<number, (r: any) => void>();
  createInterface({ input: proc.stdout! }).on("line", (line) => {
    const msg = JSON.parse(line);
    replies.get(msg.id)?.(msg);
  });
  let next = 0;
  const call = (method: string, params?: object) =>
    new Promise<any>((resolve, reject) => {
      const id = ++next;
      replies.set(id, resolve);
      proc.once("exit", (code) => reject(new Error(`the server exited (${code})`)));
      proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  try {
    assert.equal((await call("initialize", {})).result.serverInfo.name, "shipping");
    const track = (order_id: string) => call("tools/call", { name: "track_parcel", arguments: { order_id } });

    const found = await track("#42");
    assert.equal(found.result.isError, undefined);
    assert.match(found.result.content[0].text, /^Parcel NZP-4410-2291 for order 42:/);

    for (const id of ["7", "__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
      const r = await track(id);
      assert.deepEqual(r.result, { content: [{ type: "text", text: `No parcel has been shipped for order ${id}.` }], isError: true }, id);
    }
    // Still there after all that.
    assert.deepEqual((await call("ping")).result, {});
  } finally {
    proc.kill();
  }
});
