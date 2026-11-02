// How many of the thread's subagents are running and done, opening a list of them; picking one
// shows its row in the thread.

import { useEffect, useRef, useState } from "react";
import { useReveal, useThreadState } from "../hooks.js";
import { BotIcon, ChevronIcon, SpinnerIcon } from "../icons.js";
import { SubagentStatusBadge, subagentKind, subagentTitle } from "./Subagent.js";
import { cx } from "./ui.js";

export function AgentsPill({ className, onSelect }: {
  className?: string;
  /** Called with the subagent picked; by default its row is shown in the thread. */
  onSelect?: (id: string) => void;
}) {
  const subagents = useThreadState((s) => s.view.subagents);
  const reveal = useReveal();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (subagents.size === 0) return null;
  const all = [...subagents.values()];
  const running = all.filter((s) => s.status === "running").length;
  const settled = all.length - running;
  // Newest first, running ones on top.
  const list = all.reverse().sort((a, b) => Number(b.status === "running") - Number(a.status === "running"));
  return (
    <div ref={root} className={cx("at-agents", className)}>
      <button type="button" className={cx("at-agents-pill", running > 0 && "at-agents-running")} aria-expanded={open} onClick={() => setOpen(!open)} title="Subagents in this thread">
        {running ? <SpinnerIcon size={12} className="at-spin at-progress" /> : <BotIcon size={13} />}
        Agents
        <span className="at-faint">
          {[running > 0 && `${running} running`, settled > 0 && `${settled} done`].filter(Boolean).join(" · ")}
        </span>
        <ChevronIcon size={11} className="at-chevron at-chevron-down" />
      </button>
      {open && (
        <div className="at-agents-menu" role="menu">
          {list.map((s) => (
            <button
              type="button"
              role="menuitem"
              key={s.id}
              className="at-agents-item"
              onClick={() => {
                setOpen(false);
                (onSelect ?? reveal)(s.id);
              }}
            >
              <BotIcon size={13} />
              <span className="at-agents-text">
                <span className="at-agents-title">{subagentTitle(s.call)}</span>
                <span className="at-agents-meta">{[subagentKind(s.call), s.background && "background", s.toolUses > 0 && `${s.toolUses} tool uses`].filter(Boolean).join(" · ")}</span>
              </span>
              <SubagentStatusBadge status={s.status} waiting={s.waiting} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
