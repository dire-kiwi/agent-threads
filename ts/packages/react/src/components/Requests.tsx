// The thread's open requests, as cards: a permission to allow or deny, questions to answer, and a
// plan to approve or send back.
// A request goes once it's resolved (request.resolved), and its card with it.

import type { PermissionMode, PermissionRequest, PlanRequest, Question, QuestionRequest, ThreadRequest, ToolCall } from "@dire-kiwi/agent-threads-protocol";
import { memo, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useRespond, useReveal, useThreadConfig, useThreadState } from "../hooks.js";
import type { ThreadState } from "../store.js";
import { BotIcon, CheckIcon, MapIcon, QuestionIcon, SendIcon, ShieldIcon, XIcon } from "../icons.js";
import { subagentTitle } from "./Subagent.js";
import { planTitle, toolMeta } from "../toolMeta.js";
import { permissionBody, toolRenderer } from "./ToolCall.js";
import { Button, cx, Markdown } from "./ui.js";

const NO_REQUESTS: readonly ThreadRequest[] = [];

/** The thread's open requests, oldest first: all of them, or those from one subagent (`parentId`, "" for the main thread's own). */
export const OpenRequests = memo(function OpenRequests({ parentId, className }: { parentId?: string; className?: string }) {
  const requests = useThreadState((s) => s.snapshot.requests ?? NO_REQUESTS);
  const shown = parentId === undefined ? requests : requests.filter((r) => (r.parent_id ?? "") === parentId);
  if (!shown.length) return null;
  return (
    <div className={cx("at-requests", className)}>
      {shown.map((r) =>
        r.type === "permission" ? <PermissionCard key={r.id} request={r} /> : r.type === "plan" ? <PlanCard key={r.id} request={r} /> : <QuestionCard key={r.id} request={r} />,
      )}
    </div>
  );
});

/** Who's asking: "Claude", "Codex", or the harness's own name. */
const asker = (harness: string) => (harness === "claude" ? "Claude" : harness === "codex" ? "Codex" : harness);

/** The thread's item `id`, if it's a tool call. */
function findCall(s: ThreadState, id: string): ToolCall | undefined {
  const items = s.snapshot.items;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.id === id) return item.type === "tool_call" ? item : undefined;
  }
  return undefined;
}

/** For a request from a subagent: which one (it reveals the subagent's row). */
function From({ parentId }: { parentId?: string }) {
  const sub = useThreadState((s) => (parentId ? s.view.subagents.get(parentId) : undefined));
  const reveal = useReveal();
  if (!sub) return null;
  return (
    <button type="button" className="at-request-from" title="Show the subagent" onClick={() => reveal(sub.id)}>
      <BotIcon size={12} /> from {subagentTitle(sub.call)}
    </button>
  );
}

/**
 * Runs a command, noting while it's under way (when onCommand returns a promise) and why it failed.
 * The card goes once its request resolves; answering one that's already answered does nothing.
 */
function useSending() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const run = (send: () => void | Promise<unknown>) => {
    setError(null);
    try {
      const p = send();
      if (!p || typeof p.then !== "function") return;
      setBusy(true);
      p.then(
        () => setBusy(false),
        (e: unknown) => {
          setBusy(false);
          fail(e);
        },
      );
    } catch (e) {
      fail(e);
    }
  };
  return { busy, error, run };
}

// ---------- permissions ----------

