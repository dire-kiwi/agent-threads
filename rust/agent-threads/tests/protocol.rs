//! Each example in spec/examples reads into the generated types and writes back as the same JSON.

use std::fs;
use std::path::PathBuf;

use agent_threads::protocol::{Command, InterruptCommand, Item, Notice, NoticeLevel, Snapshot, ThreadEvent};
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

#[test]
fn items_removed_removes_items_and_skips_ids_it_doesnt_have() {
    use agent_threads::reducer::{apply_events, initial_state};
    let event = |v: Value| serde_json::from_value::<ThreadEvent>(v).unwrap();
    let thread = serde_json::from_value(
        json!({"id": "th", "harness": "claude", "status": "idle", "created_at": "2026-11-01T00:00:00Z"}),
    )
    .unwrap();
    let mut state = initial_state(thread);
    let added = |seq: u64, id: &str| {
        event(
            json!({"type": "item.added", "thread_id": "th", "seq": seq, "item": {"id": id, "type": "notice", "level": "info", "text": id}}),
        )
    };
    let removed = event(json!({"type": "items.removed", "thread_id": "th", "seq": 4, "item_ids": ["b", "nope"]}));
    apply_events(&mut state, &[added(1, "a"), added(2, "b"), added(3, "c"), removed]);
    let ids: Vec<&str> = state.items.iter().map(|i| i.id()).collect();
    assert_eq!(ids, ["a", "c"]);
    assert_eq!(state.seq, 4);
}
