// One thread, live: its state (folded from its events with applyEvent), the running turn, the
// steering queue and open requests. Every change is an event, numbered, applied, sent to the
// subscribers, and saved to the store in order (deltas aren't saved).

import { applyEvent, type Item, type Resolution, type Snapshot, type Thread, type ThreadEvent, type ThreadRequest, type Usage, type UserMessage } from "@dire-kiwi/agent-threads-protocol";
import type { HarnessSession, Message, NewItem, NewRequest, ThreadConfig, ThreadContext, TurnEnd } from "./harness.js";
import { newId } from "./ids.js";
import { decide, type PermissionDecision, type PermissionPolicy, type PermissionQuery } from "./permissions.js";
import type { Spawner } from "./spawner.js";
import type { Store } from "./store.js";

/** An event before it's numbered: what emit() takes. */
type Unnumbered = ThreadEvent extends infer E ? (E extends ThreadEvent ? Omit<E, "seq" | "thread_id"> : never) : never;

export interface Turn {
  id: string;
  interrupted: boolean;
}

interface OpenRequest {
  request: ThreadRequest;
  answered: (resolution: Resolution) => void;
}

/** What a ThreadRuntime needs from the AgentThreads that holds it. */
export interface RuntimeHost {
  store: Store;
  spawner: Spawner;
  publish(event: ThreadEvent): void;
  error(error: unknown): void;
}

export class ThreadRuntime implements ThreadContext {
  readonly threadId: string;
  config: ThreadConfig;
  policy: PermissionPolicy;
  session: HarnessSession | undefined;
  turn: Turn | null = null;
  /** The backend is shutting down: a turn that ends doesn't start another. */
  closing = false;

  #host: RuntimeHost;
  /** The live state, with the text streamed so far. */
  #state: Snapshot;
  /** The saved events' state, without deltas: what a change is a change to. */
  #saved: Snapshot;
  #queue: string[] = []; // ids of queued user messages, oldest first
  #requests = new Map<string, OpenRequest>();
  #always = new Map<string, "allow" | "deny">(); // tool name -> the user's standing answer
  #unsaved: ThreadEvent[] = [];
  #threadChanged = false;
  #writes: Promise<void> = Promise.resolve();
  #flushQueued = false;

  constructor(host: RuntimeHost, state: Snapshot, config: ThreadConfig, policy: PermissionPolicy) {
    this.#host = host;
    this.#state = state;
    this.#saved = state;
    this.threadId = state.thread.id;
    this.config = config;
    this.policy = policy;
  }

  get thread(): Thread {
    return this.#state.thread;
  }
  get snapshot(): Snapshot {
    return this.#state;
  }
  get spawner(): Spawner {
    return this.#host.spawner;
  }
  get turnId(): string | undefined {
    return this.turn?.id;
  }
  get interrupted(): boolean {
    return !!this.turn?.interrupted;
  }

  // ---------- events ----------

  emit(event: Unnumbered): void {
    const saved = event.type !== "delta";
    const e = { ...event, thread_id: this.threadId, seq: this.#state.seq + (saved ? 1 : 0) } as ThreadEvent;
    this.#state = applyEvent(this.#state, e);
    if (saved) {
      this.#saved = applyEvent(this.#saved, e);
      this.#unsaved.push(e);
      this.#scheduleFlush();
    }
    this.#host.publish(e);
  }

  #scheduleFlush(): void {
    if (this.#flushQueued) return;
    this.#flushQueued = true;
    // Events made in the same tick are saved together.
    queueMicrotask(() => {
      this.#flushQueued = false;
      this.#writes = this.#writes.then(() => this.#flush());
    });
  }

  async #flush(): Promise<void> {
    const events = this.#unsaved.splice(0);
    const threadChanged = this.#threadChanged;
    this.#threadChanged = false;
    try {
      if (events.length) await this.#host.store.appendEvents(this.threadId, events);
      if (threadChanged) await this.#host.store.updateThread(this.#state.thread);
    } catch (e) {
      this.#host.error(e);
    }
  }

