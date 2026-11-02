//! A thread's state, folded from its events: the same rules as `applyEvent` in
//! `@dire-kiwi/agent-threads-protocol` (spec/PROTOCOL.md, "Applying events"). The backend keeps its
//! snapshots with it, and a Rust client can use it to follow a thread.

use serde_json::{Map, Value};

use crate::protocol::{DeltaEventKind, Item, Snapshot, Thread, ThreadEvent, ThreadRequest};

/// A thread's state before any of its events.
pub fn initial_state(thread: Thread) -> Snapshot {
    Snapshot {
        thread,
        items: Vec::new(),
        requests: Vec::new(),
        seq: 0,
    }
}

/// Applies `event` to `state`. Events for another thread, and saved events the state already has
/// (seq at or below `state.seq`, e.g. replayed after a reconnect), change nothing.
pub fn apply_event(state: &mut Snapshot, event: &ThreadEvent) {
    if event.thread_id() != state.thread.id {
        return;
    }
    if let ThreadEvent::Delta(d) = event {
        // A delta from before the last saved event the state has is already in it.
        if d.seq < state.seq || d.text.is_empty() {
            return;
        }
        let Some(item) = find_mut(&mut state.items, &d.item_id) else {
            return;
        };
        let text = match (item, d.kind) {
            (Item::AssistantMessage(m), DeltaEventKind::Text) => &mut m.text,
            (Item::Reasoning(r), DeltaEventKind::Reasoning) => &mut r.text,
            _ => return,
        };
        // The text from offset on. Some of it may be in already (a snapshot taken after the delta
        // was sent has it), and the rest is appended. One past the end of the text means deltas
        // were missed: it's skipped, and the item's final text puts it right.
        let have = utf16_len(text) as i64 - d.offset as i64;
        if have < 0 || have as usize >= utf16_len(&d.text) {
            return;
        }
        text.push_str(skip_utf16(&d.text, have as usize));
        return;
    }
    let seq = event.seq();
    if seq <= state.seq {
        return;
    }
    match event {
        ThreadEvent::ThreadUpdated(e) => state.thread = e.thread.clone(),
        ThreadEvent::TurnStarted(_) | ThreadEvent::TurnCompleted(_) | ThreadEvent::Delta(_) => {}
        ThreadEvent::ItemAdded(e) => match position(&state.items, e.item.id()) {
            Some(at) => state.items[at] = e.item.clone(),
            None => state.items.push(e.item.clone()),
        },
        ThreadEvent::ItemUpdated(e) => {
            if let Some(item) = find_mut(&mut state.items, &e.item_id) {
                patch_item(item, &e.patch);
            }
        }
        ThreadEvent::ItemsRemoved(e) => state.items.retain(|i| !e.item_ids.iter().any(|id| id == i.id())),
        ThreadEvent::RequestOpened(e) => match state.requests.iter().rposition(|r| r.id() == e.request.id()) {
            Some(at) => state.requests[at] = e.request.clone(),
            None => state.requests.push(e.request.clone()),
        },
        ThreadEvent::RequestResolved(e) => {
            if let Some(at) = state.requests.iter().rposition(|r| r.id() == e.request_id) {
                state.requests.remove(at);
            }
        }
    }
    state.seq = seq;
}

/// Applies each of `events` in turn.
pub fn apply_events<'a>(state: &mut Snapshot, events: impl IntoIterator<Item = &'a ThreadEvent>) {
    for event in events {
        apply_event(state, event);
    }
}

/// Whether `event` shows that saved events before it were missed: it's saved, and its seq is more
/// than one past the state's. A client that sees one should catch up from `state.seq`, or take a
/// fresh snapshot, rather than apply it.
pub fn is_gap(state: &Snapshot, event: &ThreadEvent) -> bool {
    !matches!(event, ThreadEvent::Delta(_)) && event.thread_id() == state.thread.id && event.seq() > state.seq + 1
}

/// The item with the patch's fields set, and those set to null removed; `id` and `type` stay. A
/// patch that would make it invalid leaves it as it was.
pub(crate) fn patch_item(item: &mut Item, patch: &Map<String, Value>) {
    let Ok(Value::Object(mut fields)) = serde_json::to_value(&*item) else {
        return;
    };
    for (k, v) in patch {
        if k == "id" || k == "type" {
            continue;
        }
        if v.is_null() {
            fields.remove(k);
        } else {
            fields.insert(k.clone(), v.clone());
        }
    }
    if let Ok(next) = serde_json::from_value(Value::Object(fields)) {
        *item = next;
    }
}

