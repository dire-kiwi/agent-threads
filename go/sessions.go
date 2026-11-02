package agentthreads

import "github.com/dire-kiwi/agent-threads/go/protocol"

// Where a rewind takes a thread's harness session, worked out from where each of its turns left it
// (their turn_results' session), by the rules in spec/PROTOCOL.md ("Sessions").

// RewindPoint is where a rewind goes: the session to take up ("": the next turn starts a new one),
// and where in it (the thread's resume_at: the harness's own mark).
type RewindPoint struct {
	SessionID string
	ResumeAt  string
}

// RewindError is a rewind that can't be made: the conversation before the turn isn't known.
type RewindError struct{ Message string }

func (e *RewindError) Error() string { return e.Message }

// ResumeAtPoint is, for a harness that resumes a session at a message (Claude Code), where a rewind
// to before turn i of sessions (each turn's, in order; nil for a turn that ended with none) goes: the
// session it continued, at the mark of the latest turn before it in that session.
func ResumeAtPoint(sessions []*protocol.TurnSession, i int) (RewindPoint, error) {
	t := sessions[i]
	if t == nil || t.Started {
		return RewindPoint{}, nil
	}
	for j := i - 1; j >= 0; j-- {
		u := sessions[j]
		if u == nil || u.ID != t.ID {
			break
		}
		if u.At != "" {
			return RewindPoint{SessionID: t.ID, ResumeAt: u.At}, nil
		}
		if u.Started {
			break
		}
	}
	return RewindPoint{}, &RewindError{Message: "the conversation before this turn isn't known (it began before the thread did)"}
}

// RevertPoint is, for a harness that reverts a session to before a turn (Codex), where a rewind to
// before turn i of sessions goes: the session it continued, reverted to before the first turn from
// it on, in that session, that has a mark. With none, the session is as it was before the turn.
func RevertPoint(sessions []*protocol.TurnSession, i int) (RewindPoint, error) {
	t := sessions[i]
	if t == nil || t.Started {
		return RewindPoint{}, nil
	}
	for j := i; j < len(sessions); j++ {
		u := sessions[j]
		if u == nil || u.ID != t.ID || (j > i && u.Started) {
			break
		}
		if u.At != "" {
			return RewindPoint{SessionID: t.ID, ResumeAt: u.At}, nil
		}
	}
	return RewindPoint{SessionID: t.ID}, nil
}
