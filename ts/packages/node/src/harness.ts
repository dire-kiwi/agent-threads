// What a harness driver (Claude Code, Codex) and the core give each other. The core owns the
// thread: its events, turns, steering queue, requests and permission policy. A driver owns the
// harness process and translates between it and the core.

import type {
  Attachment,
  Item,
  PermissionRequest,
  QuestionRequest,
  Resolution,
  Thread,
  Usage,
  UserMessage,
} from "@dire-kiwi/agent-threads-protocol";
import type { PermissionDecision, PermissionQuery } from "./permissions.js";
import type { Spawner } from "./spawner.js";
import type { Tool } from "./tools.js";

/** An external MCP server: a command to run (stdio), or a URL (streamable HTTP, or SSE). */
export type McpServer =
  | { type?: "stdio"; command: string; args?: string[]; env?: { [k: string]: string } }
  | { type?: "http" | "sse"; url: string; headers?: { [k: string]: string } };

/** A skill: a directory with a SKILL.md (and anything it refers to), or a SKILL.md's text. */
export type Skill = string | { name: string; content: string };

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

/** A request to open, without the fields the core fills in. */
export type NewRequest = Omit<PermissionRequest, "id" | "turn_id" | "tool_call_id" | "parent_id"> | Omit<QuestionRequest, "id" | "turn_id" | "tool_call_id" | "parent_id">;

/** An item to add, without its turn (the core sets the running turn's). */
export type NewItem = Item extends infer I ? (I extends Item ? Omit<I, "turn_id"> : never) : never;

/** The core's side, for one thread. */
export interface ThreadContext {
  readonly threadId: string;
  readonly thread: Thread;
  readonly config: ThreadConfig;
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
  delta(itemId: string, kind: "text" | "reasoning", text: string): void;
  /** Changes the thread's fields (undefined removes one); sends nothing if nothing changes. */
  setThread(patch: Partial<Thread>): void;
  /** The harness took in the queued message with this id. Whether it was queued. */
  tookIn(id: string): boolean;

  /** The permission policy's answer, synchronously when it has one. */
  decide(query: PermissionQuery): PermissionDecision | Promise<PermissionDecision>;
  /**
   * Opens a request (for the tool call `toolCallId`, which is set `pending`) and calls `answered`
   * when the user responds. It isn't called when the request is cancelled because its turn ended.
   * `standing` (permissionKey of the tool) lets an answer given `always` stand for the thread.
   */
  ask(request: NewRequest, toolCallId: string | undefined, answered: (resolution: Resolution) => void, standing?: string): string;
  /** Closes a request the harness no longer wants answered. */
  cancelRequest(id: string): void;
  /** The running turn ended. */
  endTurn(end: TurnEnd): void;
  /** Something went wrong that isn't the turn's: for the app's onError. */
  error(error: unknown): void;
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
  /** The thread's options (model, effort, permission mode) or config changed. */
  optionsChanged(): void;
  /** Stop the harness process, if it's running. */
  close(): Promise<void>;
}

export interface Harness {
  readonly name: string;
  open(ctx: ThreadContext): HarnessSession;
}
