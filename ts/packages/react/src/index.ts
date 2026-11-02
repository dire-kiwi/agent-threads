// @dire-kiwi/agent-threads-react: React hooks and components for agent-threads. The app brings a
// thread's events (a ThreadSource on its own transport) and carries its commands (onCommand); this
// draws the thread. Import "@dire-kiwi/agent-threads-react/styles.css" for the components' styles.

export { applyEvent, applyEvents, initialState, isGap, openRequests, withPage } from "@dire-kiwi/agent-threads-protocol";
// The protocol's types. Those that share a component's name are here as ...Item (and Thread as
// ThreadInfo); the components' names win.
export type * from "@dire-kiwi/agent-threads-protocol";
export type {
  AssistantMessage as AssistantMessageItem,
  Notice as NoticeItem,
  Reasoning as ReasoningItem,
  Thread as ThreadInfo,
  ToolCall as ToolCallItem,
  TurnResult as TurnResultItem,
  UserMessage as UserMessageItem,
} from "@dire-kiwi/agent-threads-protocol";

// Headless
export { isLoaded, ThreadStore, type LoadEarlierOptions, type ThreadSource, type ThreadState } from "./store.js";
export { buildView, groupRows, lineage, rowKey, type RequestRow, type Row, type SubagentInfo, type SubagentStatus, type ThreadView, type ToolGroup as ToolGroupRow } from "./view.js";
export {
  ThreadProvider,
  useCommand,
  useHasEarlier,
  useInterrupt,
  useLoadEarlier,
  useRespond,
  useReveal,
  useSend,
  useSetOptions,
  useThread,
  useThreadConfig,
  useThreadState,
  useThreadStore,
  type CommandHandler,
  type SendOptions,
  type ThreadOptions,
  type ThreadProviderProps,
} from "./hooks.js";
export type { ThreadConfig, ToolBodyProps, ToolMeta, ToolRenderer, ToolRowProps } from "./config.js";
export { brief, planTitle, relative, toolMeta } from "./toolMeta.js";

// Components
export { Thread, ThreadStatusLine, type ThreadProps } from "./components/Thread.js";
export { AssistantMessage, ItemView, MessageList, MessageRow, Reasoning, UserMessage } from "./components/MessageList.js";
export { StreamingText } from "./components/StreamingText.js";
export { builtinToolRenderers, EditDiff, PatchDiff, ToolCall, ToolGroup, ToolResultView, ToolStatus, toolRenderer } from "./components/ToolCall.js";
export { reportText, Subagent, SubagentStatusBadge, subagentKind, subagentTitle } from "./components/Subagent.js";
export { OpenRequests, PermissionCard, PlanCard, QuestionCard, RequestCard } from "./components/Requests.js";
export { LoadEarlier } from "./components/LoadEarlier.js";
export { CompactionLine, Notice, TurnResult, usageText } from "./components/Lines.js";
export { afterSent, Composer, type ComposerProps } from "./components/Composer.js";
export { AgentsPill } from "./components/AgentsPill.js";
export { Button, CodeBlock, Collapsible, cx, Markdown } from "./components/ui.js";
