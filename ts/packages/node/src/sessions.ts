// Where a rewind takes a thread's harness session, worked out from where each of its turns left it
// (their turn_results' `session`), by the rules in spec/PROTOCOL.md ("Sessions").

import type { TurnSession } from "@dire-kiwi/agent-threads-protocol";

/**
 * Where a rewind goes: the session to take up (none: the next turn starts a new one), and where in
 * it (the thread's `resume_at`: the harness's own mark).
 */
export interface RewindPoint {
  session_id?: string;
  resume_at?: string;
}

/** A rewind that can't be made: the conversation before the turn isn't known. */
export class RewindError extends Error {}

/**
 * For a harness that resumes a session at a message (Claude Code): back to before turn `i` of
 * `sessions` (each turn's, in order) is the session it continued, at the mark of the latest turn
 * before it in that session.
 */
export function resumeAtPoint(sessions: (TurnSession | undefined)[], i: number): RewindPoint {
  const t = sessions[i];
  if (!t || t.started) return {};
  for (let j = i - 1; j >= 0; j--) {
    const u = sessions[j];
    if (!u || u.id !== t.id) break;
    if (u.at) return { session_id: t.id, resume_at: u.at };
    if (u.started) break;
  }
  throw new RewindError("the conversation before this turn isn't known (it began before the thread did)");
}

/**
 * For a harness that reverts a session to before a turn (Codex): back to before turn `i` is the
 * session it continued, reverted to before the first turn from it on, in that session, that has a
 * mark. With none, the session is as it was before the turn.
 */
export function revertPoint(sessions: (TurnSession | undefined)[], i: number): RewindPoint {
  const t = sessions[i];
  if (!t || t.started) return {};
  for (let j = i; j < sessions.length; j++) {
    const u = sessions[j];
    if (!u || u.id !== t.id || (j > i && u.started)) break;
    if (u.at) return { session_id: t.id, resume_at: u.at };
  }
  return { session_id: t.id };
}
