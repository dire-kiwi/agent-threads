// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEvents, initialState, itemPage, snapshotWindow, type Command, type Item, type QuestionRequest, type ThreadEvent } from "@dire-kiwi/agent-threads-protocol";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsPill } from "./components/AgentsPill.js";
import { Thread } from "./components/Thread.js";
import type { ThreadConfig, ToolRowProps } from "./config.js";
import { ThreadProvider } from "./hooks.js";
import { fixtureEvents, fixtureNames, fixtureThread, testSource, thread } from "./test/helpers.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A fixture's events, and its state after the first `n` of them (all, by default). */
function fixture(name: string, until?: (e: ThreadEvent) => boolean) {
  const events = fixtureEvents(name);
  const at = until ? events.findIndex(until) + 1 : events.length;
  const start = initialState(fixtureThread(events));
  return { events, rest: events.slice(at), snapshot: applyEvents(start, events.slice(0, at)), start };
}

/** <Thread> on a source, collecting the commands it sends. */
function mount(snapshot = fixture("claude/plain-reply").snapshot, config: ThreadConfig = {}) {
  const t = testSource(snapshot);
  const commands: Command[] = [];
  const view = render(<Thread source={t.source} onCommand={(c) => void commands.push(c)} {...config} />);
  return { ...t, ...view, commands };
}

