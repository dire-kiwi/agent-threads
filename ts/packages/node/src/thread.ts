// One thread, live: its state (folded from its events with applyEvent), the running turn, the
// steering queue and open requests. Every change is an event, numbered, applied, sent to the
// subscribers, and saved to the store in order (deltas aren't saved).

import {
  applyEvent,
  type Attachment,
  type Item,
  type QuestionRequest,
  type RateLimit,
  type Resolution,
  type Snapshot,
  type Thread,
  type ThreadEvent,
  type ThreadRequest,
  type Usage,
  type UserMessage,
} from "@dire-kiwi/agent-threads-protocol";
import { ancestors, inBackground, type HarnessMessage, type HarnessSession, type LaunchOptions, type Message, type NewItem, type NewRequest, type ThreadConfig, type ThreadContext, type TurnEnd } from "./harness.js";
import { newId } from "./ids.js";
import { normalLaunch, sameLaunch, storedThread, type StoredThread } from "./launch.js";
import { DONT_ASK_DENIAL, decide, modeDecision, permissionKey, standsFor, type PermissionDecision, type PermissionPolicy, type PermissionQuery, type StandingKey } from "./permissions.js";
import type { Spawner } from "./spawner.js";
import { StoreError, type RunRecord, type Store } from "./store.js";

/** An event before it's numbered: what emit() takes. */
type Unnumbered = ThreadEvent extends infer E ? (E extends ThreadEvent ? Omit<E, "seq" | "thread_id"> : never) : never;

