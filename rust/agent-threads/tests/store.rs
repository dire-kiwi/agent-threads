//! Every built-in store passes spec/conformance/store.json, as spec/conformance/store.md says to run
//! it; and the JSONL store copes with a crash mid-write.

mod common;

use std::sync::Arc;

use agent_threads::{FileStore, MemoryState, MemoryStore, RunRecord, SqliteStore, Store, StoreErrorKind};
use serde_json::{Value, json};

/// {"$": "NAME"} replaced with a copy of the value NAME.
fn resolve(v: &Value, values: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(|x| resolve(x, values)).collect()),
        Value::Object(o) if o.len() == 1 && o.get("$").is_some_and(Value::is_string) => {
            values[o["$"].as_str().unwrap()].clone()
        }
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), resolve(x, values))).collect()),
        _ => v.clone(),
    }
}

fn kind_name(k: &StoreErrorKind) -> &'static str {
    match k {
        StoreErrorKind::Exists => "exists",
        StoreErrorKind::NotFound => "not_found",
        StoreErrorKind::Invalid => "invalid",
        StoreErrorKind::Seq => "seq",
        StoreErrorKind::Failed => "failed",
    }
}

fn run(v: &Value) -> RunRecord {
    serde_json::from_value(v.clone()).unwrap()
}

/// Calls the operation named `op` with `args`; its result as JSON, or the error's kind.
async fn call(store: &dyn Store, op: &str, args: &[Value]) -> Result<Value, String> {
    let s = |i: usize| args[i].as_str().unwrap().to_string();
    let r = match op {
        "createThread" => store.create_thread(&args[0]).await.map(|_| Value::Null),
        "getThread" => store.get_thread(&s(0)).await.map(|t| t.unwrap_or(Value::Null)),
        "listThreads" => store.list_threads().await.map(Value::from),
        "updateThread" => store.update_thread(&args[0]).await.map(|_| Value::Null),
        "deleteThread" => store.delete_thread(&s(0)).await.map(Value::from),
        "appendEvents" => {
            let events = args[1].as_array().unwrap().clone();
            let runs: Vec<RunRecord> = args
                .get(2)
                .and_then(Value::as_array)
                .map(|a| a.iter().map(run).collect())
                .unwrap_or_default();
            store.append_events(&s(0), &events, &runs).await.map(|_| Value::Null)
        }
        "readEvents" => {
            let o = args.get(1).cloned().unwrap_or(json!({}));
            let after = o.get("after").and_then(Value::as_u64).unwrap_or(0);
            let limit = o.get("limit").and_then(Value::as_u64).map(|l| l as usize);
            store.read_events(&s(0), after, limit).await.map(Value::from)
        }
        "lastSeq" => store.last_seq(&s(0)).await.map(Value::from),
        "saveSnapshot" => store.save_snapshot(&s(0), &args[1]).await.map(|_| Value::Null),
        "loadSnapshot" => store.load_snapshot(&s(0)).await.map(|t| t.unwrap_or(Value::Null)),
        "putRun" => store.put_run(&run(&args[0])).await.map(|_| Value::Null),
        "getRun" => store.get_run(&s(0)).await.map(|r| serde_json::to_value(r).unwrap()),
        "activeRuns" => store.active_runs().await.map(|r| serde_json::to_value(r).unwrap()),
        _ => panic!("unknown op {op}"),
    };
    r.map_err(|e| kind_name(&e.kind).to_string())
}

type Opener = Box<dyn FnMut() -> Arc<dyn Store>>;
type Kind = (&'static str, bool, Box<dyn Fn() -> Opener>);

/// A way to open a store, and to open it again on the same data.
fn kinds() -> Vec<Kind> {
    vec![
        (
            "MemoryStore",
            false,
            Box::new(|| {
                let state = MemoryState::new();
                Box::new(move || Arc::new(MemoryStore::with_state(state.clone())) as Arc<dyn Store>) as Opener
            }),
        ),
        (
            "FileStore",
            true,
            Box::new(|| {
                let dir = common::temp_dir();
                Box::new(move || Arc::new(FileStore::open(&dir).unwrap()) as Arc<dyn Store>) as Opener
            }),
        ),
        (
            "SqliteStore",
            true,
            Box::new(|| {
                let path = common::temp_dir().join("threads.db");
                Box::new(move || Arc::new(SqliteStore::open(&path).unwrap()) as Arc<dyn Store>) as Opener
            }),
        ),
    ]
}

#[tokio::test]
async fn stores_pass_the_conformance_cases() {
    let suite = common::read_json("conformance/store.json");
    let values = &suite["values"];
    let mut failures = Vec::new();
    for (name, persistent, open) in kinds() {
        for case in suite["cases"].as_array().unwrap() {
            if case["persistent"].as_bool().unwrap_or(false) && !persistent {
                continue;
            }
            let mut opener = open();
            let mut store = opener();
            for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
                let op = step["op"].as_str().unwrap();
                let at = format!("{name} {}: step {} ({op})", case["name"], i + 1);
                if op == "reopen" {
                    store.close().await.unwrap();
                    store = opener();
                    continue;
                }
                let args = resolve(step.get("args").unwrap_or(&json!([])), values);
                let got = call(&*store, op, args.as_array().unwrap()).await;
                match (step.get("error").and_then(Value::as_str), got) {
                    (Some(want), Err(kind)) if kind == want => {}
                    (Some(want), other) => failures.push(format!("{at}: expected a {want} error, got {other:?}")),
                    (None, Err(kind)) => failures.push(format!("{at}: unexpected {kind} error")),
                    (None, Ok(v)) => {
                        let want = resolve(step.get("result").unwrap_or(&Value::Null), values);
                        if v != want {
                            failures.push(format!("{at}: got {v}, expected {want}"));
                        }
                    }
                }
            }
            store.close().await.unwrap();
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn file_store_drops_a_half_written_last_line() {
    let dir = common::temp_dir();
    let thread = json!({"id": "th_1", "harness": "claude", "status": "idle", "created_at": "2026-11-01T00:00:00Z"});
    let e1 = json!({"type": "turn.started", "thread_id": "th_1", "seq": 1, "turn_id": "t1"});
    {
        let store = FileStore::open(&dir).unwrap();
        store.create_thread(&thread).await.unwrap();
        store
            .append_events("th_1", std::slice::from_ref(&e1), &[])
            .await
            .unwrap();
        store.close().await.unwrap();
    }
    let file = std::fs::read_dir(&dir).unwrap().next().unwrap().unwrap().path();
    let mut f = std::fs::OpenOptions::new().append(true).open(&file).unwrap();
    std::io::Write::write_all(&mut f, br#"{"events":[{"type":"turn.comp"#).unwrap();
    drop(f);
    let store = FileStore::open(&dir).unwrap();
    assert_eq!(store.read_events("th_1", 0, None).await.unwrap(), vec![e1.clone()]);
    // And it carries on from there.
    let e2 = json!({"type": "turn.completed", "thread_id": "th_1", "seq": 2, "turn_id": "t1"});
    store
        .append_events("th_1", std::slice::from_ref(&e2), &[])
        .await
        .unwrap();
    drop(store);
    let store = FileStore::open(&dir).unwrap();
    assert_eq!(store.read_events("th_1", 0, None).await.unwrap(), vec![e1, e2]);
}
