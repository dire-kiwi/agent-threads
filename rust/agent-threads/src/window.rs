//! Windows of a thread's state, and pages of the items before them: the same rules as `window.ts`
//! in `@dire-kiwi/agent-threads-protocol` (spec/PROTOCOL.md, "Windows"). A thread can run to
//! thousands of items, so a client starts from its last ones and loads earlier ones a page at a
//! time. Items are only ever added at the end of the list, so an item's index in it never changes,
//! and windows and pages say where they are by index.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use crate::protocol::{Item, ItemPage, Snapshot, SubagentStatus, ThreadRequest, ToolKind, ToolStatus};

/// The window of `state` with its last `limit` items, and what they need from before them: the
/// subagent calls they and the open requests belong to, and the open requests' tool calls. With a
/// limit it's within, it's (a clone of) the state itself. `state` must be whole (not a window).
pub fn snapshot_window(state: &Snapshot, limit: usize) -> Snapshot {
    let items = &state.items;
    if items.len() <= limit {
        return state.clone();
    }
    let start = items.len() - limit;
    let at = indices(items);
    let mut need: Vec<&str> = items[start..].iter().filter_map(Item::parent_id).collect();
    for r in state.requests.iter().filter(|r| r.is_open()) {
        need.extend(r.parent_id());
        need.extend(r.tool_call_id());
    }
    // A subagent that's quiet now may go on: its items would come with no call to hang them from.
    need.extend(items[..start].iter().filter(|i| is_running_subagent(i)).map(Item::id));
    let context = context_of(items, &at, need, start);
    Snapshot {
        thread: state.thread.clone(),
        items: context
            .iter()
            .map(|&i| items[i].clone())
            .chain(items[start..].iter().cloned())
            .collect(),
        requests: state
            .requests
            .iter()
            .filter(|r| r.is_open() || anchor(items, &at, r).is_none_or(|a| a >= start))
            .cloned()
            .collect(),
        seq: state.seq,
        start: Some(start as u64),
        context: context.into_iter().map(|i| i as u64).collect(),
    }
}

/// The page of `state`'s items before index `before` (a window's start), at most `limit` of them,
/// with what they need from before them (the subagent calls they belong to) and the requests they
/// have. `state` must be whole.
pub fn item_page(state: &Snapshot, before: u64, limit: usize) -> ItemPage {
    let items = &state.items;
    let end = usize::try_from(before).unwrap_or(usize::MAX).min(items.len());
    let start = end.saturating_sub(limit);
    let at = indices(items);
    let need: Vec<&str> = items[start..end].iter().filter_map(Item::parent_id).collect();
    let context = context_of(items, &at, need, start);
    ItemPage {
        thread_id: state.thread.id.clone(),
        items: context
            .iter()
            .map(|&i| items[i].clone())
            .chain(items[start..end].iter().cloned())
            .collect(),
        requests: state
            .requests
            .iter()
            .filter(|r| anchor(items, &at, r).is_some_and(|a| a >= start && a < end))
            .cloned()
            .collect(),
        start: start as u64,
        context: context.into_iter().map(|i| i as u64).collect(),
        seq: state.seq,
    }
}

/// Puts `page`, the page before the start of `state` (a window), in front of its items: the context
/// items of both in order (the page's version of one they share), less those the page's own items
/// have, then the page's items, then its own. The page's requests go in front of its own, the
/// page's version of one it has replacing it in place. A page for another thread, or that doesn't
/// end at its start, changes nothing. Whether it was put in.
pub fn with_page(state: &mut Snapshot, page: ItemPage) -> bool {
    let before = state.start.unwrap_or(0);
    let theirs = page.context.len().min(page.items.len());
    let body_len = (page.items.len() - theirs) as u64;
    if page.thread_id != state.thread.id || before == 0 || page.start + body_len != before || page.start >= before {
        return false;
    }
    let ItemPage {
        items: mut page_items,
        context: page_context,
        requests: page_requests,
        start: page_start,
        ..
    } = page;
    let body = page_items.split_off(theirs);
    let fresh: HashSet<&str> = body.iter().map(Item::id).collect();
    let own = std::mem::take(&mut state.context);
    let mut items = std::mem::take(&mut state.items);
    let kept = items.split_off(own.len().min(items.len()));
    let mut ctx = BTreeMap::new();
    for (index, item) in own
        .into_iter()
        .zip(items)
        .chain(page_context.into_iter().zip(page_items))
    {
        if index < page_start && !fresh.contains(item.id()) {
            ctx.insert(index, item);
        }
    }
    let kept: Vec<Item> = kept.into_iter().filter(|i| !fresh.contains(i.id())).collect();
    state.context = if page_start == 0 {
        Vec::new()
    } else {
        ctx.keys().copied().collect()
    };
    state.items = ctx.into_values().chain(body).chain(kept).collect();
    state.start = (page_start != 0).then_some(page_start);

    let mut theirs: HashMap<String, ThreadRequest> = HashMap::new();
    let mut requests = Vec::new();
    for r in page_requests {
        if state.requests.iter().any(|s| s.id() == r.id()) {
            theirs.insert(r.id().to_string(), r);
        } else {
            requests.push(r);
        }
    }
    for r in std::mem::take(&mut state.requests) {
        requests.push(theirs.remove(r.id()).unwrap_or(r));
    }
    state.requests = requests;
    true
}

/// Where a request is in the thread's items: the index of its tool call, or else of the last item
/// of its turn; `None` if it has neither. A window or page has the requests whose anchor is in it.
pub fn request_anchor(items: &[Item], request: &ThreadRequest) -> Option<usize> {
    anchor(items, &indices(items), request)
}

fn anchor(items: &[Item], at: &HashMap<&str, usize>, r: &ThreadRequest) -> Option<usize> {
    if let Some(&call) = r.tool_call_id().filter(|id| !id.is_empty()).and_then(|id| at.get(id)) {
        return Some(call);
    }
    let turn = r.turn_id().filter(|t| !t.is_empty())?;
    items.iter().rposition(|i| i.turn_id() == Some(turn))
}

/// Each item's index by its id (the last, should two share one).
fn indices(items: &[Item]) -> HashMap<&str, usize> {
    items.iter().enumerate().map(|(i, item)| (item.id(), i)).collect()
}

/// Whether `item` is a subagent's call whose subagent hasn't finished: by its subagent's status
/// where it has one (a background subagent's call completes as soon as it has started it), or else
/// by the call's.
fn is_running_subagent(item: &Item) -> bool {
    let Item::ToolCall(c) = item else { return false };
    c.kind == ToolKind::Subagent
        && match &c.subagent {
            Some(s) => s.status == SubagentStatus::Running,
            None => matches!(c.status, ToolStatus::Pending | ToolStatus::Running),
        }
}

/// The indices before `start` of the items with an id in `need`, and of their parents, however
/// nested; ascending.
fn context_of<'a>(items: &'a [Item], at: &HashMap<&str, usize>, need: Vec<&'a str>, start: usize) -> Vec<usize> {
    let mut out = BTreeSet::new();
    let mut seen = HashSet::new();
    for first in need {
        let mut id = Some(first);
        while let Some(i) = id
            .filter(|id| !id.is_empty() && seen.insert(*id))
            .and_then(|id| at.get(id))
        {
            if *i < start {
                out.insert(*i);
            }
            id = items[*i].parent_id();
        }
    }
    out.into_iter().collect()
}