export interface Turn {
  id: string;
  interrupted: boolean;
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
  standing?: StandingKey;
  /**
   * A question kept open after its turn ended (lateAnswers): its answer is sent as the next
   * message, unless the user sends one first.
   */
  late?: boolean;
  /**
   * How many messages the user had sent when it was opened: one sent since means the conversation
   * has moved on, and it isn't kept open after its turn.
   */
  users: number;
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
  /** AgentThreadsOptions.lateAnswers. */
  lateAnswers?: boolean;
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
    // The conversation moves on: questions kept open after their turns can't be answered.
    this.#cancelLate();
    if (!this.turn) {
      // Messages still queued from before weren't delivered: they go first, in this turn, and stay
      // queued until the harness takes them in. Such a turn is a retry for them.
      const left = this.queued();
      this.turn = { id: newId("turn"), interrupted: false, ...(left.length ? { carried: 1 } : {}) };
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
    // What a background subagent that's still running does carries on after the turn: its text
    // still streaming, its calls (and their structured output, still to go with their results)
    // and its requests.
    const lookup = (id: string) => this.item(id);
    // Text streamed but never finished (its process went first) is kept as it was shown.
    this.#finishText((id) => !inBackground(lookup, id));
    for (const id of [...this.#structured.keys()]) if (!inBackground(lookup, id)) this.#structured.delete(id);
    for (const it of this.#state.items) {
      if (it.type === "tool_call" && it.turn_id === turn.id && (it.status === "running" || it.status === "pending") && !inBackground(lookup, it.id)) {
        // A subagent cut short (by an interrupt, or its process ending) is stopped with its call.
        this.updateItem(it.id, { status: "cancelled", ...(it.subagent?.status === "running" ? { subagent: { ...it.subagent, status: "stopped" } } : {}) });
      }
    }
    // Questions are kept open after the turn (some may be already: see cancelRequest()), unless
    // messages are left queued, which a turn carries over or the next message sends: the
    // conversation has moved on.
    for (const [id, r] of this.#requests) {
      // A background subagent's requests stay open, for it.
      const keep = r.late
        ? !this.#queue.length
        : (r.request.turn_id !== undefined && r.request.turn_id !== turn.id) || (r.request.tool_call_id !== undefined && inBackground(lookup, r.request.tool_call_id));
      if (keep) continue;
      this.#requests.delete(id);
      if (r.late || !this.#keepLate(r.request, r.users)) this.emit({ type: "request.resolved", request_id: id, resolution: { outcome: "cancel" } });
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
      this.setThread({ status: error ? "error" : this.#waiting() ? "waiting" : "idle", error, usage });
      if (left.length && carry && !this.closing) this.session?.release();
      if (left.length && !this.closing) this.#undelivered(left.length);
      void this.saveSnapshot();
      return;
    }
    // The next turn starts straight away, so the thread doesn't go idle in between.
    this.turn = { id: newId("turn"), interrupted: false, carried: carried + 1 };
    for (const m of left) this.updateItem(m.id, { turn_id: this.turn.id });
    this.emit({ type: "turn.started", turn_id: this.turn.id });
    this.setThread({ status: "running", error: undefined, usage });
    this.session?.carryOver(left.map((m) => toMessage(m.id, m)));
  }

  /** Keeps text streamed into the items `which` picks, but never finished, as it was shown. */
  #finishText(which: (id: string) => boolean): void {
    for (const it of this.#state.items) {
      if ((it.type !== "assistant_message" && it.type !== "reasoning") || !which(it.id)) continue;
      const saved = this.item(it.id);
      if (saved && "text" in saved && saved.text !== it.text) this.updateItem(it.id, { text: it.text });
    }
    for (const id of [...this.#streaming]) if (which(id)) this.#streaming.delete(id);
  }

  beginTurn(): void {
    if (this.turn || this.closed || this.closing) return;
    this.turn = { id: newId("turn"), interrupted: false };
    this.emit({ type: "turn.started", turn_id: this.turn.id });
    this.setThread({ status: "running", error: undefined });
  }

  stopSubagents(ids: Iterable<string>): void {
    const stopped = new Set<string>();
    for (const id of ids) {
      const it = this.item(id);
      if (it?.type !== "tool_call" || it.subagent?.status !== "running") continue;
      stopped.add(id);
      this.updateItem(id, { subagent: { ...it.subagent, status: "stopped" } });
    }
    if (!stopped.size) return;
    const lookup = (id: string) => this.item(id);
    const within = (id: string) => [...ancestors(lookup, id)].some((a) => stopped.has(a.id));
    this.#finishText(within);
    for (const id of [...this.#structured.keys()]) if (within(id)) this.#structured.delete(id);
    for (const it of this.#state.items) {
      if (it.type === "tool_call" && (it.status === "running" || it.status === "pending") && within(it.id)) this.updateItem(it.id, { status: "cancelled" });
    }
    for (const [id, r] of this.#requests) {
      if (!r.request.tool_call_id || !within(r.request.tool_call_id)) continue;
      this.#requests.delete(id);
      this.emit({ type: "request.resolved", request_id: id, resolution: { outcome: "cancel" } });
    }
    if (!this.#waiting() && !this.turn && this.#state.thread.status === "waiting") this.setThread({ status: "idle" });
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

  /**
   * The thread's standing answers come first, then the policy; what the policy would ask the user
   * about, the thread's permission mode may decide instead (bypass allows it, dont_ask denies it).
   */
  decide(query: PermissionQuery): PermissionDecision | Promise<PermissionDecision> {
    const standing = this.#standing(permissionKey(query));
    if (standing) return standing.outcome === "allow" ? "allow" : { deny: standing.message! };
    const mode = this.thread.permission_mode;
    const d = decide(this.policy, query, { threadId: this.threadId, thread: this.thread, metadata: this.thread.metadata ?? {} });
    // (An async policy's ask is decided by the mode as it is when the request would be opened: see
    // ask().)
    return d instanceof Promise ? d : modeDecision(mode, d);
  }

  /** The thread's standing answer for a tool, if it has one. */
  #standing(key: StandingKey): Resolution | undefined {
    const a = (this.thread.standing_answers ?? []).findLast((a) => standsFor(a, key));
    if (!a) return undefined;
    return a.outcome === "allow" ? { outcome: "allow" } : { outcome: "deny", message: STANDING_DENIAL };
  }

  /**
   * How a request is answered without asking the user, if it is: a permission request by the
   * thread's standing answer for its tool, or else by its permission mode (bypass allows it,
   * dont_ask denies it); a question by dont_ask, which dismisses it.
   */
  #settled(question: boolean, standing: StandingKey | undefined): Resolution | undefined {
    if (!question && standing) {
      const r = this.#standing(standing);
      if (r) return r;
    }
    const mode = this.thread.permission_mode;
    if (mode === "bypass" && !question) return { outcome: "allow" };
    if (mode === "dont_ask") return { outcome: question ? "cancel" : "deny", message: DONT_ASK_DENIAL };
    return undefined;
  }

  ask(request: NewRequest, toolCallId: string | undefined, answered: (resolution: Resolution) => void, standing?: StandingKey): string {
    const question = request.type === "question";
    const settled = this.#settled(question, standing);
    if (settled) {
      queueMicrotask(() => answered(settled));
      return newId(question ? "q" : "perm");
    }
    const r = { ...request, id: newId(question ? "q" : "perm") } as ThreadRequest;
    if (!question && standing?.server) (r as { server?: string }).server = standing.server;
    if (this.turn) r.turn_id = this.turn.id;
    const call = toolCallId ? this.item(toolCallId) : undefined;
    if (call) {
      r.tool_call_id = call.id;
      if (call.parent_id) r.parent_id = call.parent_id;
      this.updateItem(call.id, { status: "pending" });
    }
    this.#requests.set(r.id, { request: r, answered, users: this.#userMessages(), ...(standing ? { standing } : {}) });
    this.emit({ type: "request.opened", request: r });
    this.setThread({ status: "waiting" });
    return r.id;
  }

  reopen(requestId: string, answered: (resolution: Resolution) => void, standing?: StandingKey): boolean {
    if (this.#requests.has(requestId)) return false;
    const request = this.#state.requests.find((r) => r.id === requestId);
    if (!request || request.resolution) return false;
    this.#requests.set(requestId, { request, answered, users: this.#userMessages(), ...(standing ? { standing } : {}) });
    return true;
  }

  respond(requestId: string, resolution: Resolution): void {
    const open = this.#requests.get(requestId);
    if (!open) return;
    this.#requests.delete(requestId);
    // The answers to secret questions go only to the harness: what's sent and saved hides them.
    this.emit({ type: "request.resolved", request_id: requestId, resolution: redact(open.request, resolution) });
    // A background subagent's request can be answered when no turn is running.
    if (!this.#waiting() && (this.turn || this.#state.thread.status === "waiting")) this.setThread({ status: this.turn ? "running" : "idle" });
    const key = open.standing;
    const always = resolution.always && key && (resolution.outcome === "allow" || resolution.outcome === "deny");
    if (always) {
      const answers = (this.thread.standing_answers ?? []).filter((a) => !standsFor(a, key));
      this.setThread({ standing_answers: [...answers, { ...key, outcome: resolution.outcome as "allow" | "deny" }] });
    }
    open.answered(resolution);
    // It stands for the requests open for the same tool too.
    if (always) this.settle();
  }

  /**
   * Answers the open requests the thread's standing answers or permission mode now answer (see
   * #settled), after either changed: questions kept open after their turns included, which
   * dont_ask dismisses (and which then send nothing).
   */
  settle(): void {
    for (const [id, open] of [...this.#requests]) {
      if (!this.#requests.has(id)) continue;
      const r = this.#settled(open.request.type === "question", open.standing);
      if (r) this.respond(id, r);
    }
  }

  cancelRequest(id: string): void {
    const open = this.#requests.get(id);
    if (!open || open.late) return;
    this.#requests.delete(id);
    if (!(this.interrupted && this.#keepLate(open.request, open.users))) {
      this.emit({ type: "request.resolved", request_id: id, resolution: { outcome: "cancel" } });
    }
    if (!this.#waiting() && (this.turn || this.#state.thread.status === "waiting")) this.setThread({ status: this.turn ? "running" : "idle" });
  }

  /** Whether the turn waits on a request (one that isn't kept open after its turn). */
  #waiting(): boolean {
    for (const r of this.#requests.values()) if (!r.late) return true;
    return false;
  }

  /** The open requests, but for questions kept open after their turns. */
  get openRequests(): ThreadRequest[] {
    return [...this.#requests.values()].filter((r) => !r.late).map((r) => r.request);
  }

  /**
   * Keeps a question open after its turn ended, with lateAnswers, if it can be: not a secret one
   * (its answer would be shown, as a message), not under dont_ask (which dismisses questions), and
   * not when the conversation has moved on (see #movedOn). Whether it did.
   */
  #keepLate(request: ThreadRequest, users?: number): boolean {
    if (request.type !== "question" || !this.#host.lateAnswers || request.questions.some((q) => q.secret)) return false;
    if (this.#movedOn(request, users) || this.thread.permission_mode === "dont_ask") return false;
    this.#requests.set(request.id, {
      request,
      late: true,
      users: this.#userMessages(),
      answered: (r) => {
        // A dismissal sends nothing.
        if (r.outcome === "answer") this.send({ text: lateAnswerText(request, r) });
      },
    });
    return true;
  }

  /**
   * Whether the conversation has moved on since a request was asked: messages are queued, or the
   * user sent one since. That's a user message after its tool call in the items, as saved (so it's
   * known after a restart too); or, for a request with no call, more of them than `users` (how many
   * there were when it was asked, if that's known).
   */
  #movedOn(request: ThreadRequest, users?: number): boolean {
    if (this.#queue.length > 0) return true;
    const items = this.#state.items;
    const at = request.tool_call_id === undefined ? -1 : items.findIndex((i) => i.id === request.tool_call_id);
    if (at >= 0) return items.slice(at + 1).some((i) => i.type === "user_message");
    return users !== undefined && this.#userMessages() > users;
  }

  /** How many messages the user has sent. */
  #userMessages(): number {
    return this.#state.items.filter((i) => i.type === "user_message").length;
  }

  /** Cancels the questions kept open after their turns. */
  #cancelLate(): void {
    for (const [id, r] of this.#requests) {
      if (!r.late) continue;
      this.#requests.delete(id);
      this.emit({ type: "request.resolved", request_id: id, resolution: { outcome: "cancel" } });
    }
  }

  /**
   * Takes up, as a thread is loaded, the requests open in its state that its session didn't take up
   * again (after it re-attached to its run, if it did), which nothing will answer. A question whose
   * turn is over (it has a result, or it's the turn running and was interrupted, so the harness gave
   * the question up), or any with `all` (the turn was lost), is kept open as endTurn() and
   * cancelRequest() keep it, if it can be; the others are cancelled.
   */
  takeUpRequests(all: boolean): void {
    const ended = new Set(this.#state.items.flatMap((i) => (i.type === "turn_result" && i.turn_id !== undefined ? [i.turn_id] : [])));
    const interrupted = this.turn?.interrupted ? this.turn.id : undefined;
    for (const r of [...this.#state.requests]) {
      // One that's been resolved stays in the state, with its resolution.
      if (r.resolution || this.#requests.has(r.id)) continue;
      const over = all || (r.turn_id !== undefined && (ended.has(r.turn_id) || r.turn_id === interrupted));
      if (!(over && this.#keepLate(r))) this.emit({ type: "request.resolved", request_id: r.id, resolution: { outcome: "cancel" } });
    }
  }

  error(error: unknown): void {
    this.#host.error(error);
  }
}

/** What the agent is told when a standing answer denies a call. */
const STANDING_DENIAL = "The user has denied this tool for the rest of the thread.";

/** The message a late answer is sent as: each question, with its answers (and the note with them). */
export function lateAnswerText(q: QuestionRequest, r: Resolution): string {
  const lines = q.questions.map((question) => {
    const answers = r.answers?.[question.id] ?? [];
    return `- ${question.question}\n  ${answers.length ? answers.join(", ") : "(no answer)"}`;
  });
  const what = lines.length === 1 ? "answer to the question" : "answers to the questions";
  let text = `My ${what} you asked:\n\n${lines.join("\n")}`;
  if (r.message) text += `\n\n${r.message}`;
  return text;
}

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
