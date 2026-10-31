// The direct spawner: lines out, exit after the last one, and stopping everything a process started.

import { describe, expect, it } from "vitest";
import { direct, type ExitStatus } from "../spawner.js";

function spawn(script: string) {
  const lines: string[] = [];
  let exited: ExitStatus | undefined;
  const proc = direct().spawn(
    { command: "sh", args: ["-c", script], threadId: "th", runId: "run" },
    { line: (l) => lines.push(l), stderr: () => {}, exit: (s) => (exited = s) },
  );
  return { proc, lines, exit: () => exited };
}

const wait = async (what: () => unknown, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!what()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
};

describe.skipIf(process.platform === "win32")("direct()", () => {
  it("passes lines through, and says how it exited after the last", async () => {
    const p = spawn("read x; echo got $x; echo bye; exit 3");
    p.proc.write("hi");
    expect(await wait(p.exit)).toBe(true);
    expect(p.lines).toEqual(["got hi", "bye"]);
    expect(p.exit()).toMatchObject({ code: 3 });
  });

  it("stops what a process started, after the process itself has exited", async () => {
    // The shell exits at once, leaving a sleep that holds its stdout open.
    const p = spawn("sleep 30 & echo started");
    expect(await wait(() => p.lines.length)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(p.exit()).toBeUndefined();
    p.proc.kill("SIGKILL");
    expect(await wait(p.exit)).toBe(true);
  });
});
