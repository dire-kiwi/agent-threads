//! Each example in spec/examples reads into the generated types and writes back as the same JSON.

use std::fs;
use std::path::PathBuf;

use agent_threads::protocol::{Command, Item, Notice, NoticeLevel, Snapshot, ThreadEvent};
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
    let ThreadEvent::ItemAddedEvent(added) = event else {
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
    assert!(matches!(interrupt, Command::InterruptCommand(_)));
    assert!(serde_json::from_value::<Command>(json!({"type": "nope", "thread_id": "th"})).is_err());
    assert_eq!(
        serde_json::to_value(&interrupt).unwrap(),
        json!({"type": "interrupt", "thread_id": "th"})
    );
}
