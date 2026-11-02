// One thread, live: its state (folded from its events with applyEvent), the running turn, the
// steering queue and open requests. Every change is an event, numbered, applied, sent to the
// subscribers, and saved to the store in order (deltas aren't saved).

import { applyEvent, type Attachment, type Item, type RateLimit, type Resolution, type Snapshot, type Thread, type ThreadEvent, type ThreadRequest, type TurnResult, type TurnSession, type Usage, type UserMessage } from "@dire-kiwi/agent-threads-protocol";
import type { HarnessMessage, HarnessSession, LaunchOptions, Message, NewItem, NewRequest, ThreadConfig, ThreadContext, TurnEnd } from "./harness.js";
import { newId } from "./ids.js";
import { normalLaunch, sameLaunch, storedThread, type StoredThread } from "./launch.js";
import { decide, permissionKey, type PermissionDecision, type PermissionPolicy, type PermissionQuery } from "./permissions.js";
import { RewindError } from "./sessions.js";
import type { Spawner } from "./spawner.js";
import { StoreError, type RunRecord, type Store } from "./store.js";

/** An event before it's numbered: what emit() takes. */
type Unnumbered = ThreadEvent extends infer E ? (E extends ThreadEvent ? Omit<E, "seq" | "thread_id"> : never) : never;

export interface Turn {
  id: string;
  interrupted: boolean;
  /** The thread's session_id when it started (none: it starts a new session). */
  session?: string;
  /**
   * How many turns in a row (this one included) are retries for messages left queued that took
   * none in: carried over from the turn before, or sent again with an explicit message.
   */
  carried?: number;
  /** The harness took in a queued message during it. */
  progressed?: boolean;
}

/** How many retries in a row for queued messages may take none in. */
const MAX_CARRIED = 3;

// Steered messages, and who has them. A steered message is queued (its item has `queued`, and
// its id is in #queue) until the harness echoes it back as taken in (tookIn); nothing else
// unqueues it. Until then it's either with the session's live process (written to its stdin)
// or with nobody. When a turn ends with messages queued, endTurn either carries them over (a
// new turn, which the live process takes them into, or a new process if there's none) or gives
// up on them: then the session releases them, stopping any process that has them so it can't
// act on them unseen, and they're sent again, first, with the next message the user sends. (The
// driver sends messages that go together as one: a harness may make a turn of each.)

interface OpenRequest {
  request: ThreadRequest;
  answered: (resolution: Resolution) => void;
  /** The tool it's about (permissionKey), for an answer given `always`. */
  standing?: string;
}

/** A message as sent: its text and attachments, and the client's id for it. */
export interface Outgoing {
  text: string;
  attachments?: Attachment[];
  client_id?: string;
}

/** What a ThreadRuntime needs from the AgentThreads that holds it. */
export interface RuntimeHost {
  store: Store;
  spawner: Spawner;
  /** Fill in events' `raw` (the raw option). */
  raw: boolean;
  publish(event: ThreadEvent): void;
  /** A line from the thread's harness, for the app's onHarnessMessage. */
  harnessMessage(message: HarnessMessage): void;
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
  /** The run it had when it was loaded, which was lost (not re-attached to). */
  lostRun: string | undefined;