fn position(items: &[Item], id: &str) -> Option<usize> {
    // Updates are nearly always to recent items, so look from the end.
    items.iter().rposition(|i| i.id() == id)
}

fn find_mut<'a>(items: &'a mut [Item], id: &str) -> Option<&'a mut Item> {
    items.iter_mut().rev().find(|i| i.id() == id)
}

/// A string's length as JavaScript counts it (UTF-16 code units), which deltas' offsets are in.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s` without its first `n` UTF-16 code units (rounded up to a whole character).
fn skip_utf16(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (at, c) in s.char_indices() {
        if units >= n {
            return &s[at..];
        }
        units += c.len_utf16();
    }
    ""
}

impl Item {
    pub fn id(&self) -> &str {
        match self {
            Item::UserMessage(i) => &i.id,
            Item::AssistantMessage(i) => &i.id,
            Item::Reasoning(i) => &i.id,
            Item::ToolCall(i) => &i.id,
            Item::Compaction(i) => &i.id,
            Item::Notice(i) => &i.id,
            Item::TurnResult(i) => &i.id,
        }
    }

    pub fn parent_id(&self) -> Option<&str> {
        match self {
            Item::UserMessage(i) => i.parent_id.as_deref(),
            Item::AssistantMessage(i) => i.parent_id.as_deref(),
            Item::Reasoning(i) => i.parent_id.as_deref(),
            Item::ToolCall(i) => i.parent_id.as_deref(),
            Item::Compaction(i) => i.parent_id.as_deref(),
            Item::Notice(i) => i.parent_id.as_deref(),
            Item::TurnResult(i) => i.parent_id.as_deref(),
        }
    }

    pub fn turn_id(&self) -> Option<&str> {
        match self {
            Item::UserMessage(i) => i.turn_id.as_deref(),
            Item::AssistantMessage(i) => i.turn_id.as_deref(),
            Item::Reasoning(i) => i.turn_id.as_deref(),
            Item::ToolCall(i) => i.turn_id.as_deref(),
            Item::Compaction(i) => i.turn_id.as_deref(),
            Item::Notice(i) => i.turn_id.as_deref(),
            Item::TurnResult(i) => i.turn_id.as_deref(),
        }
    }

    /// The text of an `assistant_message` or `reasoning`, which deltas stream into.
    pub fn streamed_text(&self) -> Option<&str> {
        match self {
            Item::AssistantMessage(i) => Some(&i.text),
            Item::Reasoning(i) => Some(&i.text),
            _ => None,
        }
    }
}

impl ThreadRequest {
    pub fn id(&self) -> &str {
        match self {
            ThreadRequest::Permission(r) => &r.id,
            ThreadRequest::Question(r) => &r.id,
        }
    }

    pub fn turn_id(&self) -> Option<&str> {
        match self {
            ThreadRequest::Permission(r) => r.turn_id.as_deref(),
            ThreadRequest::Question(r) => r.turn_id.as_deref(),
        }
    }
}

impl ThreadEvent {
    pub fn thread_id(&self) -> &str {
        match self {
            ThreadEvent::ThreadUpdated(e) => &e.thread_id,
            ThreadEvent::TurnStarted(e) => &e.thread_id,
            ThreadEvent::TurnCompleted(e) => &e.thread_id,
            ThreadEvent::ItemAdded(e) => &e.thread_id,
            ThreadEvent::ItemUpdated(e) => &e.thread_id,
            ThreadEvent::ItemsRemoved(e) => &e.thread_id,
            ThreadEvent::Delta(e) => &e.thread_id,
            ThreadEvent::RequestOpened(e) => &e.thread_id,
            ThreadEvent::RequestResolved(e) => &e.thread_id,
        }
    }

    /// The event's seq: a saved event's own, or for a delta, the last saved event's before it.
    pub fn seq(&self) -> u64 {
        match self {
            ThreadEvent::ThreadUpdated(e) => e.seq.get(),
            ThreadEvent::TurnStarted(e) => e.seq.get(),
            ThreadEvent::TurnCompleted(e) => e.seq.get(),
            ThreadEvent::ItemAdded(e) => e.seq.get(),
            ThreadEvent::ItemUpdated(e) => e.seq.get(),
            ThreadEvent::ItemsRemoved(e) => e.seq.get(),
            ThreadEvent::Delta(e) => e.seq,
            ThreadEvent::RequestOpened(e) => e.seq.get(),
            ThreadEvent::RequestResolved(e) => e.seq.get(),
        }
    }
}