  /** Resolves once every event so far is saved. */
  async saved(): Promise<void> {
    // Let a flush queued in this tick start, then wait for the writes to finish.
    await Promise.resolve();
    if (this.#flushQueued || this.#unsaved.length) {
      this.#flushQueued = false;
      this.#writes = this.#writes.then(() => this.#flush());
    }
    await this.#writes;
  }

  /** Saves a snapshot, so loading the thread needn't fold all its events. */
  async saveSnapshot(): Promise<void> {
    await this.saved();
    try {
      await this.#host.store.saveSnapshot(this.threadId, this.#saved);
    } catch (e) {
      this.#host.error(e);
    }
  }

  // ---------- items and the thread ----------

  item(id: string): Item | undefined {
    const items = this.#saved.items;
    for (let i = items.length - 1; i >= 0; i--) if (items[i]!.id === id) return items[i];
    return undefined;
  }

  addItem(item: NewItem): void {
    const it = { ...item } as Item & { turn_id?: string; parent_id?: string };
    if (this.turn && it.turn_id === undefined) it.turn_id = this.turn.id;
    if (!it.parent_id) delete it.parent_id;
    this.emit({ type: "item.added", item: it });
  }

  updateItem(id: string, patch: { [k: string]: unknown }): void {
    const item = this.item(id) as unknown as Record<string, unknown> | undefined;
    if (!item) return;
    const changed: { [k: string]: unknown } = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || k === "id" || k === "type") continue;
      if (v === null ? k in item : JSON.stringify(item[k]) !== JSON.stringify(v)) changed[k] = v;
    }
    if (Object.keys(changed).length) this.emit({ type: "item.updated", item_id: id, patch: changed });
  }

  delta(itemId: string, kind: "text" | "reasoning", text: string): void {
    if (text) this.emit({ type: "delta", item_id: itemId, kind, text });
  }

  setThread(patch: Partial<Thread>): void {
    const next: Record<string, unknown> = { ...this.#state.thread };
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || k === "created_at" || k === "updated_at") continue;
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    const { updated_at: _a, ...before } = this.#state.thread;
    const { updated_at: _b, ...after } = next;
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    next.updated_at = new Date().toISOString();
    this.#threadChanged = true;
    this.emit({ type: "thread.updated", thread: next as unknown as Thread });
  }

  // ---------- turns ----------

  /** Sends a message: starts a turn, or steers the running one. */
  send(message: Message & { client_id?: string }): void {
    if (!this.turn) {
      this.#startTurn([message]);
      return;
    }
    const id = newId("um");
    this.addItem({ id, type: "user_message", ...userFields(message), steered: true, queued: true });
    this.#queue.push(id);
    this.session!.steer({ text: message.text, ...(message.attachments ? { attachments: message.attachments } : {}) });
  }

  #startTurn(messages: (Message & { client_id?: string })[]): void {
    this.turn = { id: newId("turn"), interrupted: false };
    for (const m of messages) this.addItem({ id: newId("um"), type: "user_message", ...userFields(m) });
    this.emit({ type: "turn.started", turn_id: this.turn.id });
    this.setThread({ status: "running", error: undefined });
    this.session!.start(messages.map((m) => ({ text: m.text, ...(m.attachments ? { attachments: m.attachments } : {}) })));
  }

  queued(): UserMessage[] {
    return this.#queue.map((id) => this.item(id)).filter((i): i is UserMessage => i?.type === "user_message");
  }

  tookIn(text: string): boolean {
    const at = this.#queue.findIndex((id) => (this.item(id) as UserMessage | undefined)?.text === text);
    if (at < 0) return false;
    const [id] = this.#queue.splice(at, 1);
    this.updateItem(id!, { queued: null });
    return true;
  }

  interrupt(): void {
    if (!this.turn || this.turn.interrupted) return;
    this.turn.interrupted = true;
    this.session?.interrupt();
  }

  endTurn(end: TurnEnd): void {
    const turn = this.turn;
    if (!turn) return;
    for (const it of this.#state.items) {
      if (it.type === "tool_call" && it.turn_id === turn.id && (it.status === "running" || it.status === "pending")) {
        this.updateItem(it.id, { status: "cancelled" });
      }
    }
    for (const [id, r] of this.#requests) {
      if (r.request.turn_id !== undefined && r.request.turn_id !== turn.id) continue;
      this.#requests.delete(id);
      this.emit({ type: "request.resolved", request_id: id, resolution: { outcome: "cancel" } });
    }
    const ok = end.ok && !turn.interrupted;
    const error = !ok && !turn.interrupted ? end.error || "The turn failed." : undefined;
    this.addItem({
      id: newId("tr"),
      type: "turn_result",
      ok,
      ...(turn.interrupted ? { interrupted: true } : {}),
      ...(error ? { error } : {}),
      ...(end.usage ? { usage: end.usage } : {}),
      ...(end.duration_ms !== undefined ? { duration_ms: end.duration_ms } : {}),
    });
    this.emit({ type: "turn.completed", turn_id: turn.id });
    this.turn = null;
    this.setThread({ status: error ? "error" : "idle", error, usage: addUsage(this.#state.thread.usage, end.usage) });

    // A steered message the harness didn't take in starts the next turn.
    const left = this.closing ? [] : this.queued();
    if (left.length) {
      this.turn = { id: newId("turn"), interrupted: false };
      for (const m of left) this.updateItem(m.id, { turn_id: this.turn.id });
      this.emit({ type: "turn.started", turn_id: this.turn.id });
      this.setThread({ status: "running", error: undefined });
      this.session?.carryOver(left.map((m) => ({ text: m.text, ...(m.attachments ? { attachments: m.attachments } : {}) })));
    } else {
      void this.saveSnapshot();
    }
  }

  // ---------- requests ----------

  decide(query: PermissionQuery): PermissionDecision | Promise<PermissionDecision> {
    const standing = this.#always.get(query.name);
    if (standing) return standing;
    return decide(this.policy, query, { threadId: this.threadId, thread: this.thread, metadata: this.thread.metadata ?? {} });
  }

  ask(request: NewRequest, toolCallId: string | undefined, answered: (resolution: Resolution) => void): string {
    const r = { ...request, id: newId(request.type === "question" ? "q" : "perm") } as ThreadRequest;
    if (this.turn) r.turn_id = this.turn.id;
    const call = toolCallId ? this.item(toolCallId) : undefined;
    if (call) {
      r.tool_call_id = call.id;
      if (call.parent_id) r.parent_id = call.parent_id;
      this.updateItem(call.id, { status: "pending" });
    }
    this.#requests.set(r.id, { request: r, answered });
    this.emit({ type: "request.opened", request: r });
    this.setThread({ status: "waiting" });
    return r.id;
  }

  respond(requestId: string, resolution: Resolution): void {
    const open = this.#requests.get(requestId);
    if (!open) return;
    this.#requests.delete(requestId);
    this.emit({ type: "request.resolved", request_id: requestId, resolution });
    if (!this.#requests.size && this.turn) this.setThread({ status: "running" });
    if (resolution.always && open.request.type === "permission" && (resolution.outcome === "allow" || resolution.outcome === "deny")) {
      this.#always.set(open.request.name, resolution.outcome);
    }
    open.answered(resolution);
  }

  cancelRequest(id: string): void {
    if (!this.#requests.has(id)) return;
    this.#requests.delete(id);
    this.emit({ type: "request.resolved", request_id: id, resolution: { outcome: "cancel" } });
    if (!this.#requests.size && this.turn) this.setThread({ status: "running" });
  }

  get openRequests(): ThreadRequest[] {
    return [...this.#requests.values()].map((r) => r.request);
  }

  error(error: unknown): void {
    this.#host.error(error);
  }
}

function userFields(m: Message & { client_id?: string }): Omit<UserMessage, "id" | "type"> {
  return {
    text: m.text,
    ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    ...(m.client_id ? { client_id: m.client_id } : {}),
  };
}

/** a + b, with costs rounded to a picodollar so sums don't drift. */
export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!b) return a;
  if (!a) return { ...b };
  const out: Record<string, number> = { ...(a as unknown as Record<string, number>) };
  for (const [k, v] of Object.entries(b)) {
    if (typeof v !== "number") continue;
    out[k] = k === "cost_usd" ? Math.round(((out[k] ?? 0) + v) * 1e12) / 1e12 : (out[k] ?? 0) + v;
  }
  return out as unknown as Usage;
}