  #host: RuntimeHost;
  /** How its harness process is started: stored with the thread. */
  #launch: LaunchOptions;
  /** The live state, with the text streamed so far. */
  #state: Snapshot;
  /** The saved events' state, without deltas: what a change is a change to. */
  #saved: Snapshot;
  #queue: string[] = []; // ids of queued user messages, oldest first
  #requests = new Map<string, OpenRequest>();
  #always = new Map<string, "allow" | "deny">(); // permissionKey -> the user's standing answer
  #unsaved: ThreadEvent[] = []; // saved events not yet in the store, in order
  #threadChanged = false;
  #writes: Promise<void> = Promise.resolve();
  #flushQueued = false;
  #failure: { error: unknown } | undefined; // why the last write failed, while writes are failing
  #retry: NodeJS.Timeout | undefined;
  #backoff = 0;
  /** Flushes started, and the last one that saved all it took (each takes everything up to its start). */
  #flushes = 0;
  #savedAt = 0;
  /** The run record last saved, while its run goes on (with a durable spawner). */
  #run: { record: RunRecord; json: string } | undefined;
  /** Items text has streamed into since the turn began (whose text may not be saved yet). */
  #streaming = new Set<string>();
  /** App tools' structured output, by tool call, until the harness gives the call its result. */
  #structured = new Map<string, unknown>();
  /** The harness message being handled, which events made now have as their `raw` (with the raw option). */
  #raw: unknown = undefined;

  constructor(host: RuntimeHost, state: Snapshot, config: ThreadConfig, launch: LaunchOptions, policy: PermissionPolicy) {
    this.#host = host;
    this.#launch = normalLaunch(launch);
    this.#state = state;
    this.#saved = state;
    this.threadId = state.thread.id;
    // Messages left queued (by a harness that kept failing, or before a restart) go with the next.
    this.#queue = state.items.filter((i) => i.type === "user_message" && i.queued).map((i) => i.id);
    this.config = config;
    this.policy = policy;
  }