describe("<Thread>", () => {
  it.each(fixtureNames)("draws %s as its events come", (name) => {
    const { events, start } = fixture(name, () => false);
    const { emit, container } = mount(start);
    for (const e of events) act(() => emit(e));
    // Each of the agent's replies in the main thread is there (as Markdown, so without inline
    // code's backticks), as is each turn's end.
    const final = applyEvents(start, events);
    for (const item of final.items)
      if (item.type === "assistant_message" && item.text.trim() && !item.parent_id) expect(container.textContent).toContain(item.text.trim().split("\n")[0]!.replaceAll("`", ""));
    expect(container.querySelectorAll(".at-turn-result")).toHaveLength(final.items.filter((i) => i.type === "turn_result").length);
    // Every request is answered: its card is where it was asked, greyed out, with its answer.
    expect(container.querySelector(".at-card:not(.at-card-done)")).toBeNull();
    expect(container.querySelectorAll(".at-card-done")).toHaveLength(final.requests.length);
  });

  it("redraws only the rows an event changes", () => {
    const draws = new Map<string, number>();
    const renderItem = (item: Item) => void draws.set(item.id, (draws.get(item.id) ?? 0) + 1);
    const { snapshot } = fixture("claude/tool-calls");
    const { emit } = mount(snapshot, { renderItem });
    const before = new Map(draws);
    expect(before.size).toBeGreaterThan(2);
    const last = snapshot.items.findLast((i) => i.type === "assistant_message")!;
    act(() => emit({ type: "item.updated", thread_id: snapshot.thread.id, seq: snapshot.seq + 1, item_id: last.id, patch: { text: "changed" } }));
    for (const [id, n] of draws) expect([id, n]).toEqual([id, (before.get(id) ?? 0) + (id === last.id ? 1 : 0)]);
  });

  it("draws a message plainly while it streams, then as Markdown", () => {
    const { snapshot } = fixture("claude/plain-reply", (e) => e.type === "item.added" && e.item.type === "assistant_message");
    const id = snapshot.items.findLast((i) => i.type === "assistant_message")!.id;
    const { emit, container } = mount(snapshot);
    act(() => emit({ type: "delta", thread_id: snapshot.thread.id, seq: snapshot.seq, item_id: id, kind: "text", offset: 0, text: "Hello `there`" }));
    expect(container.querySelector(".at-streaming")?.textContent).toBe("Hello `there`");
    act(() => emit({ type: "item.updated", thread_id: snapshot.thread.id, seq: snapshot.seq + 1, item_id: id, patch: { text: "Hello `there`" } }));
    expect(container.querySelector(".at-streaming")).toBeNull();
    expect(container.querySelector(".at-markdown code")?.textContent).toBe("there");
  });

  it("uses the app's Markdown renderer", () => {
    const { container } = mount(undefined, { renderMarkdown: (text) => <em className="md">{text}</em> });
    expect(container.querySelector(".at-assistant .md")).not.toBeNull();
  });

  it("opens a tool call to show its input and result", () => {
    const { container } = mount(fixture("claude/tool-calls").snapshot);
    const row = [...container.querySelectorAll(".at-tool-shell")][0] as HTMLElement;
    expect(row.textContent).toContain("Ran");
    fireEvent.click(within(row).getByRole("button"));
    expect(row.querySelector(".at-code-command")?.textContent).toMatch(/^\$ /);
  });

  it("draws an app's tool with its own renderer", () => {
    function OrderCard({ call }: ToolRowProps) {
      return <div className="order">Order {(call.input as { order_id: string }).order_id}</div>;
    }
    const tools = { lookup_order: { Row: OrderCard, alone: true } };
    const { container } = mount(fixture("claude/app-tool").snapshot, { tools });
    expect(container.querySelector(".order")?.textContent).toBe("Order 42");
    expect(container.querySelector(".at-tool-group .order")).toBeNull();
  });

  it("changes a tool's summary line", () => {
    const tools = { lookup_order: { meta: () => ({ label: "Looked up", summary: "order 42" }) } };
    const { container } = mount(fixture("codex/app-tool").snapshot, { tools });
    expect(container.textContent).toContain("Looked up");
  });

  it("shows a subagent's own items when it's opened", () => {
    const { container } = mount(fixture("claude/subagent").snapshot);
    const row = container.querySelector(".at-subagent") as HTMLElement;
    expect(row.textContent).toContain("Read notes.txt first line");
    expect(row.querySelector(".at-tool-read")).toBeNull();
    fireEvent.click(row.querySelector(".at-tool-head")!);
    expect(row.querySelector(".at-tool-read")?.textContent).toContain("notes.txt");
  });

  it("shows a background subagent running after its call has returned, and its summary once it's done", () => {
    // After the turn that started it: its call has completed, and it's still working.
    const running = mount(fixture("claude/background-subagent", (e) => e.type === "turn.completed").snapshot).container;
    let row = running.querySelector(".at-subagent") as HTMLElement;
    expect(row.querySelector(".at-subagent-tag")?.textContent).toBe("background");
    expect(row.querySelector(".at-progress")).not.toBeNull();
    fireEvent.click(row.querySelector(".at-tool-head")!);
    expect(row.textContent).toContain("Working in the background…");
    cleanup();

    const done = mount(fixture("claude/background-subagent").snapshot).container;
    row = done.querySelector(".at-subagent") as HTMLElement;
    expect(row.querySelector(".at-good")).not.toBeNull();
    fireEvent.click(row.querySelector(".at-tool-head")!);
    expect(row.querySelector(".at-subagent-meta")?.textContent).toBe("claude-haiku-5-5 · in the background · 2 tool uses");
    expect(row.textContent).not.toContain("Async agent launched");
  });

  it("shows a skill's forked subagent as a Skill", () => {
    const { container } = mount(fixture("claude/skill-fork").snapshot);
    const row = container.querySelector(".at-subagent") as HTMLElement;
    expect(row.querySelector(".at-tool-label")?.textContent).toBe("Skill");
    expect(row.querySelector(".at-subagent-title")?.textContent).toBe("/app:first-line");
    fireEvent.click(row.querySelector(".at-tool-head")!);
    expect(row.querySelector(".at-tool-read")?.textContent).toContain("notes.txt");
  });

  it("reveals a subagent picked from the agents pill", () => {
    const { snapshot } = fixture("claude/subagent");
    const t = testSource(snapshot);
    const { container } = render(
      <ThreadProvider source={t.source} onCommand={() => {}}>
        <AgentsPill />
        <Thread />
      </ThreadProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Agents/ }));
    fireEvent.click(screen.getByRole("menuitem"));
    expect(container.querySelector(".at-subagent .at-subagent-body")).not.toBeNull();
  });

  it("asks for permission, and allows", () => {
    const { snapshot } = fixture("claude/permission-allow", (e) => e.type === "request.opened");
    const { commands, container } = mount(snapshot);
    const card = container.querySelector(".at-permission") as HTMLElement;
    expect(card.textContent).toContain("Claude wants to use Bash");
    expect(card.textContent).toContain("touch allowed.txt");
    expect(container.querySelector(".at-tool-status.at-attention")?.textContent).toContain("needs approval");
    fireEvent.click(within(card).getByRole("button", { name: /^Allow/ }));
    expect(commands).toEqual([{ type: "respond", thread_id: snapshot.thread.id, request_id: "{{p1}}", resolution: { outcome: "allow" } }]);
  });

  it("allows always, or denies with a note", () => {
    const { snapshot } = fixture("codex/permission-deny", (e) => e.type === "request.opened");
    const { commands, container } = mount(snapshot);
    const card = () => within(container.querySelector(".at-permission") as HTMLElement);
    expect(card().getByText(/Codex wants to use/)).toBeTruthy();
    fireEvent.click(card().getByRole("button", { name: /Always allow/ }));
    fireEvent.click(card().getByRole("button", { name: /Deny with a note/ }));
    fireEvent.change(card().getByLabelText("A note for the agent"), { target: { value: "Not that file" } });
    fireEvent.click(card().getByRole("button", { name: /^Deny$/ }));
    expect(commands.map((c) => c.type === "respond" && c.resolution)).toEqual([
      { outcome: "allow", always: true },
      { outcome: "deny", message: "Not that file" },
    ]);
  });

  // Requests with no tool item to look at: the card alone shows what's being allowed.
  it.each([
    ["Read", "read", { file_path: "/private/payroll.csv" }, ["/private/payroll.csv"]],
    ["Grep", "search", { pattern: "password", path: "/private/" }, ["password", "/private/"]],
    ["WebSearch", "web", { query: "agent threads" }, ["agent threads"]],
    ["WebFetch", "web", { url: "https://example.com/x" }, ["https://example.com/x"]],
    ["Edit", "edit", { file_path: "/etc/config", old_string: "old", new_string: "new" }, ["/etc/config", "- old", "+ new"]],
    ["Write", "edit", { file_path: "/etc/hosts", content: "127.0.0.1 x" }, ["/etc/hosts", "127.0.0.1 x"]],
    ["Bash", "shell", { command: "rm -rf build" }, ["rm -rf build"]],
  ] as const)("shows what a standalone %s request is for", (name, kind, input, shown) => {
    const opened: ThreadEvent = { type: "request.opened", thread_id: "th", seq: 1, request: { id: "p1", type: "permission", name, kind, input } };
    const { container } = mount(applyEvents(initialState(thread), [opened]));
    const card = container.querySelector(".at-permission") as HTMLElement;
    for (const text of shown) expect(card.textContent).toContain(text);
    expect(card.textContent).not.toContain("Reading…");
  });

  it("shows a request's title, and the target of a call that's in the thread", () => {
    const call: Item = { id: "c1", type: "tool_call", name: "Read", kind: "read", input: { file_path: "/srv/app/.env" }, status: "pending" };
    const { container } = mount(
      applyEvents(initialState({ ...thread, cwd: "/srv/app" }), [
        { type: "item.added", thread_id: "th", seq: 1, item: call },
        { type: "request.opened", thread_id: "th", seq: 2, request: { id: "p1", type: "permission", tool_call_id: "c1", name: "Read", kind: "read", input: call.input, title: "Read the app's secrets" } },
      ]),
    );
    const card = container.querySelector(".at-permission") as HTMLElement;
    expect(card.querySelector(".at-permission-summary")?.textContent).toBe(".env");
    expect(card.querySelector(".at-permission-title")?.textContent).toBe("Read the app's secrets");
    expect(card.textContent).toContain('"file_path": "/srv/app/.env"');
  });

  it("shows why a response failed", async () => {
    const { snapshot } = fixture("claude/permission-allow", (e) => e.type === "request.opened");
    const t = testSource(snapshot);
    render(<Thread source={t.source} onCommand={() => Promise.reject(new Error("offline"))} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^Allow/ })));
    expect(screen.getByText("offline")).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Allow/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps a request's card once it's resolved, where it was asked, with its answer", () => {
    const { snapshot, rest } = fixture("claude/permission-allow", (e) => e.type === "request.opened");
    const { emit, container } = mount(snapshot);
    const open = container.querySelector(".at-requests .at-permission");
    expect(open).not.toBeNull();
    expect(within(open as HTMLElement).getByRole("button", { name: /^Allow$/ })).toBeTruthy();
    act(() => emit(rest.find((e) => e.type === "request.resolved")!));
    expect(container.querySelector(".at-requests")).toBeNull();
    const done = container.querySelector(".at-message-list .at-permission.at-card-done") as HTMLElement;
    expect(done.textContent).toContain("asked to use Bash");
    expect(done.textContent).toContain("Allowed");
    expect(within(done).queryByRole("button")).toBeNull();
    // Just before the call it was for.
    expect(done.nextElementSibling?.querySelector("[data-tool-row]")?.textContent).toContain("touch allowed.txt");
  });

  it("shows how a denied permission went, with the note for the agent", () => {
    const { snapshot } = fixture("claude/permission-allow", (e) => e.type === "request.opened");
    const request = snapshot.requests[0]!;
    const denied = { ...snapshot, requests: [{ ...request, resolution: { outcome: "deny" as const, message: "Not that file." } }] };
    const { container } = mount(denied);
    const done = container.querySelector(".at-card-done") as HTMLElement;
    expect(done.textContent).toContain("Denied");
    expect(done.textContent).toContain("Not that file.");
  });

  it("shows an answered question's answers in place of its call, and one that wasn't answered", () => {
    const { snapshot } = fixture("codex/ask-user-question");
    const { container, unmount } = mount(snapshot);
    const done = container.querySelector(".at-question.at-card-done") as HTMLElement;
    expect(done.textContent).toContain("Answered");
    const picked = within(done)
      .getAllByRole("radio")
      .filter((r) => r.getAttribute("aria-checked") === "true")
      .map((r) => r.textContent);
    const answer = (snapshot.requests[0]!.resolution!.answers ?? {}) as Record<string, string[]>;
    const options = (snapshot.requests[0] as QuestionRequest).questions[0]!.options!.map((o) => o.label);
    expect(picked.map((t) => options.find((o) => t?.includes(o)))).toEqual(Object.values(answer)[0]!.filter((a) => options.includes(a)));
    expect(within(done).getAllByRole("radio").every((r) => (r as HTMLButtonElement).disabled)).toBe(true);
    // The call's row isn't drawn as well: the card has the answers.
    const call = (snapshot.requests[0] as QuestionRequest).tool_call_id!;
    expect(container.querySelector(`[data-tool-row]`)?.textContent ?? "").not.toContain(call);
    unmount();
    const cancelled = { ...snapshot, requests: [{ ...snapshot.requests[0]!, resolution: { outcome: "cancel" as const } }] };
    const again = mount(cancelled);
    expect(again.container.querySelector(".at-card-done")?.textContent).toContain("Not answered");
  });

  it("answers a question with an option, or its own answer", () => {
    const { snapshot } = fixture("codex/ask-user-question", (e) => e.type === "request.opened");
    const { commands } = mount(snapshot);
    fireEvent.click(screen.getByRole("radio", { name: /Blue/ }));
    expect(commands.at(-1)).toMatchObject({ type: "respond", resolution: { outcome: "answer", answers: { color: ["Blue"] } } });
    fireEvent.change(screen.getByLabelText(/Your own answer/), { target: { value: "Green" } });
    fireEvent.click(screen.getByRole("button", { name: /Answer/ }));
    expect(commands.at(-1)).toMatchObject({ resolution: { outcome: "answer", answers: { color: ["Green"] } } });
  });

  it("answers several questions, one taking several picks, and picks with keys 1–9", () => {
    const { snapshot } = fixture("claude/ask-user-question", (e) => e.type === "request.opened");
    const request = snapshot.requests[0] as QuestionRequest;
    const questions: QuestionRequest["questions"] = [
      { id: "size", question: "Which size?", options: [{ label: "S" }, { label: "M" }, { label: "L" }] },
      { id: "toppings", question: "Which toppings?", multi_select: true, options: [{ label: "Cheese" }, { label: "Olives" }] },
    ];
    // jsdom lays nothing out, and keys go only to a card that's on screen.
    vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    const { commands } = mount({ ...snapshot, requests: [{ ...request, questions }] });
    const answer = screen.getByRole("button", { name: /Submit answers/ }) as HTMLButtonElement;
    expect(answer.disabled).toBe(true);
    fireEvent.keyDown(document.body, { key: "2" });
    expect(screen.getByRole("radio", { name: /M/ }).getAttribute("aria-checked")).toBe("true");
    // Picking it moved on to the next question, where keys tick options.
    fireEvent.keyDown(document.body, { key: "1" });
    fireEvent.click(screen.getByRole("checkbox", { name: /Olives/ }));
    fireEvent.click(answer);
    expect(commands.at(-1)).toMatchObject({ resolution: { outcome: "answer", answers: { size: ["M"], toppings: ["Cheese", "Olives"] } } });
  });

  it("dismisses a question", () => {
    const { snapshot } = fixture("claude/ask-user-question", (e) => e.type === "request.opened");
    const { commands } = mount(snapshot);
    fireEvent.click(screen.getByRole("button", { name: /Dismiss/ }));
    expect(commands.at(-1)).toMatchObject({ type: "respond", resolution: { outcome: "cancel" } });
  });
});

