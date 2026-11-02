// The errors the backend's API throws, besides a store's.

/** A command that can't be carried out: an unknown thread, or a malformed command. */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

/**
 * A control request (AgentThreads.control) the harness refused, or didn't answer: its process
 * exited first, or the backend closed. `error` is the harness's own error, when it gave one
 * (Claude Code's error text, or Codex's JSON-RPC error object).
 */
export class ControlError extends Error {
  constructor(
    message: string,
    readonly error?: unknown,
  ) {
    super(message);
    this.name = "ControlError";
  }
}
