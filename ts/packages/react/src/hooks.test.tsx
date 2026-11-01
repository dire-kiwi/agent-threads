// @vitest-environment jsdom

import { initialState, type Command, type Item, type ThreadEvent } from "@dire-kiwi/agent-threads-protocol";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadProvider, useInterrupt, useRespond, useSend, useSetOptions, useThread, useThreadState } from "./hooks.js";
import { testSource, thread } from "./test/helpers.js";

afterEach(cleanup);

const added = (seq: number, item: Item): ThreadEvent => ({ type: "item.added", thread_id: "th", seq, item });
const msg = (id: string, text = ""): Item => ({ id, type: "assistant_message", text });

describe("useThread", () => {
  it("draws the source's snapshot, then each event", () => {
    const t = testSource();
    const { result } = renderHook(() => useThread(t.source));
    expect(result.current.snapshot.items).toEqual([]);
    act(() => t.emit(added(1, msg("a", "hi"))));
    expect(result.current.snapshot.items).toEqual([msg("a", "hi")]);
  });

  it("starts again from a new source's snapshot, and lets go of the old one", () => {
    const first = testSource();
    const { result, rerender } = renderHook(({ source }) => useThread(source), { initialProps: { source: first.source } });
    act(() => first.emit(added(1, msg("a"))));
    const second = testSource({ ...initialState(thread), items: [msg("z")], seq: 9 });
    rerender({ source: second.source });
    expect(result.current.snapshot.items.map((i) => i.id)).toEqual(["z"]);
    expect(first.listeners.size).toBe(0);
    act(() => second.emit(added(10, msg("y"))));
    expect(result.current.snapshot.items.map((i) => i.id)).toEqual(["z", "y"]);
  });

  it("asks the source for a resync on a gap", async () => {
    // On mounting it asks for what came before it subscribed: nothing, here.
    const resync = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([added(2, msg("b"))]);
    const t = testSource(undefined, resync);
    const { result } = renderHook(() => useThread(t.source));
    expect(resync).toHaveBeenCalledWith(0);
    await act(async () => {});
    expect(result.current.resyncing).toBe(false);
    act(() => t.emit(added(1, msg("a")), added(3, msg("c"))));
    expect(result.current.resyncing).toBe(true);
    await act(async () => {});
    expect(result.current.snapshot.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(result.current.resyncing).toBe(false);
  });
});

describe("ThreadProvider", () => {
  function setup() {
    const t = testSource();
    const commands: Command[] = [];
    const onCommand = vi.fn((c: Command) => void commands.push(c));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ThreadProvider source={t.source} onCommand={onCommand}>
        {children}
      </ThreadProvider>
    );
    return { ...t, commands, onCommand, wrapper };
  }

  it("sends the commands for the thread", () => {
    const { wrapper, commands } = setup();
    const { result } = renderHook(() => ({ send: useSend(), interrupt: useInterrupt(), respond: useRespond(), setOptions: useSetOptions() }), { wrapper });
    result.current.send("hello", { client_id: "c1" });
    result.current.interrupt();
    result.current.respond("p1", { outcome: "allow", always: true });
    result.current.setOptions({ model: "opus", permission_mode: "plan" });
    expect(commands).toEqual([
      { type: "send", thread_id: "th", text: "hello", client_id: "c1" },
      { type: "interrupt", thread_id: "th" },
      { type: "respond", thread_id: "th", request_id: "p1", resolution: { outcome: "allow", always: true } },
      { type: "set_options", thread_id: "th", model: "opus", permission_mode: "plan" },
    ]);
  });

  it("makes up a client_id for a send, and passes attachments on", () => {
    const { wrapper, commands } = setup();
    const { result } = renderHook(() => useSend(), { wrapper });
    result.current("hi", { attachments: [{ kind: "file", path: "/a.txt" }] });
    expect(commands[0]).toMatchObject({ type: "send", text: "hi", attachments: [{ kind: "file", path: "/a.txt" }] });
    expect((commands[0] as { client_id?: string }).client_id).toBeTruthy();
  });

  it("returns what onCommand does, so a component can wait on it", async () => {
    const t = testSource();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ThreadProvider source={t.source} onCommand={() => Promise.reject(new Error("offline"))}>
        {children}
      </ThreadProvider>
    );
    const { result } = renderHook(() => useInterrupt(), { wrapper });
    await expect(result.current()).rejects.toThrow("offline");
  });

  it("redraws a component only when what it picked changes", () => {
    const { source, emit } = setup();
    const draws: Record<string, number> = { status: 0, items: 0 };
    function Status() {
      draws.status!++;
      return <span>{useThreadState((s) => s.snapshot.thread.status)}</span>;
    }
    function Count() {
      draws.items!++;
      return <span>{useThreadState((s) => s.snapshot.items.length)}</span>;
    }
    render(
      <ThreadProvider source={source} onCommand={() => {}}>
        <Status />
        <Count />
      </ThreadProvider>,
    );
    act(() => emit(added(1, msg("a"))));
    act(() => emit({ type: "delta", thread_id: "th", seq: 1, item_id: "a", kind: "text", offset: 0, text: "more" }));
    expect(draws).toEqual({ status: 1, items: 2 });
    act(() => emit({ type: "thread.updated", thread_id: "th", seq: 2, thread: { ...thread, status: "running" } }));
    expect(draws).toEqual({ status: 2, items: 2 });
  });

  it("uses the latest onCommand without redrawing", () => {
    const t = testSource();
    const a = vi.fn();
    const b = vi.fn();
    const wrapper = ({ children, on }: { children: ReactNode; on: (c: Command) => void }) => (
      <ThreadProvider source={t.source} onCommand={on}>
        {children}
      </ThreadProvider>
    );
    let current = a;
    const { result, rerender } = renderHook(() => useInterrupt(), { wrapper: ({ children }) => wrapper({ children, on: current }) });
    const first = result.current;
    current = b;
    rerender();
    expect(result.current).toBe(first);
    result.current();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith({ type: "interrupt", thread_id: "th" });
  });

  it("needs a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useSend())).toThrow(/ThreadProvider/);
  });
});