describe("<Composer>", () => {
  it("sends with Enter, and clears what was sent", () => {
    const { commands } = mount();
    const box = screen.getByLabelText("Message the agent") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Hello" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(commands).toMatchObject([{ type: "send", text: "Hello" }]);
    expect(box.value).toBe("");
    fireEvent.change(box, { target: { value: "two\nlines" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(commands).toHaveLength(1);
  });

  it("steers and stops a running turn", () => {
    const { snapshot } = fixture("claude/steer", (e) => e.type === "thread.updated" && e.thread.status === "running");
    const { commands } = mount(snapshot);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Message the agent"), { target: { value: "also this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(commands).toMatchObject([{ type: "send", text: "also this" }, { type: "interrupt" }]);
    expect(screen.getByText("Working…")).toBeTruthy();
  });

  it("keeps the text, and says why, when a send fails", async () => {
    const t = testSource(fixture("claude/plain-reply").snapshot);
    const onCommand = vi.fn(() => Promise.reject(new Error("offline")));
    render(<Thread source={t.source} onCommand={onCommand} />);
    const box = screen.getByLabelText("Message the agent") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Hello" } });
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    expect(box.value).toBe("Hello");
    expect(screen.getByText("offline")).toBeTruthy();
  });
});

describe("a window of a long thread", () => {
  /** A thread whose subagent (sa, at 2) has its last item at 18, and whose open request (at 19) is from it. */
  function long() {
    const items: Item[] = [];
    for (let i = 0; i < 20; i++) {
      if (i === 2) items.push({ id: "sa", type: "tool_call", name: "Agent", kind: "subagent", input: { description: "Dig in" }, status: "running", title: "Dig in" });
      else if (i === 18 || i === 3) items.push({ id: `b${i}`, type: "assistant_message", text: `sub ${i}`, parent_id: "sa" });
      else items.push({ id: `m${i}`, type: "assistant_message", text: `message ${i}` });
    }
    const events: ThreadEvent[] = items.map((item, i) => ({ type: "item.added", thread_id: "th", seq: i + 1, item }));
    events.push({ type: "request.opened", thread_id: "th", seq: 21, request: { id: "p1", type: "permission", name: "Bash", kind: "shell", input: { command: "ls" }, parent_id: "sa" } });
    return applyEvents(initialState(thread), events);
  }

  function mountWindow(limit: number, pageSize: number, scrollTop?: number) {
    const whole = long();
    const asked: number[] = [];
    const t = testSource(snapshotWindow(whole, limit));
    t.source.loadEarlier = async (before) => {
      asked.push(before);
      return itemPage(whole, before, pageSize);
    };
    // jsdom lays nothing out: scrollTop stays 0, as if it's at the top, unless set.
    if (scrollTop !== undefined) vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockReturnValue(scrollTop);
    const view = render(<Thread source={t.source} onCommand={() => {}} />);
    return { ...view, asked, whole };
  }

  it("loads earlier items as it's scrolled near the top, until they're all in", async () => {
    const { container, asked } = mountWindow(3, 6);
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
    expect(asked).toEqual([17, 11, 5]);
    expect(container.textContent).toContain("message 0");
    expect(container.querySelector(".at-earlier")).toBeNull();
  });

  it("loads a page with the button when it's not near the top", async () => {
    const { container, asked } = mountWindow(3, 6, 5000);
    expect(asked).toEqual([]);
    expect(container.textContent).not.toContain("message 16");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" })));
    expect(asked).toEqual([17]);
    expect(container.textContent).toContain("message 16");
    expect(container.textContent).not.toContain("message 10");
    // The subagent the open request is from is there for context, before what's loaded.
    expect(container.querySelector('[data-subagent="sa"]')).not.toBeNull();
  });

  it("says when a page couldn't be loaded, and tries again with the button", async () => {
    const whole = long();
    const t = testSource(snapshotWindow(whole, 3));
    let fail = true;
    t.source.loadEarlier = async (before) => {
      if (fail) throw new Error("offline");
      return itemPage(whole, before, 50);
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(<Thread source={t.source} onCommand={() => {}} />);
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    const retry = screen.getByRole("button", { name: /Couldn't load earlier messages/ });
    fail = false;
    await act(async () => fireEvent.click(retry));
    expect(container.textContent).toContain("message 0");
  });

  it("loads back to where a subagent started when it's opened, or revealed from its request", async () => {
    const { container, asked } = mountWindow(3, 4, 5000);
    expect(container.textContent).not.toContain("sub 3");
    // "from Dig in" on the open request reveals the subagent: it opens, with its earlier items loaded.
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /from Dig in/ })));
    await act(async () => {
      for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    });
    expect(asked).toEqual([17, 13, 9, 5]);
    const sub = container.querySelector('[data-subagent="sa"]') as HTMLElement;
    expect(sub.querySelector(".at-subagent-body")?.textContent).toContain("sub 3");
    expect(sub.querySelector(".at-earlier")).toBeNull();
  });
});

describe("a window over a quiet subagent", () => {
  it("has its call, so what it does after the snapshot is drawn under it", () => {
    // A running subagent at 0, with nothing of its own since, then two messages: a window of two.
    const items: Item[] = [
      { id: "sa", type: "tool_call", name: "Agent", kind: "subagent", input: { description: "Dig in" }, status: "running", title: "Dig in" },
      { id: "m1", type: "assistant_message", text: "message 1" },
      { id: "m2", type: "assistant_message", text: "message 2" },
    ];
    const whole = applyEvents(initialState(thread), items.map((item, i): ThreadEvent => ({ type: "item.added", thread_id: "th", seq: i + 1, item })));
    const t = testSource(snapshotWindow(whole, 2));
    const { container } = render(<Thread source={t.source} onCommand={() => {}} />);
    act(() => t.emit({ type: "item.added", thread_id: "th", seq: 4, item: { id: "b4", type: "assistant_message", text: "it goes on", parent_id: "sa" } }));
    const row = container.querySelector('[data-subagent="sa"]') as HTMLElement;
    expect(row).not.toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: /Dig in/ }));
    expect(row.textContent).toContain("it goes on");
  });
});

