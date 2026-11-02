//! Each example in spec/examples reads into the generated types and writes back as the same JSON;
//! the reducer's requests, and windows and pages, as the protocol package's tests have them.

use std::fs;
use std::path::PathBuf;

use agent_threads::protocol::{
    Command, InterruptCommand, Item, ItemPage, Notice, NoticeLevel, Snapshot, ThreadEvent, ThreadRequest,
};
use agent_threads::reducer::{apply_event, initial_state, open_requests};
use agent_threads::window::{item_page, request_anchor, snapshot_window, with_page};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn spec(path: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spec").join(path);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn round_trip<T: Serialize + DeserializeOwned>(json: &str) {
    let value: T = serde_json::from_str(json).unwrap_or_else(|e| panic!("{json}: {e}"));
    let out = serde_json::to_value(&value).unwrap();
    let want: Value = serde_json::from_str(json).unwrap();
    assert_eq!(out, want, "round trip changed {json}");
}

#[test]
fn examples_round_trip() {
    for line in spec("examples/thread.events.jsonl")
        .lines()
        .filter(|l| !l.trim().is_empty())
    {
        round_trip::<ThreadEvent>(line);
    }
    for line in spec("examples/commands.jsonl").lines().filter(|l| !l.trim().is_empty()) {
        round_trip::<Command>(line);
    }
    round_trip::<Snapshot>(&spec("examples/thread.snapshot.json"));
    round_trip::<Snapshot>(&spec("examples/thread.window.json"));
    round_trip::<ItemPage>(&spec("examples/thread.page.json"));
}

#[test]
fn unions_are_tagged_by_type() {
    let event: ThreadEvent = serde_json::from_value(json!({
        "type": "item.added", "thread_id": "th", "seq": 1,
        "item": {"id": "n", "type": "notice", "level": "info", "text": "hi"}
    }))
    .unwrap();
    let ThreadEvent::ItemAdded(added) = event else {
        panic!("got {event:?}")
    };
    let Item::Notice(Notice {
        level: NoticeLevel::Info,
        ..
    }) = added.item
    else {
        panic!("got {:?}", added.item)
    };

    // A variant is picked by its type, not by which fields fit.
    let interrupt: Command =
        serde_json::from_value(json!({"type": "interrupt", "thread_id": "th", "text": "hi"})).unwrap();
    assert!(matches!(interrupt, Command::Interrupt(_)));
    let from = Command::from(InterruptCommand { thread_id: "th".into() });
    assert!(matches!(from, Command::Interrupt(_)));
    assert!(serde_json::from_value::<Command>(json!({"type": "nope", "thread_id": "th"})).is_err());
    assert_eq!(
        serde_json::to_value(&interrupt).unwrap(),
        json!({"type": "interrupt", "thread_id": "th"})
    );
}

fn from<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn value(v: impl Serialize) -> Value {
    serde_json::to_value(v).unwrap()
}

fn event(v: Value) -> ThreadEvent {
    from(v)
}

fn thread() -> Value {
    json!({"id": "th", "harness": "claude", "status": "waiting", "created_at": "2026-11-01T00:00:00Z"})
}

