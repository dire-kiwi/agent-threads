import type { Story, StoryDefault } from "@ladle/react";
import type { PermissionRequest, PlanRequest, QuestionRequest } from "@dire-kiwi/agent-threads-protocol";
import { PermissionCard, PlanCard, QuestionCard } from "../components/Requests.js";
import { FixtureThread, snapshotOf } from "./fixtures.js";

export default { title: "Requests" } satisfies StoryDefault;

const opened = (fixture: string) => snapshotOf(fixture, (e) => e.type === "request.opened");

/** A permission request from a fixture: Allow, Always allow or Deny (with a note) go to the actions panel. */
export const Permission: Story<{ fixture: string }> = ({ fixture }) => {
  const snapshot = opened(fixture);
  return (
    <FixtureThread snapshot={snapshot}>
      <div className="at-root" style={{ maxWidth: "48rem" }}>
        <PermissionCard request={snapshot.requests[0] as PermissionRequest} />
      </div>
    </FixtureThread>
  );
};
Permission.argTypes = {
  fixture: { options: ["claude/permission-allow", "claude/permission-deny", "codex/permission-allow", "codex/permission-deny", "codex/mcp-tool"], control: { type: "select" }, defaultValue: "claude/permission-allow" },
};

/** A permission for a file edit, with its diff. */
export const PermissionForAnEdit: Story = () => {
  const snapshot = snapshotOf("codex/tool-calls");
  const edit = snapshot.items.find((i) => i.type === "tool_call" && i.kind === "edit")!;
  const request: PermissionRequest = { id: "p", type: "permission", name: "fileChange", kind: "edit", input: {}, tool_call_id: edit.id, reason: "The agent wants to change a file outside the sandbox." };
  return (
    <FixtureThread snapshot={{ ...snapshot, requests: [request] }}>
      <div className="at-root" style={{ maxWidth: "48rem" }}>
        <PermissionCard request={request} />
      </div>
    </FixtureThread>
  );
};

/** A plan from a fixture: approve it in a mode, or keep planning with feedback. */
export const Plan: Story<{ fixture: string }> = ({ fixture }) => {
  const snapshot = snapshotOf(fixture, (e) => e.type === "request.opened" && e.request.type === "plan");
  return (
    <FixtureThread snapshot={snapshot}>
      <div className="at-root" style={{ maxWidth: "48rem" }}>
        <PlanCard request={snapshot.requests[0] as PlanRequest} />
      </div>
    </FixtureThread>
  );
};
Plan.argTypes = { fixture: { options: ["claude/plan", "codex/plan"], control: { type: "radio" }, defaultValue: "claude/plan" } };

/** A question from a fixture: pick an option (or press 1–9), or write your own. */
export const Question: Story<{ fixture: string }> = ({ fixture }) => {
  const snapshot = opened(fixture);
  return (
    <FixtureThread snapshot={snapshot}>
      <div className="at-root" style={{ maxWidth: "48rem" }}>
        <QuestionCard request={snapshot.requests[0] as QuestionRequest} />
      </div>
    </FixtureThread>
  );
};
Question.argTypes = { fixture: { options: ["claude/ask-user-question", "codex/ask-user-question"], control: { type: "radio" }, defaultValue: "claude/ask-user-question" } };

/** Several questions: one choice, several choices with Other, free text, and a secret. */
export const SeveralQuestions: Story = () => {
  const snapshot = opened("claude/ask-user-question");
  const request: QuestionRequest = {
    ...(snapshot.requests[0] as QuestionRequest),
    questions: [
      { id: "db", header: "Database", question: "Which database should it use?", options: [{ label: "SQLite", description: "One file, no server" }, { label: "Postgres", description: "The team's usual" }] },
      { id: "features", header: "Features", question: "Which features go in the first release?", multi_select: true, allow_other: true, options: [{ label: "Search" }, { label: "Export" }, { label: "Sharing" }] },
      { id: "name", question: "What should the project be called?" },
      { id: "token", header: "Secret", question: "Paste the deploy token", secret: true },
    ],
  };
  return (
    <FixtureThread snapshot={{ ...snapshot, requests: [request] }}>
      <div className="at-root" style={{ maxWidth: "48rem" }}>
        <QuestionCard request={request} />
      </div>
    </FixtureThread>
  );
};