describe("themes", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");
  /** The --at-* variables a block of styles.css (from `selector {` to its closing brace) sets. */
  const vars = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    const body = css.slice(at, css.indexOf("}", at));
    return [...body.matchAll(/(--at-[\w-]+):/g)].map((m) => m[1]).sort();
  };

  it("has the dark theme set every colour the light one does, by preference and by class", () => {
    const light = vars(":root,\n.at-theme-light").filter((v) => !/font|radius|max-width|mono/.test(v!));
    const media = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
    expect(media.length).toBeGreaterThan(0);
    const preferred = [...media.slice(0, media.indexOf("}\n}")).matchAll(/(--at-[\w-]+):/g)].map((m) => m[1]).sort();
    expect(preferred).toEqual(light);
    expect(vars(".at-theme-dark")).toEqual(light);
  });

  it("uses only variables the themes set", () => {
    const set = new Set(vars(":root,\n.at-theme-light"));
    const used = new Set([...css.matchAll(/var\((--at-[\w-]+)/g)].map((m) => m[1]!));
    expect([...used].filter((v) => !set.has(v))).toEqual([]);
  });

  it("picks a theme with <Thread theme>", () => {
    const { container } = mount(undefined, {});
    expect(container.querySelector(".at-thread")?.className).not.toMatch(/at-theme/);
    cleanup();
    const t = testSource(fixture("claude/plain-reply").snapshot);
    const dark = render(<Thread source={t.source} onCommand={() => {}} theme="dark" />);
    expect(dark.container.querySelector(".at-thread")?.classList.contains("at-theme-dark")).toBe(true);
  });
});