#[test]
fn resolved_requests_stay_with_their_resolution() {
    let mut s = initial_state(from(thread()));
    let p1 = json!({"id": "p1", "type": "permission", "name": "Bash", "kind": "shell", "input": {}});
    let q1 = json!({"id": "q1", "type": "question", "questions": []});
    apply_event(
        &mut s,
        &event(json!({"type": "request.opened", "thread_id": "th", "seq": 1, "request": p1})),
    );
    apply_event(
        &mut s,
        &event(json!({"type": "request.opened", "thread_id": "th", "seq": 2, "request": q1})),
    );
    assert_eq!(value(&s.requests), json!([p1, q1]));
    assert_eq!(open_requests(&s).count(), 2);

    let resolved = |seq: u64, id: &str, outcome: &str| {
        event(
            json!({"type": "request.resolved", "thread_id": "th", "seq": seq, "request_id": id, "resolution": {"outcome": outcome}}),
        )
    };
    apply_event(&mut s, &resolved(3, "p1", "allow"));
    // It stays where it was, with its resolution.
    let mut p1_allowed = p1.clone();
    p1_allowed["resolution"] = json!({"outcome": "allow"});
    assert_eq!(value(&s.requests), json!([p1_allowed, q1]));
    assert_eq!(open_requests(&s).map(ThreadRequest::id).collect::<Vec<_>>(), ["q1"]);
    assert!(!s.requests[0].is_open());

    apply_event(&mut s, &resolved(4, "p1", "deny"));
    assert_eq!(value(&s.requests)[0]["resolution"], json!({"outcome": "deny"}));
    let before = value(&s.requests);
    apply_event(&mut s, &resolved(5, "nope", "allow"));
    assert_eq!((value(&s.requests), s.seq), (before, 5));

    // Opened again with its id, it's replaced in place, and open again.
    apply_event(
        &mut s,
        &event(json!({"type": "request.opened", "thread_id": "th", "seq": 6, "request": p1})),
    );
    assert_eq!(value(&s.requests), json!([p1, q1]));
    assert_eq!(open_requests(&s).count(), 2);
}

fn msg(id: &str, parent: Option<&str>, turn: &str) -> Value {
    let mut m = json!({"id": id, "type": "assistant_message", "text": id, "turn_id": turn});
    if let Some(p) = parent {
        m["parent_id"] = json!(p);
    }
    m
}

fn agent(id: &str, parent: Option<&str>) -> Value {
    let mut a = json!({"id": id, "type": "tool_call", "name": "Agent", "kind": "subagent", "input": {}, "status": "running", "turn_id": "t1"});
    if let Some(p) = parent {
        a["parent_id"] = json!(p);
    }
    a
}

fn permission(id: &str, extra: Value) -> Value {
    let mut r = json!({"id": id, "type": "permission", "name": "Bash", "kind": "shell", "input": {}, "turn_id": "t1"});
    r.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    r
}

/// 0 m0, 1 sa (a subagent), 2 m2, 3 sb (sa's subagent), 4 m4, 5 b1 (sb's), 6 m6, 7 tc (sa's call),
/// 8 m8, 9 m9 (turn t2); requests: p-old answered at m2, p-sa open from sa for tc, p-new answered
/// at m8, p-turn answered with no call (turn t2: anchored at m9), p-none answered with neither.
fn state() -> Snapshot {
    from(json!({
        "thread": thread(),
        "items": [
            msg("m0", None, "t1"),
            agent("sa", None),
            msg("m2", None, "t1"),
            agent("sb", Some("sa")),
            msg("m4", None, "t1"),
            msg("b1", Some("sb"), "t1"),
            msg("m6", None, "t1"),
            {"id": "tc", "type": "tool_call", "name": "Bash", "kind": "shell", "input": {}, "status": "pending", "parent_id": "sa", "turn_id": "t1"},
            msg("m8", None, "t1"),
            msg("m9", None, "t2"),
        ],
        "requests": [
            permission("p-old", json!({"tool_call_id": "m2", "resolution": {"outcome": "allow"}})),
            permission("p-sa", json!({"tool_call_id": "tc", "parent_id": "sa"})),
            permission("p-new", json!({"tool_call_id": "m8", "resolution": {"outcome": "deny"}})),
            permission("p-turn", json!({"turn_id": "t2", "resolution": {"outcome": "cancel"}})),
            permission("p-none", json!({"turn_id": "t9", "resolution": {"outcome": "cancel"}})),
        ],
        "seq": 20,
    }))
}

fn no_requests() -> Snapshot {
    Snapshot {
        requests: Vec::new(),
        ..state()
    }
}

fn ids(v: &Value) -> Vec<&str> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x["id"].as_str().unwrap())
        .collect()
}

#[test]
fn a_window_with_a_limit_its_within_is_the_state() {
    let s = state();
    assert_eq!(value(snapshot_window(&s, 10)), value(&s));
    assert_eq!(value(snapshot_window(&s, 50)), value(&s));
}

