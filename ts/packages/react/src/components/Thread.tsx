// A whole thread: its items, its open requests, whether it's working, and the composer, kept
// scrolled to the latest while it's there.

import { memo, useLayoutEffect, useRef, type ReactNode } from "react";
import { ThreadProvider, useHasThread, useThreadState, type ThreadProviderProps } from "../hooks.js";
import { AlertIcon } from "../icons.js";
import { NO_ITEMS } from "../view.js";
import { Composer } from "./Composer.js";
import { MessageList } from "./MessageList.js";
import { OpenRequests } from "./Requests.js";
import { cx } from "./ui.js";

export interface ThreadProps extends Partial<Omit<ThreadProviderProps, "children">> {
  className?: string;
  /** The composer's placeholder. */
  placeholder?: string;
  /** Shown while the thread has no items. */
  empty?: ReactNode;
  /** Whether to show the composer, or a composer of the app's own. Default true. */
  composer?: boolean | ReactNode;
  /** A theme preset; without one it follows the page's (see styles.css). */
  theme?: "light" | "dark";
}

/**
 * A thread, with its composer. Inside a ThreadProvider it draws that one's thread; or give it a
 * `source` and `onCommand` (and any of ThreadConfig) and it makes its own provider.
 */
export function Thread({ source, onCommand, tools, toolKinds, renderMarkdown, renderItem, ...props }: ThreadProps) {
  const inside = useHasThread();
  if (source && onCommand)
    return (
      <ThreadProvider source={source} onCommand={onCommand} tools={tools} toolKinds={toolKinds} renderMarkdown={renderMarkdown} renderItem={renderItem}>
        <ThreadLayout {...props} />
      </ThreadProvider>
    );
  if (!inside) throw new Error("agent-threads: <Thread> needs a source and onCommand, or to be inside a <ThreadProvider>");
  return <ThreadLayout {...props} />;
}

type LayoutProps = Pick<ThreadProps, "className" | "placeholder" | "empty" | "composer" | "theme">;

const ThreadLayout = memo(function ThreadLayout({ className, placeholder, empty, composer = true, theme }: LayoutProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // Whether it's scrolled to the end, so it stays there as the thread grows.
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = body.current;
    if (!el || !inner) return;
    el.scrollTop = el.scrollHeight;
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);
  return (
    <div className={cx("at-root", "at-thread", theme && `at-theme-${theme}`, className)}>
      <div
        ref={scroller}
        className="at-thread-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div ref={body} className="at-thread-body">
          {empty !== undefined && <Empty>{empty}</Empty>}
          <MessageList />
          <OpenRequests />
          <ThreadStatusLine />
        </div>
      </div>
      {composer === true ? <Composer placeholder={placeholder} /> : composer || null}
    </div>
  );
});

function Empty({ children }: { children: ReactNode }) {
  const none = useThreadState((s) => (s.view.children.get("") ?? NO_ITEMS).length === 0 && s.snapshot.thread.status === "idle");
  return none ? <div className="at-empty">{children}</div> : null;
}

/** Whether the thread's working, waiting on the user, or failed. */
export function ThreadStatusLine({ className }: { className?: string }) {
  const status = useThreadState((s) => s.snapshot.thread.status);
  const error = useThreadState((s) => s.snapshot.thread.error);
  const resyncing = useThreadState((s) => s.resyncing);
  if (status === "running" || status === "waiting")
    return (
      <div className={cx("at-working", className)}>
        <span className="at-dot" /> {status === "waiting" ? "Waiting for you…" : resyncing ? "Catching up…" : "Working…"}
      </div>
    );
  if (status === "error" && error)
    return (
      <div className={cx("at-working", "at-bad", className)}>
        <AlertIcon size={12} /> {error}
      </div>
    );
  return null;
}
