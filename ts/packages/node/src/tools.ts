// The app's own tools, which the agent calls like any other and the backend runs in process.

/** A JSON Schema for a tool's arguments (an object schema). */
export type JsonSchema = { [k: string]: unknown };

export interface ToolContext {
  threadId: string;
  /** The thread's metadata, as the app gave it: e.g. which user the thread is for. */
  metadata: { [k: string]: unknown };
  /** The tool_call item this call is, when the harness says. */
  toolCallId?: string;
  /** Aborted when the thread's harness process goes away before the tool returns. */
  signal: AbortSignal;
}

/** What a tool returns: text for the agent, or that with structured output, or an error. */
export type ToolOutput = string | { text: string; isError?: boolean; structured?: unknown };

export interface Tool<Args = any> {
  name: string;
  description: string;
  /** Its arguments' JSON Schema. */
  input: JsonSchema;
  run(args: Args, ctx: ToolContext): ToolOutput | Promise<ToolOutput>;
}

/** A tool, typed: `defineTool<{ order_id: string }>({ name, description, input, run })`. */
export function defineTool<Args = any>(tool: Tool<Args>): Tool<Args> {
  return tool;
}

/** A tool's output in one shape; a tool that throws returns its error to the agent. */
export async function runTool(tool: Tool, args: unknown, ctx: ToolContext): Promise<{ text: string; isError: boolean; structured?: unknown }> {
  try {
    const out = await tool.run(args, ctx);
    if (typeof out === "string") return { text: out, isError: false };
    return { text: out.text, isError: !!out.isError, ...(out.structured !== undefined ? { structured: out.structured } : {}) };
  } catch (e) {
    return { text: e instanceof Error ? e.message : String(e), isError: true };
  }
}