#[test]
fn a_window_has_the_last_items_the_parents_they_and_open_requests_need_and_the_requests_anchored_in_it() {
    let w = value(snapshot_window(&state(), 2));
    assert_eq!(w["start"], 8);
    // p-sa is open: its call (tc) and its subagent (sa) come too.
    assert_eq!(w["context"], json!([1, 7]));
    assert_eq!(ids(&w["items"]), ["sa", "tc", "m8", "m9"]);
    assert_eq!(ids(&w["requests"]), ["p-sa", "p-new", "p-turn", "p-none"]);
    assert_eq!(w["seq"], 20);
    assert_eq!(w["thread"], thread());
}

#[test]
fn a_window_brings_the_subagents_its_items_belong_to_however_nested() {
    let w = value(snapshot_window(&no_requests(), 5));
    assert_eq!(w["start"], 5);
    assert_eq!(w["context"], json!([1, 3]));
    assert_eq!(ids(&w["items"]), ["sa", "sb", "b1", "m6", "tc", "m8", "m9"]);
}

#[test]
fn a_window_leaves_context_out_when_it_needs_nothing_from_before_it() {
    assert_eq!(
        value(snapshot_window(&no_requests(), 1)),
        json!({"thread": thread(), "items": [msg("m9", None, "t2")], "requests": [], "seq": 20, "start": 9})
    );
}

#[test]
fn a_page_has_the_items_before_an_index_the_parents_they_need_and_the_requests_anchored_in_them() {
    let p = value(item_page(&state(), 6, 2));
    assert_eq!(
        (&p["thread_id"], &p["start"], &p["context"], &p["seq"]),
        (&json!("th"), &json!(4), &json!([1, 3]), &json!(20))
    );
    assert_eq!(ids(&p["items"]), ["sa", "sb", "m4", "b1"]);
    assert_eq!(p["requests"], json!([]));
    let q = value(item_page(&state(), 4, 4));
    assert_eq!((&q["start"], &q["context"]), (&json!(0), &json!([])));
    assert_eq!(ids(&q["items"]), ["m0", "sa", "m2", "sb"]);
    assert_eq!(ids(&q["requests"]), ["p-old"]);
}

#[test]
fn a_page_keeps_within_the_list() {
    assert_eq!(item_page(&state(), 50, 1).start, 9);
    let p = item_page(&state(), 0, 5);
    assert_eq!((p.start, p.items.len(), p.context.len()), (0, 0, 0));
}

#[test]
fn pages_go_in_front_of_a_window_until_its_whole() {
    let whole = state();
    let mut w = snapshot_window(&whole, 2);
    for limit in [3, 2] {
        let page = item_page(&whole, w.start.unwrap(), limit);
        let start = page.start as usize;
        assert!(with_page(&mut w, page));
        // The same as a window that had that many to begin with.
        assert_eq!(value(&w), value(snapshot_window(&whole, whole.items.len() - start)));
    }
    assert_eq!(w.start, Some(3));
    assert!(with_page(&mut w, item_page(&whole, 3, 10)));
    assert_eq!(value(&w), value(&whole));
    let w = value(&w);
    assert!(w.get("start").is_none() && w.get("context").is_none());
}

#[test]
fn a_page_and_a_windows_context_are_ordered_by_index() {
    // A window whose context is sa (1); a page from 4 whose context is sa and sb (1, 3).
    let mut w = snapshot_window(&no_requests(), 4);
    assert_eq!(w.context, [1]);
    assert!(with_page(&mut w, item_page(&state(), 6, 2)));
    assert_eq!((w.start, &w.context[..]), (Some(4), &[1, 3][..]));
    assert_eq!(ids(&value(&w.items)), ["sa", "sb", "m4", "b1", "m6", "tc", "m8", "m9"]);
}

