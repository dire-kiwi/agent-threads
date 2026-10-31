// A child process that speaks JSON lines on stdio, with every line in both directions recorded
// (with its time) for a fixture's session.jsonl. The recorder's scenarios drive real CLIs through
// it; nothing here is used when replaying.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class Proc {
  /**
   * @param {object} o
   * @param {number} o.run the run's number in the session (1, 2...)
   * @param {string} o.bin
   * @param {string[]} o.args
   * @param {string} o.cwd
   * @param {Record<string,string>} o.env
   * @param {(entry: object) => void} o.record called with each session entry
   * @param {(msg: any, proc: Proc) => void} [o.onMessage] called with each message from the CLI
   */
  constructor({ run, bin, args, cwd, env, record, onMessage }) {
    this.run = run;
    this.record = record;
    this.onMessage = onMessage;
    this.start = Date.now();
    this.messages = [];
    this.waiters = [];
    record({ run, t: 0, dir: "spawn", argv: [bin, ...args], cwd });
    this.child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", () => {});
    createInterface({ input: this.child.stdout }).on("line", (line) => this.#out(line));
    createInterface({ input: this.child.stderr }).on("line", (text) => this.#entry({ dir: "err", text }));
    this.exited = new Promise((resolve) => {
      this.child.on("exit", (code, signal) => {
        // Let the last stdout lines through first.
        setTimeout(() => {
          this.#entry({ dir: "exit", code, signal });
          this.done = true;
          for (const w of this.waiters.splice(0)) w.reject(new Error(`the CLI exited (${code ?? signal}) while waiting for ${w.what}`));
          resolve({ code, signal });
        }, 50);
      });
    });
  }

  #entry(e) {
    this.record({ run: this.run, t: Date.now() - this.start, ...e });
  }

  #out(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.#entry({ dir: "out", line });
      return;
    }
    this.#entry({ dir: "out", msg });
    this.messages.push(msg);
    for (const w of [...this.waiters]) {
      if (w.pred(msg)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
    this.onMessage?.(msg, this);
  }

  send(msg) {
    this.#entry({ dir: "in", msg });
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  /** Close stdin, as a backend does when it's done with the process. */
  close() {
    this.#entry({ dir: "close" });
    this.child.stdin.end();
  }

  kill(signal = "SIGTERM") {
    this.child.kill(signal);
  }

  /**
   * Wait for the next message from the CLI that matches pred, starting after the last one a
   * previous `next` returned (or from the start).
   */
  next(pred, what = "a message", timeoutMs = 180_000) {
    const from = this.cursor ?? 0;
    for (let i = from; i < this.messages.length; i++) {
      if (pred(this.messages[i])) {
        this.cursor = i + 1;
        return Promise.resolve(this.messages[i]);
      }
    }
    if (this.done) return Promise.reject(new Error(`the CLI had exited before ${what}`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs);
      this.waiters.push({
        what,
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          this.cursor = this.messages.indexOf(m) + 1;
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