  get thread(): Thread {
    return this.#state.thread;
  }
  get launch(): LaunchOptions {
    return this.#launch;
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
    // An item or request has the harness message it came from, and its event doesn't as well.
    const raw = this.#raw;
    if (raw !== undefined) {
      if (event.type === "item.added") event = { ...event, item: { ...event.item, raw } };
      else if (event.type === "request.opened") event = { ...event, request: { ...event.request, raw } };
      else event = { ...event, raw };
    }
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

  /**
   * Appends the unsaved events, then the thread. Events stay unsaved until the store has them, so
   * a write that fails is tried again (with the events after it), in order, and nothing is lost or
   * numbered around a gap.
   */
  async #flush(): Promise<void> {
    const store = this.#host.store;
    const gen = ++this.#flushes;
    // Taken at the same moment as the events, so the run's offset and state are as of them.
    const events = this.#unsaved.slice();
    const { runs, run } = this.#runs();
    const threadChanged = this.#threadChanged;
    if (!events.length && !threadChanged && !runs.length) return void (this.#savedAt = gen);
    try {
      if (events.length || runs.length) {
        try {
          await store.appendEvents(this.threadId, events, runs);
        } catch (e) {
          // An append reported as failed may have happened anyway: keep only what the store lacks.
          if (!(e instanceof StoreError && e.kind === "seq")) throw e;
          const last = await store.lastSeq(this.threadId);
          const rest = events.filter((x) => x.seq > last);
          if (rest.length === events.length) throw e;
          await store.appendEvents(this.threadId, rest, runs);
        }
        this.#unsaved.splice(0, events.length);
        this.#run = run;
      }
      if (threadChanged) {
        this.#threadChanged = false;
        try {
          await store.updateThread(this.storedThread());
        } catch (e) {
          this.#threadChanged = true;
          throw e;
        }
      }
      this.#failure = undefined;
      this.#backoff = 0;
      this.#savedAt = gen;
    } catch (e) {
      this.#failure = { error: e };
      this.#host.error(e);
      this.#retryLater();
    }
  }

  /**
   * With a durable spawner, the runs to save with the events: the session's running one, if it
   * changed since it was last saved, and the one before it as ended if that's done.
   */
  #runs(): { runs: RunRecord[]; run: { record: RunRecord; json: string } | undefined } {
    const spawner = this.#host.spawner;
    if (!spawner.durable) return { runs: [], run: undefined };
    const runs: RunRecord[] = [];
    const now = new Date().toISOString();
    const thread = this.#saved.thread;
    // A driver that can't re-attach still has its run recorded, so a restart can stop it.
    const cp = this.session?.checkpoint ? this.session.checkpoint() : thread.run?.spawner === spawner.name ? { id: thread.run.id, offset: 0, state: undefined } : undefined;
    const before = this.#run?.record;
    let run = this.#run;
    if (before && before.id !== cp?.id) {
      if (before.ended_at == null) runs.push({ ...before, ended_at: now });
      run = undefined;
    }
    // A run that's over is saved once more, as it ended.
    if (!cp || (before?.id === cp.id && before.ended_at != null)) return { runs, run };
    const live = this.#liveText();
    const draft: RunRecord = {
      id: cp.id,
      thread_id: this.threadId,
      spawner: spawner.name,
      offset: cp.offset,
      started_at: before?.id === cp.id ? before.started_at : thread.run?.id === cp.id && thread.run.started_at ? thread.run.started_at : now,
      ...("ended" in cp && cp.ended ? { ended_at: now } : {}),
      data: {
        ...("dir" in cp && cp.dir ? { dir: cp.dir } : {}),
        ...("input" in cp && cp.input !== undefined ? { input: cp.input } : {}),
        turn: this.turn,
        state: cp.state,
        ...(live ? { live } : {}),
        // App tools' structured output whose calls the harness hasn't given their result yet.
        ...(this.#structured.size ? { structured: Object.fromEntries(this.#structured) } : {}),
      },
    };
    // A copy, taken now: the store may write it later, after more of the run's output has changed
    // the driver's state and the turn.
    const json = JSON.stringify(draft);
    const record = JSON.parse(json) as RunRecord;
    if (json !== this.#run?.json) runs.push(record);
    return { runs, run: { record, json } };
  }

  /**
   * Text streamed into items that the saved events don't have yet (deltas aren't saved), by item:
   * saved with the run, since the run's output it came from won't be read again.
   */
  #liveText(): { [id: string]: string } | undefined {
    let live: { [id: string]: string } | undefined;
    for (const id of this.#streaming) {
      const now = findItem(this.#state.items, id);
      const saved = findItem(this.#saved.items, id);
      if (now && "text" in now && saved && "text" in saved && now.text !== saved.text) (live ??= {})[id] = now.text;
    }
    return live;
  }

  /**
   * The run record saved last, for a backend that re-attached to it, with the text that had
   * streamed in as of it (shown again, as deltas, before the run's output is read on) and the app
   * tools' structured output still waiting for their calls' results.
   */
  adoptRun(record: RunRecord): void {
    this.#run = { record, json: JSON.stringify(record) };
    const data = record.data as { live?: { [id: string]: string }; structured?: { [id: string]: unknown } } | undefined;
    this.#structured = new Map(Object.entries(data?.structured ?? {}));
    const live = data?.live ?? {};
    for (const [id, text] of Object.entries(live)) {
      const item = this.item(id);
      if (!item || (item.type !== "assistant_message" && item.type !== "reasoning") || !text.startsWith(item.text)) continue;
      this.delta(id, item.type === "assistant_message" ? "text" : "reasoning", text.slice(item.text.length));
    }
  }

  /**
   * Saves the run's checkpoint now, with whatever events there are, and resolves once it's saved
   * (with a durable spawner; otherwise at once): for a driver about to do something that mustn't
   * be done again after a restart. Rejects with the store's error if it can't be saved.
   */
  async persist(): Promise<void> {
    if (!this.#host.spawner.durable) return;
    // Saved once a flush started after now has saved all it took, whatever has been read since.
    const after = this.#flushes;
    this.#scheduleFlush();
    try {
      await this.saved();
    } catch {
      // Said below, if it's this write that failed.
    }
    // A write of only the run that failed leaves no events unsaved, so saved() mightn't say.
    if (this.#savedAt <= after) throw this.#failure?.error ?? new Error("the run couldn't be saved");
  }

  #retryLater(): void {
    if (this.#retry || this.closed) return;
    this.#backoff = Math.min(Math.max(this.#backoff * 2, 250), 30_000);
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      this.#writes = this.#writes.then(() => this.#flush());
    }, this.#backoff);
    this.#retry.unref?.();
  }

  /** Resolves once every event so far is saved; rejects with the store's error if it can't be. */
  async saved(): Promise<void> {
    // Let a flush queued in this tick start, then wait for the writes to finish.
    await Promise.resolve();
    if (this.#flushQueued || this.#unsaved.length || this.#threadChanged) {
      this.#flushQueued = false;
      this.#writes = this.#writes.then(() => this.#flush());
    }
    await this.#writes;
    if (this.#failure && (this.#unsaved.length || this.#threadChanged || this.#runs().runs.length)) throw this.#failure.error;
  }

  /** Saves a snapshot, so loading the thread needn't fold all its events; never one ahead of them. */
  async saveSnapshot(): Promise<void> {
    try {
      await this.saved();
    } catch {
      return; // Already reported; the events come first.
    }
    if (this.#unsaved.length) return;
    try {
      await this.#host.store.saveSnapshot(this.threadId, this.#saved);
    } catch (e) {
      this.#host.error(e);
    }
  }

  /** Stops retrying writes: the backend is closing. */
  closed = false;
  dispose(): void {
    this.closed = true;
    clearTimeout(this.#retry);
    this.#retry = undefined;
  }

  // ---------- items and the thread ----------

  /** The thread as the store keeps it: with its launch options, which clients aren't sent. */
  storedThread(): StoredThread {
    return storedThread(this.#state.thread, this.#launch);
  }

  /** Changes how the harness process is started, from the next one; it's saved with the thread. */
  setLaunch(launch: LaunchOptions): void {
    if (sameLaunch(launch, this.#launch)) return;
    this.#launch = normalLaunch(launch);
    this.#threadChanged = true;
    this.#scheduleFlush();
    this.session?.optionsChanged();
  }

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
    const result = patch.result as { [k: string]: unknown } | null | undefined;
    if (result && this.#structured.has(id)) {
      if (result.structured === undefined) patch = { ...patch, result: { ...result, structured: this.#structured.get(id) } };
      this.#structured.delete(id);
    }
    const changed: { [k: string]: unknown } = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || k === "id" || k === "type") continue;
      if (v === null ? k in item : JSON.stringify(item[k]) !== JSON.stringify(v)) changed[k] = v;
    }
    if (Object.keys(changed).length) this.emit({ type: "item.updated", item_id: id, patch: changed });
  }

  toolOutput(toolCallId: string, structured: unknown): void {
    if (structured !== undefined) this.#structured.set(toolCallId, structured);
  }

  delta(itemId: string, kind: "text" | "reasoning", text: string): void {
    if (!text) return;
    this.#streaming.add(itemId);
    // Where it goes: the length of the item's text so far, the deltas before it included.
    const item = this.#state.items.findLast((i) => i.id === itemId);
    const offset = item?.type === "assistant_message" || item?.type === "reasoning" ? item.text.length : 0;
    this.emit({ type: "delta", item_id: itemId, kind, offset, text });
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

  rateLimits(limits: RateLimit[]): void {
    if (!limits.length) return;
    const all = new Map((this.thread.rate_limits ?? []).map((l) => [l.id, l]));
    for (const l of limits) all.set(l.id, l);
    this.setThread({ rate_limits: [...all.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) });
  }

  fromHarness(runId: string, line: string, message: unknown, handle: () => void): void {
    const before = this.#raw;
    if (this.#host.raw && message !== undefined) this.#raw = message;
    try {
      handle();
    } finally {
      this.#raw = before;
    }
    this.#host.harnessMessage({ threadId: this.threadId, runId, harness: this.thread.harness, line, ...(message !== undefined ? { message } : {}) });
  }

  // ---------- turns ----------

  /** Sends a message: starts a turn, or steers the running one. */
  send(message: Outgoing): void {
    const id = newId("um");
    if (!this.turn) {
      // Messages still queued from before weren't delivered: they go first, in this turn, and stay
      // queued until the harness takes them in. Such a turn is a retry for them.
      const left = this.queued();
      this.turn = { id: newId("turn"), interrupted: false, ...this.#sessionNow(), ...(left.length ? { carried: 1 } : {}) };
      for (const m of left) this.updateItem(m.id, { turn_id: this.turn.id });
      this.addItem({ id, type: "user_message", ...userFields(message) });
      this.emit({ type: "turn.started", turn_id: this.turn.id });
      this.setThread({ status: "running", error: undefined });
      this.session!.start([...left.map((m) => toMessage(m.id, m)), toMessage(id, message)]);
      return;
    }
    this.addItem({ id, type: "user_message", ...userFields(message), steered: true, queued: true });
    this.#queue.push(id);
    this.session!.steer(toMessage(id, message));
  }

  /** The session a turn starting now starts in, for its Turn. */
  #sessionNow(): { session?: string } {
    const s = this.#state.thread.session_id;
    return s ? { session: s } : {};
  }

  /** Compacts the harness's context: a turn with no message. The caller checks one can start. */
  compact(): void {
    this.turn = { id: newId("turn"), interrupted: false, ...this.#sessionNow() };
    this.emit({ type: "turn.started", turn_id: this.turn.id });
    this.setThread({ status: "running", error: undefined });
    this.session!.compact!();
  }

  /** The next turn starts a new session. The caller checks no turn is running. */
  newSession(): void {
    if (!this.#state.thread.session_id) return;
    this.setThread({ session_id: undefined, resume_at: undefined });
    this.addItem({ id: newId("n"), type: "notice", level: "info", code: "session.new", text: NEW_SESSION_TEXT });
    this.session?.optionsChanged();
  }

  /**
   * Takes the conversation back to before the turn `turnId`: its items and every later turn's go,
   * and the session goes where the harness says (see sessions.ts). Throws for a turn the thread
   * hasn't, or one the harness can't rewind to. The caller checks no turn is running.
   */
  rewind(turnId: string): void {
    const items = this.#saved.items;
    const results = items.filter((it): it is TurnResult => it.type === "turn_result" && !it.parent_id);
    const index = results.findIndex((r) => r.turn_id === turnId);
    if (index < 0) throw new RewindError(`there's no turn ${turnId} in the thread`);
    if (!this.session?.rewindPoint) throw new RewindError(`${this.thread.harness} threads can't be rewound`);
    const point = this.session.rewindPoint(
      results.map((r): TurnSession | undefined => r.session),
      index,
    );
    // The turn and those after it, in the order they ran (a message carried over to a later turn
    // keeps its place in the items, so their order isn't the turns'). What isn't any turn's goes
    // too, after the last turn kept and the first item of one that goes.
    const dropped = new Set(results.slice(index).map((r) => r.turn_id));
    const kept = index > 0 ? items.indexOf(results[index - 1]!) : -1;
    const first = items.findIndex((it) => it.turn_id !== undefined && dropped.has(it.turn_id));
    const gone = items.filter((it, i) => (it.turn_id !== undefined ? dropped.has(it.turn_id) : i > kept && i > first)).map((it) => it.id);
    const goneSet = new Set(gone);
    this.#queue = this.#queue.filter((id) => !goneSet.has(id));
    // A rewind not yet made (resume_at) went back to before a later turn of the same session: with
    // no mark of its own to go to, this one still needs that one made, as the turns since added
    // nothing to the session but the ones it took back are still in it.
    const t = this.#state.thread;
    const resumeAt = point.resume_at ?? (point.session_id !== undefined && point.session_id === t.session_id ? t.resume_at : undefined);
    this.emit({ type: "items.removed", item_ids: gone });
    this.setThread({ session_id: point.session_id, resume_at: resumeAt });
    this.addItem({ id: newId("n"), type: "notice", level: "info", code: "rewind", text: REWIND_TEXT });
    this.session.optionsChanged();
  }

  queued(): UserMessage[] {
    return this.#queue.map((id) => this.item(id)).filter((i): i is UserMessage => i?.type === "user_message");
  }

  tookIn(id: string): boolean {
    const at = this.#queue.indexOf(id);
    if (at < 0) return false;
    this.#queue.splice(at, 1);
    this.updateItem(id, { queued: null });
    if (this.turn) this.turn.progressed = true;
    return true;
  }

  interrupt(): void {
    if (!this.turn || this.turn.interrupted) return;
    this.turn.interrupted = true;
    this.session?.interrupt();
    // No event says so, but a run that outlives the backend is saved with its turn.
    if (this.#host.spawner.durable) this.#scheduleFlush();
  }

  /**
   * The running turn ended. Its queued messages are carried over to a new turn unless `carry` is
   * false (shutting down, or recovering a turn the backend lost), or they've been tried enough.
   */
  endTurn(end: TurnEnd, { carry = true }: { carry?: boolean } = {}): void {
    const turn = this.turn;
    if (!turn) return;
    // Text streamed but never finished (its process went first) is kept as it was shown.
    for (const it of this.#state.items) {
      if (it.type !== "assistant_message" && it.type !== "reasoning") continue;
      const saved = this.item(it.id);
      if (saved && "text" in saved && saved.text !== it.text) this.updateItem(it.id, { text: it.text });
    }
    this.#streaming.clear();
    this.#structured.clear();
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
    const sessionId = this.#state.thread.session_id;
    this.addItem({
      id: newId("tr"),
      type: "turn_result",
      ok,
      ...(turn.interrupted ? { interrupted: true } : {}),
      ...(error ? { error } : {}),
      ...(end.usage ? { usage: end.usage } : {}),
      ...(end.duration_ms !== undefined ? { duration_ms: end.duration_ms } : {}),
      ...(sessionId ? { session: { id: sessionId, ...(end.session_at ? { at: end.session_at } : {}), ...(!turn.session ? { started: true } : {}) } } : {}),
    });
    this.emit({ type: "turn.completed", turn_id: turn.id });
    this.turn = null;
    const usage = addUsage(this.#state.thread.usage, end.usage);

    // Queued messages are carried over to the next turn, unless:
    // - shutting down (which closes the process that has them), or the turn was lost (its process
    //   is gone): they wait, queued, for the next message;
    // - that's been tried enough: a retry that was interrupted (the user wants it stopped), one that
    //   failed with no process left holding them, or too many in a row that took none in. Then a
    //   process that has them is stopped, and they wait too. A retry that failed while its process
    //   lives and holds them carries over again (to the limit), since that process would otherwise
    //   take them in unseen. (A process holding several makes a turn of each, so a retry that took
    //   one in has made progress.)
    const left = this.queued();
    const retry = (turn.carried ?? 0) > 0;
    const carried = turn.progressed ? 0 : (turn.carried ?? 0);
    const giveUp =
      !left.length ||
      !carry ||
      this.closing ||
      carried >= MAX_CARRIED ||
      (retry && turn.interrupted) ||
      (carried > 0 && !ok && !(this.session?.live() ?? false));
    if (giveUp) {
      this.setThread({ status: error ? "error" : "idle", error, usage });
      if (left.length && carry && !this.closing) this.session?.release();
      if (left.length && !this.closing) this.#undelivered(left.length);
      void this.saveSnapshot();
      return;
    }
    // The next turn starts straight away, so the thread doesn't go idle in between.
    this.turn = { id: newId("turn"), interrupted: false, ...this.#sessionNow(), carried: carried + 1 };
    for (const m of left) this.updateItem(m.id, { turn_id: this.turn.id });
    this.emit({ type: "turn.started", turn_id: this.turn.id });
    this.setThread({ status: "running", error: undefined, usage });
    this.session?.carryOver(left.map((m) => toMessage(m.id, m)));
  }

  #undelivered(n: number): void {
    this.addItem({
      id: newId("n"),
      type: "notice",
      level: "warning",
      code: "undelivered",
      text: `${n === 1 ? "A message wasn't" : `${n} messages weren't`} delivered; ${n === 1 ? "it goes" : "they go"} with the next one you send.`,
    });
  }

  // ---------- requests ----------

  decide(query: PermissionQuery): PermissionDecision | Promise<PermissionDecision> {
    const standing = this.#always.get(permissionKey(query));
    if (standing) return standing;
    return decide(this.policy, query, { threadId: this.threadId, thread: this.thread, metadata: this.thread.metadata ?? {} });
  }

  ask(request: NewRequest, toolCallId: string | undefined, answered: (resolution: Resolution) => void, standing?: string): string {
    const r = { ...request, id: newId(request.type === "question" ? "q" : "perm") } as ThreadRequest;
    if (this.turn) r.turn_id = this.turn.id;
    const call = toolCallId ? this.item(toolCallId) : undefined;
    if (call) {
      r.tool_call_id = call.id;
      if (call.parent_id) r.parent_id = call.parent_id;
      this.updateItem(call.id, { status: "pending" });
    }
    this.#requests.set(r.id, { request: r, answered, ...(standing ? { standing } : {}) });
    this.emit({ type: "request.opened", request: r });
    this.setThread({ status: "waiting" });
    return r.id;
  }

  reopen(requestId: string, answered: (resolution: Resolution) => void, standing?: string): boolean {
    if (this.#requests.has(requestId)) return false;
    const request = this.#state.requests.find((r) => r.id === requestId);
    if (!request || request.resolution) return false;
    this.#requests.set(requestId, { request, answered, ...(standing ? { standing } : {}) });
    return true;
  }

  respond(requestId: string, resolution: Resolution): void {
    const open = this.#requests.get(requestId);
    if (!open) return;
    this.#requests.delete(requestId);
    // The answers to secret questions go only to the harness: what's sent and saved hides them.
    this.emit({ type: "request.resolved", request_id: requestId, resolution: redact(open.request, resolution) });
    if (!this.#requests.size && this.turn) this.setThread({ status: "running" });
    if (resolution.always && open.standing && (resolution.outcome === "allow" || resolution.outcome === "deny")) {
      this.#always.set(open.standing, resolution.outcome);
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

/** The notices a rewind and a new session add. */
const REWIND_TEXT = "The conversation was rewound to here: the agent doesn't remember what came after.";
const NEW_SESSION_TEXT = "A new conversation starts here: the agent doesn't remember what came before.";

/** What a secret answer is shown as. */
export const SECRET = "[secret]";

/** A resolution as it may be shown and saved: a secret question's answers replaced with SECRET. */
export function redact(request: ThreadRequest, resolution: Resolution): Resolution {
  if (request.type !== "question" || !resolution.answers) return resolution;
  const secret = new Set(request.questions.filter((q) => q.secret).map((q) => q.id));
  if (![...secret].some((id) => id in resolution.answers!)) return resolution;
  const answers: { [k: string]: string[] | undefined } = {};
  for (const [id, a] of Object.entries(resolution.answers)) answers[id] = secret.has(id) && a?.length ? [SECRET] : a;
  return { ...resolution, answers };
}

function toMessage(id: string, m: { text: string; attachments?: Attachment[] }): Message {
  return { id, text: m.text, ...(m.attachments?.length ? { attachments: m.attachments } : {}) };
}

function userFields(m: Outgoing): Omit<UserMessage, "id" | "type"> {
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

function findItem(items: Item[], id: string): Item | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.id === id) return items[i];
  return undefined;
}
