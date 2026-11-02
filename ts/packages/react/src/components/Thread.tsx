// A whole thread: its items, its open requests, whether it's working, and the composer, kept
// scrolled to the latest while it's there. A thread whose snapshot is a window loads its earlier
// items as it's scrolled to the top, keeping what's on screen where it was.

import { memo, useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { ThreadProvider, useHasEarlier, useHasThread, useLoadEarlier, useThreadState, type ThreadProviderProps } from "../hooks.js";
import { AlertIcon } from "../icons.js";
import { NO_ITEMS } from "../view.js";
import { Composer } from "./Composer.js";
import { LoadEarlier } from "./LoadEarlier.js";
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

/** How near the top (in pixels) it's scrolled before it loads earlier items. */
const NEAR_TOP = 400;

const ThreadLayout = memo(function ThreadLayout({ className, placeholder, empty, composer = true, theme }: LayoutProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // Whether it's scrolled to the end, so it stays there as the thread grows.
  const pinned = useRef(true);
  const start = useThreadState((s) => s.snapshot.start ?? 0);
  const more = useHasEarlier();
  const loading = useThreadState((s) => s.loadingEarlier);
  const failed = useThreadState((s) => s.earlierError !== null);
  const loadEarlier = useLoadEarlier();
  // Earlier items come in above what's on screen: note how far it is from the end before they're
  // drawn, to keep it there after (and so keep what's on screen where it was).
  const shownStart = useRef(start);
  const fromEnd = useRef<number | null>(null);
  if (start !== shownStart.current && fromEnd.current === null && scroller.current) fromEnd.current = scroller.current.scrollHeight - scroller.current.scrollTop;
  useLayoutEffect(() => {
    const el = scroller.current;
    const keep = fromEnd.current;
    shownStart.current = start;
    fromEnd.current = null;
    if (el && keep !== null && !pinned.current) el.scrollTop = el.scrollHeight - keep;
  }, [start]);
  // Near the top (or not filling the screen): the page before.
  const nearTop = useCallback(() => {
    const el = scroller.current;
    if (el && more && !loading && !failed && el.scrollTop < NEAR_TOP) void loadEarlier();
  }, [more, loading, failed, loadEarlier]);
  useEffect(nearTop, [nearTop, start]);
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
          nearTop();
        }}
      >
        <div ref={body} className="at-thread-body">
          <LoadEarlier />
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
  const none = useThreadState((s) => (s.view.children.get("") ?? NO_ITEMS).length === 0 && s.snapshot.thread.status === "idle" && !s.snapshot.start);
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