/** A tool call the agent wants to make: allow it (once, or always for this tool) or deny it, with a note for the agent. */
export const PermissionCard = memo(function PermissionCard({ request, className }: { request: PermissionRequest; className?: string }) {
  const respond = useRespond();
  const config = useThreadConfig();
  const harness = useThreadState((s) => s.snapshot.thread.harness);
  const cwd = useThreadState((s) => s.snapshot.thread.cwd);
  const found = useThreadState((s) => (request.tool_call_id ? findCall(s, request.tool_call_id) : undefined));
  const call: ToolCall = found ?? { id: request.id, type: "tool_call", name: request.name, kind: request.kind, input: request.input, status: "pending", title: request.title };
  const renderer = toolRenderer(config, call);
  const meta = { ...toolMeta(call, cwd), ...renderer.meta?.(call, cwd) };
  const Body = permissionBody(renderer);
  const { busy, error, run } = useSending();
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const decide = (outcome: "allow" | "deny", always = false) =>
    run(() => respond(request.id, { outcome, ...(always ? { always } : {}), ...(outcome === "deny" && note.trim() ? { message: note.trim() } : {}) }));
  return (
    <div className={cx("at-card", "at-permission", className)} role="group" aria-label={`Permission for ${request.name}`}>
      <div className="at-card-head">
        <ShieldIcon size={15} className="at-attention" />
        <span>
          {asker(harness)} wants to use <span className="at-mono">{request.name}</span>
        </span>
        <From parentId={request.parent_id} />
      </div>
      {/* What it's for, whatever the body shows: the call's target (its label is for a call that's run), and the harness's summary. */}
      {meta.summary && (
        <div className="at-permission-target">
          <span className="at-tool-icon">{meta.icon}</span>
          <span className="at-permission-summary">{meta.summary}</span>
        </div>
      )}
      {request.title && request.title !== meta.summary && <div className="at-permission-title">{request.title}</div>}
      {request.reason && <div className="at-card-reason">{request.reason}</div>}
      <Body call={call} />
      {noting && (
        <input
          className="at-input"
          aria-label="A note for the agent"
          placeholder="Tell the agent why (optional)"
          value={note}
          disabled={busy}
          autoFocus
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              decide("deny");
            }
          }}
        />
      )}
      <div className="at-card-actions">
        <Button variant="primary" disabled={busy} onClick={() => decide("allow")}>
          <CheckIcon size={13} /> Allow
        </Button>
        <Button disabled={busy} onClick={() => decide("allow", true)}>
          Always allow {request.name} in this thread
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => decide("deny")}>
          Deny
        </Button>
        {!noting && (
          <button type="button" className="at-link" disabled={busy} onClick={() => setNoting(true)}>
            Deny with a note
          </button>
        )}
        {error && <span className="at-error">{error}</span>}
      </div>
    </div>
  );
});

// ---------- plans ----------

/** The modes a plan can be approved into. */
const AFTER_PLAN: { mode: PermissionMode; label: string }[] = [
  { mode: "default", label: "asking as usual" },
  { mode: "accept_edits", label: "accepting edits" },
  { mode: "bypass", label: "asking nothing" },
];

/**
 * The agent's plan: approve it, and the agent starts on it in the mode picked (the thread's own, or
 * the default if that's plan); or keep planning, with feedback for the agent.
 */
export const PlanCard = memo(function PlanCard({ request, className }: { request: PlanRequest; className?: string }) {
  const respond = useRespond();
  const harness = useThreadState((s) => s.snapshot.thread.harness);
  const current = useThreadState((s) => s.snapshot.thread.permission_mode);
  const [mode, setMode] = useState<PermissionMode>(current && current !== "plan" ? current : "default");
  // The feedback being written, once the user's chosen to keep planning.
  const [feedback, setFeedback] = useState<string | null>(null);
  const { busy, error, run } = useSending();
  const approve = () => run(() => respond(request.id, { outcome: "allow", permission_mode: mode }));
  const keepPlanning = () => run(() => respond(request.id, { outcome: "deny", ...(feedback?.trim() ? { message: feedback.trim() } : {}) }));
  const title = planTitle(request.plan);
  return (
    <div className={cx("at-card", "at-plan-card", className)} role="group" aria-label={`Plan from ${asker(harness)}`}>
      <div className="at-card-head">
        <MapIcon size={15} className="at-attention" />
        <span>
          {asker(harness)} has a plan{title && <span className="at-plan-title">: {title}</span>}
        </span>
        <From parentId={request.parent_id} />
      </div>
      <div className="at-plan-scroll">{request.plan ? <Markdown text={request.plan} className="at-plan" /> : <span className="at-faint">(The plan is empty.)</span>}</div>
      {feedback === null ? (
        <div className="at-card-actions">
          <Button variant="primary" disabled={busy} onClick={approve}>
            <CheckIcon size={13} /> Approve
          </Button>
          <label className="at-plan-mode">
            and carry on
            <select className="at-select" value={mode} disabled={busy} aria-label="The mode to carry on in" onChange={(e) => setMode(e.target.value as PermissionMode)}>
              {AFTER_PLAN.map((m) => (
                <option key={m.mode} value={m.mode}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <Button disabled={busy} onClick={() => setFeedback("")}>
            Keep planning
          </Button>
          {error && <span className="at-error">{error}</span>}
        </div>
      ) : (
        <>
          <textarea
            className="at-input at-textarea"
            aria-label="Feedback on the plan"
            placeholder="What should the plan do differently? (optional)"
            value={feedback}
            disabled={busy}
            autoFocus
            rows={3}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                keepPlanning();
              }
            }}
          />
          <div className="at-card-actions">
            <Button variant="primary" disabled={busy} onClick={keepPlanning}>
              <SendIcon size={13} /> Keep planning
            </Button>
            <Button disabled={busy} onClick={() => setFeedback(null)}>
              Back
            </Button>
            {error && <span className="at-error">{error}</span>}
          </div>
        </>
      )}
    </div>
  );
});

