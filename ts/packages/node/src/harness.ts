// What a harness driver (Claude Code, Codex) and the core give each other. The core owns the
// thread: its events, turns, steering queue, requests and permission policy. A driver owns the
// harness process and translates between it and the core.

import type {
  Attachment,
  Item,
  PermissionRequest,
  PlanRequest,
  QuestionRequest,
  RateLimit,
  Resolution,
  Thread,
  Usage,
  UserMessage,
} from "@dire-kiwi/agent-threads-protocol";
import type { PermissionDecision, PermissionQuery } from "./permissions.js";
import type { Spawner } from "./spawner.js";
import type { RunRecord } from "./store.js";
import type { Tool } from "./tools.js";

/** An external MCP server: a command to run (stdio), or a URL (streamable HTTP, or SSE). */
export type McpServer =
  | { type?: "stdio"; command: string; args?: string[]; env?: { [k: string]: string } }
  | { type?: "http" | "sse"; url: string; headers?: { [k: string]: string } };

/** A skill: a directory with a SKILL.md (and anything it refers to), or a SKILL.md's text. */
export type Skill = string | { name: string; content: string };

/**
 * How a thread's harness process is started, on top of the harness's own options: stored with the
 * thread (but not sent to clients), so a run started after a restart has them too. A change
 * applies from the next process the thread starts, as a model change does.
 */
export interface LaunchOptions {
  /**
   * More arguments, after the harness's (and its options' `args`): for Claude Code, say,
   * `--allowedTools`, `--disallowedTools` or `--settings`; for Codex, `-c key=value`.
   */
  args?: string[];
  /** Changes to the environment, after the harness options' `env`: a value sets a variable, null removes it. */
  env?: { [k: string]: string | null };
  /**
   * More directories the agent may use besides the working directory: `--add-dir` for Claude
   * Code, writable roots (`sandbox_workspace_write.writable_roots`) for Codex.
   */
  addDirs?: string[];
  /**
   * The harness's config directory, in place of the harness options': CLAUDE_CONFIG_DIR for
   * Claude Code, CODEX_HOME for Codex (used as it is, with its own login and config). The harness
   * keeps its sessions there, so a thread that changes it can't resume what it had.
   */
  configDir?: string;
}

/** What a thread runs with: the instance's settings with the thread's own on top. */
export interface ThreadConfig {
  tools: Tool[];
  mcpServers: { [name: string]: McpServer };
  skills: Skill[];
  systemPrompt?: string;
}

/** A message to give the harness: its user_message item's id, text and attachments. */
export interface Message {
  id: string;
  text: string;
  attachments?: Attachment[];
}

/** How a turn ended, as the harness says. */
export interface TurnEnd {
  ok: boolean;
  error?: string;
  usage?: Usage;
  duration_ms?: number;
}

/** A line a thread's harness process wrote, for the app's onHarnessMessage. */
export interface HarnessMessage {
  threadId: string;
  /** The process that wrote it (the thread's `run.id` while it runs). */
  runId: string;
  harness: string;
  /** The line, without its newline. */
  line: string;
  /** The line parsed as JSON; absent if it isn't JSON. */
  message?: unknown;
}

