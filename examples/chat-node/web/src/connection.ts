// The frontend's half of the app's transport: one WebSocket to the server (examples/PROTOCOL.md),
// reconnecting when it drops. Requests are {id, method, params} with one reply each; pushed events
// go to whoever listens.

import type { ThreadEvent } from "@dire-kiwi/agent-threads-react";

export type Status = "connecting" | "open" | "closed";

export class Connection {
  status: Status = "connecting";
  /** Counts the times it has connected, so what's fetched per connection is fetched again. */
  generation = 0;
  #url: string;
  #ws: WebSocket | undefined;
  #next = 0;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #events = new Set<(e: ThreadEvent) => void>();
  #changes = new Set<() => void>();
  #retry = 500;

  constructor(url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`) {
    this.#url = url;
    this.#open();
  }

  /** Calls one of the server's methods; rejects with its error, or if the connection drops first. */
  call<T = unknown>(method: string, params?: object): Promise<T> {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("not connected to the server"));
    const id = ++this.#next;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }));
    });
  }

  /** Calls `fn` with every thread's events. Returns how to stop. */
  onEvent(fn: (e: ThreadEvent) => void): () => void {
    this.#events.add(fn);
    return () => void this.#events.delete(fn);
  }

  /** For useSyncExternalStore: called when `status` or `generation` changes. */
  subscribe = (fn: () => void): (() => void) => {
    this.#changes.add(fn);
    return () => void this.#changes.delete(fn);
  };

  #set(status: Status) {
    this.status = status;
    if (status === "open") this.generation++;
    for (const fn of this.#changes) fn();
  }

  #open() {
    const ws = new WebSocket(this.#url);
    this.#ws = ws;
    ws.onopen = () => {
      this.#retry = 500;
      this.#set("open");
    };
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.type === "event") {
        for (const fn of this.#events) fn(msg.event);
        return;
      }
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if ("error" in msg) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    };
    ws.onclose = () => {
      for (const p of this.#pending.values()) p.reject(new Error("the connection to the server dropped"));
      this.#pending.clear();
      this.#set("closed");
      setTimeout(() => this.#open(), this.#retry);
      this.#retry = Math.min(this.#retry * 2, 5000);
    };
  }
}
