// The client half of the JSON-RPC that `codex app-server` speaks over stdio: one JSON message per
// line, without the "jsonrpc" field.

export type RequestId = string | number;

/** A message from the server: a response to us, a request of its own, or a notification. */
export interface Incoming {
  id?: RequestId;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
}

/** An error response to one of our requests, or the process ending before it was answered. */
export class RpcError extends Error {
  constructor(
    readonly method: string,
    message: string,
    readonly code?: number,
    /** The error response's error object, if it was one. */
    readonly error?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** A request of ours not yet answered: its method, and what the caller noted with it. */
export interface PendingRequest {
  id: RequestId;
  method: string;
  meta?: unknown;
}

export class Rpc {
  #write: (msg: object) => void;
  #next = 1;
  #pending = new Map<RequestId, { method: string; meta?: unknown; resolve: (r: any) => void; reject: (e: Error) => void }>();
  #closed: Error | null = null;

  constructor(write: (msg: object) => void) {
    this.#write = write;
  }

  /** Sends a request; `meta` is kept with it while it's pending, for a checkpoint (see state()). */
  request<R = any>(method: string, params?: unknown, meta?: unknown): Promise<R> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#next++;
    const p = new Promise<R>((resolve, reject) => this.#pending.set(id, { method, ...(meta !== undefined ? { meta } : {}), resolve, reject }));
    this.#write(params === undefined ? { id, method } : { id, method, params });
    return p;
  }

  notify(method: string, params?: unknown): void {
    if (!this.#closed) this.#write(params === undefined ? { method } : { method, params });
  }

  /** Answers one of the server's requests. */
  respond(id: RequestId, result: unknown): void {
    if (!this.#closed) this.#write({ id, result });
  }

  respondError(id: RequestId, message: string, code = -32601): void {
    if (!this.#closed) this.#write({ id, error: { code, message } });
  }

  /** Takes a response to one of our requests; whether it was one. */
  take(msg: Incoming): boolean {
    if (msg.method !== undefined || msg.id === undefined) return false;
    const p = this.#pending.get(msg.id);
    if (!p) return true;
    this.#pending.delete(msg.id);
    if (msg.error) p.reject(new RpcError(p.method, msg.error.message ?? `${p.method} failed`, msg.error.code, msg.error));
    else p.resolve(msg.result ?? {});
    return true;
  }

  /** The next id, and the requests not yet answered: what restore() takes after a restart. */
  state(): { next: number; pending: PendingRequest[] } {
    return { next: this.#next, pending: [...this.#pending].map(([id, p]) => ({ id, method: p.method, ...(p.meta !== undefined ? { meta: p.meta } : {}) })) };
  }

  /** Carries on from state(), with what's to be done with the answers to the requests then pending. */
  restore(next: number, pending: (PendingRequest & { resolve: (r: any) => void; reject: (e: Error) => void })[]): void {
    this.#next = next;
    for (const p of pending) this.#pending.set(p.id, { method: p.method, meta: p.meta, resolve: p.resolve, reject: p.reject });
  }

  /** The process ended: requests still waiting fail with `error`, and later ones straight away. */
  close(error: Error): void {
    this.#closed = error;
    for (const [id, p] of this.#pending) {
      this.#pending.delete(id);
      p.reject(new RpcError(p.method, error.message));
    }
  }
}