/** A line parsed as JSON, or undefined if it isn't JSON. */
export function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Unix seconds as an RFC 3339 time, to the second: YYYY-MM-DDTHH:MM:SSZ. */
export function unixTime(seconds: number): string {
  return new Date(Math.floor(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A request to open, without the fields the core fills in. */
export type NewRequest =
  | Omit<PermissionRequest, "id" | "turn_id" | "tool_call_id" | "parent_id">
  | Omit<QuestionRequest, "id" | "turn_id" | "tool_call_id" | "parent_id">
  | Omit<PlanRequest, "id" | "turn_id" | "tool_call_id" | "parent_id">;

/** An item to add, without its turn (the core sets the running turn's). */
export type NewItem = Item extends infer I ? (I extends Item ? Omit<I, "turn_id"> : never) : never;

/** The core's side, for one thread. */
export interface ThreadContext {
  readonly threadId: string;
  readonly thread: Thread;
  readonly config: ThreadConfig;
  /**
   * How the thread's harness process is started: its args, environment, directories and config
   * directory (only the fields that are set).
   */
  readonly launch: LaunchOptions;
  readonly spawner: Spawner;
  /** The running turn's id, if one is running. */
  readonly turnId: string | undefined;
  /** Whether the running turn was interrupted. */
  readonly interrupted: boolean;
  /** Steered messages the harness hasn't taken in yet, oldest first. */
  queued(): UserMessage[];

  item(id: string): Item | undefined;
  /** Adds an item, in the running turn. */
  addItem(item: NewItem): void;
  /** Changes an item's fields (null removes one); sends nothing if nothing changes. */
  updateItem(id: string, patch: { [k: string]: unknown }): void;
  /** Streams text onto the end of an assistant_message or reasoning item's text; sends nothing for "". */
  delta(itemId: string, kind: "text" | "reasoning", text: string): void;
  /** Changes the thread's fields (undefined removes one); sends nothing if nothing changes. */
  setThread(patch: Partial<Thread>): void;
  /**
   * The harness reported usage limits: they replace the thread's `rate_limits` with the same ids
   * (sending a thread.updated if that changes them).
   */
  rateLimits(limits: RateLimit[]): void;
  /**
   * Handles a line the harness process `runId` wrote (`message` is it parsed, if it's JSON): runs
   * `handle`, which translates it, with the events it makes taking it as their `raw` (with the
   * raw option on), and then passes it to the app's onHarnessMessage.
   */
  fromHarness(runId: string, line: string, message: unknown, handle: () => void): void;
  /** The harness took in the queued message with this id. Whether it was queued. */
  tookIn(id: string): boolean;
  /**
   * An app tool returned structured output for the tool call `toolCallId`: it goes in the call's
   * `result.structured` when the harness gives the call its result (harnesses pass on only the text).
   */
  toolOutput(toolCallId: string, structured: unknown): void;

  /** The permission policy's answer, synchronously when it has one. */
  decide(query: PermissionQuery): PermissionDecision | Promise<PermissionDecision>;
  /**
   * Opens a request (for the tool call `toolCallId`, which is set `pending`) and calls `answered`
   * when the user responds. It isn't called when the request is cancelled because its turn ended.
   * `standing` (permissionKey of the tool) lets an answer given `always` stand for the thread.
   */
  ask(request: NewRequest, toolCallId: string | undefined, answered: (resolution: Resolution) => void, standing?: string): string;
  /**
   * Takes up a request opened before the backend restarted, which is still open: `answered` is
   * called when the user responds, as for ask(). Whether it's open.
   */
  reopen(requestId: string, answered: (resolution: Resolution) => void, standing?: string): boolean;
  /**
   * Saves the thread's run as it is now (with a spawner whose runs outlive the backend), before
   * the driver does something that mustn't be done twice: after a restart, it's re-attached as of
   * this. Resolves once it's saved; rejects if the store can't save it.
   */
  persist(): Promise<void>;
  /** Closes a request the harness no longer wants answered. */
  cancelRequest(id: string): void;
  /** The running turn ended. */
  endTurn(end: TurnEnd): void;
  /**
   * The harness started a turn by itself, with no message (Claude does, to tell the agent that a
   * background subagent has ended). Does nothing if a turn is running.
   */
  beginTurn(): void;
  /**
   * The subagents of these calls that are still running were stopped (their harness process
   * ended): their calls still running are cancelled, and their open requests too.
   */
  stopSubagents(ids: Iterable<string>): void;
  /** Something went wrong that isn't the turn's: for the app's onError. */
  error(error: unknown): void;
}

/** The calls of the subagents an item is inside, innermost first. */
export function* ancestors(item: (id: string) => Item | undefined, id: string): Generator<Item> {
  const seen = new Set<string>();
  for (let p = item(id)?.parent_id; p && !seen.has(p); p = item(p)?.parent_id) {
    seen.add(p);
    const it = item(p);
    if (it) yield it;
  }
}

/** Whether a tool_call is a background subagent's that's still running. */
export function runningInBackground(it: Item | undefined): boolean {
  return it?.type === "tool_call" && !!it.subagent?.background && it.subagent.status === "running";
}

/**
 * Whether an item is inside a background subagent that's still running: what it does carries on
 * after the turn it was started in has ended.
 */
export function inBackground(item: (id: string) => Item | undefined, id: string): boolean {
  for (const a of ancestors(item, id)) if (runningInBackground(a)) return true;
  return false;
}

/** What a driver needs saved to carry on with its run after the backend restarts. */
export interface RunCheckpoint {
  /** The run's id. */
  id: string;
  /** How far into its output the driver has read (HarnessProcess.offset). */
  offset: number;
  /** Where its files are (the shim's run directory). */
  dir?: string;
  /** How much of its input had been written (HarnessProcess.inputOffset). */
  input?: number;
  /** The driver's state for it, as JSON, which reattach() gets back. */
  state: unknown;
  /** It has exited, and the driver is done with it (its last checkpoint). */
  ended?: boolean;
}

/** A driver's side, for one thread. */
export interface HarnessSession {
  /** A turn started with these messages (the core has added them). */
  start(messages: Message[]): void;
  /** A message to steer the running turn with (the core has added it, queued). */
  steer(message: Message): void;
  /**
   * The turn ended without taking in these queued messages, and the core has started the next
   * turn for them.
   */
  carryOver(messages: Message[]): void;
  /** Stop the running turn. */
  interrupt(): void;
  /** Whether a harness process is running that has the queued messages (it was sent them). */
  live(): boolean;
  /**
   * The core gave up carrying the queued messages over: make sure nothing acts on them (stop a
   * process that has them). They're sent again with the next turn's start().
   */
  release(): void;
  /**
   * The thread's options (model, effort, permission mode) changed: they go to the running process
   * where the harness takes them, and otherwise apply from the next turn.
   */
  optionsChanged(): void;
  /** The thread's config (tools, MCP servers, skills, system prompt) or launch options changed: the next turn needs a new process. */
  configChanged(): void;
  /** Stop the harness process, if it's running. */
  close(): Promise<void>;
  /**
   * Sends the running process a request of the app's own (AgentThreads.control) and resolves with
   * its answer; rejects with a CommandError if there's no process to send it to, or a ControlError
   * if the harness refuses it or doesn't answer. A driver without it takes no requests.
   */
  control?(request: unknown): Promise<unknown>;

  // With a spawner whose processes outlive the backend (Spawner.durable). A driver that has none of
  // these has its runs stopped when the backend restarts, and their turns end.

  /**
   * The running process's checkpoint, which the core saves with the events made so far; undefined
   * if there's none. It's called whenever events are saved, so it must be quick.
   */
  checkpoint?(): RunCheckpoint | undefined;
  /**
   * Re-attaches to a run after a restart: `run.data.state` is a checkpoint() of it, and the core
   * has restored the thread (its running turn, its open requests) as of the same moment. Whether
   * it could; if not, the core stops the run.
   */
  reattach?(run: RunRecord): boolean;
  /**
   * Stops following the running process and leaves it running, as the backend shuts down, to
   * re-attach to it after. Whether there was one to leave; nothing else is called after this.
   */
  detach?(): boolean;
}

export interface Harness {
  readonly name: string;
  open(ctx: ThreadContext): HarnessSession;
}
