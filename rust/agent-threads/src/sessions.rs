//! Where a rewind takes a thread's harness session, worked out from where each of its turns left it
//! (their turn_results' `session`), by the rules in spec/PROTOCOL.md ("Sessions").

use std::fmt;

use crate::protocol::TurnSession;

/// Where a rewind goes: the session to take up (none: the next turn starts a new one), and where in
/// it (the thread's `resume_at`: the harness's own mark).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RewindPoint {
    pub session_id: Option<String>,
    pub resume_at: Option<String>,
}

/// A rewind that can't be made: the conversation before the turn isn't known.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RewindError(pub String);

impl fmt::Display for RewindError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RewindError {}

/// Where a turn lost with no mark (TurnSession.lost) leaves a rewind that would need it.
const LOST: &str = "a turn the backend lost while it ran is in the way: where it left the conversation isn't known";

/// For a harness that resumes a session at a message (Claude Code): back to before turn `i` of
/// `sessions` (each turn's, in order) is the session it continued, at the mark of the latest turn
/// before it in that session. A lost turn in between, with no mark, may have added to the session
/// after that: it can't be rewound there.
pub fn resume_at_point(sessions: &[Option<TurnSession>], i: usize) -> Result<RewindPoint, RewindError> {
    let Some(t) = sessions.get(i).and_then(Option::as_ref).filter(|t| !t.started) else {
        return Ok(RewindPoint::default());
    };
    for u in sessions[..i].iter().rev() {
        let Some(u) = u.as_ref().filter(|u| u.id == t.id) else {
            break;
        };
        if let Some(at) = &u.at {
            return Ok(RewindPoint {
                session_id: Some(t.id.clone()),
                resume_at: Some(at.clone()),
            });
        }
        if u.lost {
            return Err(RewindError(LOST.into()));
        }
        if u.started {
            break;
        }
    }
    Err(RewindError(
        "the conversation before this turn isn't known (it began before the thread did)".into(),
    ))
}

/// For a harness that reverts a session to before a turn (Codex): back to before turn `i` is the
/// session it continued, reverted to before the first turn from it on, in that session, that has a
/// mark. With none, the session is as it was before the turn. A lost turn before that, with no
/// mark, may have added to the session: it can't be rewound there.
pub fn revert_point(sessions: &[Option<TurnSession>], i: usize) -> Result<RewindPoint, RewindError> {
    let Some(t) = sessions.get(i).and_then(Option::as_ref).filter(|t| !t.started) else {
        return Ok(RewindPoint::default());
    };
    for (j, u) in sessions.iter().enumerate().skip(i) {
        let Some(u) = u.as_ref().filter(|u| u.id == t.id && !(j > i && u.started)) else {
            break;
        };
        if let Some(at) = &u.at {
            return Ok(RewindPoint {
                session_id: Some(t.id.clone()),
                resume_at: Some(at.clone()),
            });
        }
        if u.lost {
            return Err(RewindError(LOST.into()));
        }
    }
    Ok(RewindPoint {
        session_id: Some(t.id.clone()),
        resume_at: None,
    })
}