// ---------- questions ----------

type Draft = { picked: string[]; other: string };
const NO_DRAFT: Draft = { picked: [], other: "" };

/** Whether a question takes a typed answer: one with no options, or that allows another. */
const takesOther = (q: Question) => !q.options?.length || !!q.allow_other;

/** A question's answer from its draft: a typed answer goes with the options ticked, or in place of the one picked. */
function answerOf(q: Question, d: Draft): string[] {
  const typed = d.other.trim() ? [d.other.trim()] : [];
  return q.multi_select ? [...d.picked, ...typed] : typed.length ? typed : d.picked;
}

/**
 * The agent's questions, each with its options to pick from (one, or several with multi_select),
 * and a typed answer where it takes one. Keys 1–9 pick in the question that's current; picking the
 * one answer of a question moves on to the next, and answers a lone question outright.
 */
export const QuestionCard = memo(function QuestionCard({ request, className }: { request: QuestionRequest; className?: string }) {
  const respond = useRespond();
  const harness = useThreadState((s) => s.snapshot.thread.harness);
  const questions = request.questions;
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => NO_DRAFT));
  const [current, setCurrent] = useState(0);
  const { busy, error, run } = useSending();
  const ref = useRef<HTMLDivElement>(null);
  const answers = questions.map((q, i) => answerOf(q, drafts[i] ?? NO_DRAFT));
  const complete = answers.every((a) => a.length > 0);
  const submit = (list = answers) =>
    run(() => respond(request.id, { outcome: "answer", answers: Object.fromEntries(questions.map((q, i) => [q.id, list[i] ?? []])) }));
  const dismiss = () => run(() => respond(request.id, { outcome: "cancel" }));
  const set = (i: number, d: Partial<Draft>) => setDrafts((all) => all.map((x, j) => (j === i ? { ...x, ...d } : x)));
  const pick = (i: number, label: string) => {
    const q = questions[i];
    if (!q || busy) return;
    const d = drafts[i] ?? NO_DRAFT;
    if (q.multi_select) return set(i, { picked: d.picked.includes(label) ? d.picked.filter((x) => x !== label) : [...d.picked, label] });
    const next = drafts.map((x, j) => (j === i ? { picked: [label], other: "" } : x));
    setDrafts(next);
    if (questions.length === 1) return submit([[label]]);
    // On to the next question that isn't answered yet.
    const after = questions.findIndex((qq, j) => j > i && !answerOf(qq, next[j] ?? NO_DRAFT).length);
    setCurrent(after >= 0 ? after : i);
  };
  useDigitKeys(!busy, ref, (n) => {
    const o = questions[current]?.options?.[n - 1];
    if (o) pick(current, o.label);
  });
  const who = asker(harness);
  return (
    <div ref={ref} className={cx("at-card", "at-question", className)} role="group" aria-label={`Questions from ${who}`}>
      <div className="at-card-head">
        <QuestionIcon size={15} className="at-attention" />
        <span>
          {who} {questions.length === 1 ? "asks" : `asks ${questions.length} questions`}
        </span>
        <From parentId={request.parent_id} />
      </div>
      <div className="at-questions">
        {questions.map((q, i) => {
          const d = drafts[i] ?? NO_DRAFT;
          const options = q.options ?? [];
          const multi = !!q.multi_select;
          const picked = multi ? d.picked : d.other.trim() ? [] : d.picked;
          const active = i === current && questions.length > 1;
          return (
            <div
              key={q.id}
              className={cx("at-q", questions.length > 1 && "at-q-many", active && "at-q-current")}
              onFocusCapture={() => setCurrent(i)}
              onMouseDown={() => setCurrent(i)}
            >
              <div className="at-q-title">
                {q.header && <span className="at-q-header">{q.header}</span>}
                <span className="at-q-text">{q.question}</span>
                {multi && <span className="at-faint at-small">pick any</span>}
              </div>
              {options.length > 0 && (
                <div className="at-choices" role={multi ? "group" : "radiogroup"} aria-label={q.question}>
                  {options.map((o, j) => (
                    <Choice
                      key={o.label}
                      label={o.label}
                      description={o.description}
                      n={j + 1}
                      multi={multi}
                      picked={picked.includes(o.label)}
                      keys={i === current || questions.length === 1}
                      disabled={busy}
                      onPick={() => pick(i, o.label)}
                    />
                  ))}
                </div>
              )}
              {takesOther(q) && (
                <input
                  type={q.secret ? "password" : "text"}
                  className={cx("at-input", d.other.trim() && "at-input-filled")}
                  aria-label={`Your own answer to: ${q.question}`}
                  value={d.other}
                  disabled={busy}
                  autoComplete={q.secret ? "off" : undefined}
                  placeholder={options.length ? (multi ? "Something else too (optional)" : "Other: your own answer") : "Your answer"}
                  onChange={(e) => set(i, { other: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      if (complete) submit();
                    }
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="at-card-actions">
        <Button variant="primary" disabled={busy || !complete} onClick={() => submit()}>
          <SendIcon size={13} /> {questions.length === 1 ? "Answer" : "Submit answers"}
        </Button>
        <Button disabled={busy} onClick={dismiss} title="Tell the agent you won't answer">
          <XIcon size={13} /> Dismiss
        </Button>
        {questions[current]?.options?.length ? <span className="at-faint at-small">Keys 1–9 pick an answer.</span> : null}
        {error && <span className="at-error">{error}</span>}
      </div>
    </div>
  );
});

/** One of a question's options: a numbered row (its number is its key), ticked when it's picked. */
function Choice({ label, description, n, picked, multi, onPick, disabled, keys }: {
  label: string;
  description?: string;
  n: number;
  picked: boolean;
  multi: boolean;
  onPick: () => void;
  disabled?: boolean;
  keys: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={picked}
      disabled={disabled}
      onClick={onPick}
      className={cx("at-choice", picked && "at-choice-picked")}
    >
      <span className={cx("at-choice-mark", multi ? "at-choice-box" : "at-choice-dot")} aria-hidden>
        {picked ? <CheckIcon size={11} /> : keys && n <= 9 ? n : ""}
      </span>
      <span className="at-choice-text">
        <span className="at-choice-label">{label}</span>
        {description && description !== label && <span className="at-choice-description">{description}</span>}
      </span>
    </button>
  );
}

// ---------- keys 1–9 ----------

/** The question cards on the page that take keys 1–9: the latest one shown gets them. */
type Keyed = { n: number; el: () => HTMLElement | null; pick: (n: number) => void };
const keyed = new Set<Keyed>();
let mounted = 0;

function onDigit(e: KeyboardEvent) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat || !/^[1-9]$/.test(e.key)) return;
  const t = e.target as HTMLElement | null;
  // Typing a number somewhere.
  if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
  const shown = [...keyed].filter((k) => !!k.el()?.getClientRects().length);
  if (!shown.length) return;
  const card = shown.reduce((a, b) => (b.n > a.n ? b : a));
  // Not one behind a dialog it isn't in.
  const dialogs = document.querySelectorAll('[aria-modal="true"]');
  if (dialogs.length && !dialogs[dialogs.length - 1]!.contains(card.el())) return;
  e.preventDefault();
  card.pick(Number(e.key));
}

/** While `on`, keys 1–9 call `pick` for the card `ref` is on, if it's the latest such card. */
function useDigitKeys(on: boolean, ref: RefObject<HTMLElement | null>, pick: (n: number) => void) {
  const latest = useRef(pick);
  latest.current = pick;
  const [n] = useState(() => ++mounted);
  useEffect(() => {
    if (!on) return;
    const entry: Keyed = { n, el: () => ref.current, pick: (k) => latest.current(k) };
    if (!keyed.size) document.addEventListener("keydown", onDigit);
    keyed.add(entry);
    return () => {
      keyed.delete(entry);
      if (!keyed.size) document.removeEventListener("keydown", onDigit);
    };
  }, [n, on, ref]);
}