#[test]
fn with_page_takes_the_pages_version_of_an_item_or_request_it_has() {
    let whole = state();
    let mut w = snapshot_window(&whole, 2);
    let mut later = whole.clone();
    apply_event(
        &mut later,
        &event(
            json!({"type": "item.updated", "thread_id": "th", "seq": 21, "item_id": "sa", "patch": {"status": "completed"}}),
        ),
    );
    let mut page = item_page(&later, 8, 1);
    // A newer version of a request the window has, too.
    let mut p_sa = value(&page.requests[0]);
    assert_eq!(p_sa["id"], "p-sa");
    p_sa["title"] = json!("newer");
    page.requests[0] = from(p_sa.clone());
    assert!(with_page(&mut w, page));
    let w = value(&w);
    assert_eq!(
        (&w["items"][0]["id"], &w["items"][0]["status"]),
        (&json!("sa"), &json!("completed"))
    );
    assert_eq!(w["seq"], 20);
    assert_eq!(ids(&w["requests"]), ["p-sa", "p-new", "p-turn", "p-none"]);
    assert_eq!(w["requests"][0], p_sa);
}

#[test]
fn with_page_ignores_a_page_for_another_thread_or_that_doesnt_end_at_its_start() {
    let whole = state();
    let w = snapshot_window(&whole, 2);
    let mut x = w.clone();
    assert!(!with_page(&mut x, item_page(&whole, 7, 2)));
    let other = ItemPage {
        thread_id: "other".into(),
        ..item_page(&whole, 8, 2)
    };
    assert!(!with_page(&mut x, other));
    assert_eq!(value(&x), value(&w));
    let mut y = whole.clone();
    assert!(!with_page(&mut y, item_page(&whole, 0, 2)));
    assert_eq!(value(&y), value(&whole));
}

#[test]
fn events_apply_to_a_window_as_to_any_state() {
    let mut w = snapshot_window(&state(), 2);
    apply_event(
        &mut w,
        &event(json!({"type": "item.added", "thread_id": "th", "seq": 21, "item": msg("m10", None, "t1")})),
    );
    assert_eq!((w.start, &w.context[..]), (Some(8), &[1, 7][..]));
    assert_eq!(w.items.last().unwrap().id(), "m10");
    // An update to an item it doesn't have only advances seq.
    let items = value(&w.items);
    apply_event(
        &mut w,
        &event(json!({"type": "item.updated", "thread_id": "th", "seq": 22, "item_id": "m0", "patch": {"text": "x"}})),
    );
    assert_eq!((value(&w.items), w.seq), (items, 22));
}

#[test]
fn a_requests_anchor_is_its_tool_call_else_the_last_item_of_its_turn() {
    let s = state();
    let anchors: Vec<_> = s.requests.iter().map(|r| request_anchor(&s.items, r)).collect();
    assert_eq!(anchors, [Some(2), Some(7), Some(8), Some(9), None]);
}

#[test]
fn the_spec_examples_window_and_page() {
    let whole: Snapshot = serde_json::from_str(&spec("examples/thread.snapshot.json")).unwrap();
    let window: Value = serde_json::from_str(&spec("examples/thread.window.json")).unwrap();
    let page: Value = serde_json::from_str(&spec("examples/thread.page.json")).unwrap();
    // thread.window.json is the snapshot's window of 8, and thread.page.json its page of 3 before 5.
    assert_eq!(value(snapshot_window(&whole, 8)), window);
    assert_eq!(value(item_page(&whole, 5, 3)), page);
    // The window with the page is the window of 11.
    let mut w: Snapshot = from(window);
    assert!(with_page(&mut w, from(page)));
    assert_eq!(value(&w), value(snapshot_window(&whole, 11)));
    // Folding its events gives it, resolved requests and all.
    let mut folded = initial_state(whole.thread.clone());
    for line in spec("examples/thread.events.jsonl")
        .lines()
        .filter(|l| !l.trim().is_empty())
    {
        apply_event(&mut folded, &serde_json::from_str(line).unwrap());
    }
    assert_eq!(value(&folded.requests), value(&whole.requests));
    assert_eq!(open_requests(&whole).count(), 0);
}
