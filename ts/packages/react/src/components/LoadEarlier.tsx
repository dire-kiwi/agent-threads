// For a thread whose snapshot is a window of its latest items: a button that loads the earlier ones
// a page at a time, which says when they're loading or couldn't be loaded.

import { useHasEarlier, useLoadEarlier, useThreadState } from "../hooks.js";
import { SpinnerIcon } from "../icons.js";
import { cx } from "./ui.js";

/**
 * "Load earlier messages", while there are any: a page of them, or with `to`, those back to that
 * item (a subagent's call, in its own thread). Nothing once they're all in.
 */
export function LoadEarlier({ to, className }: { to?: string; className?: string }) {
  const more = useHasEarlier();
  const loading = useThreadState((s) => s.loadingEarlier);
  const error = useThreadState((s) => s.earlierError);
  const load = useLoadEarlier();
  if (!more) return null;
  return (
    <div className={cx("at-earlier", className)}>
      {loading ? (
        <span className="at-earlier-loading">
          <SpinnerIcon size={12} className="at-spin" /> Loading earlier messages…
        </span>
      ) : (
        <button type="button" className="at-link" onClick={() => void load(to === undefined ? undefined : { to })}>
          {error ? "Couldn't load earlier messages. Try again" : "Load earlier messages"}
        </button>
      )}
    </div>
  );
}
