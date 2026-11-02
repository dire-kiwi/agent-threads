// @dire-kiwi/agent-threads-protocol: the types of agent-threads' shared spec (spec/ in the
// repository), and the reducer that folds a thread's events into its state.

export type * from "./generated.js";
export { applyEvent, applyEvents, initialState, isGap, openRequests } from "./reducer.js";
export { itemPage, requestAnchor, snapshotWindow, withPage } from "./window.js";
export { validate, type SchemaName } from "./validate.js";
export { schema } from "./schema.js";
