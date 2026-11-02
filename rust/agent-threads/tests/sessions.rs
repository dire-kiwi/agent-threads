//! Sessions: where each turn leaves the harness's session, and rewind, new_session and compact,
//! against a fake harness whose turns the test ends (the recorded fixtures have the real CLIs'). As
//! the Node backend's sessions.test.ts does.

use std::any::Any;
use std::sync::{Arc, Mutex};

use agent_threads::protocol::TurnSession;
use agent_threads::reducer::{apply_events, initial_state};
use agent_threads::{
    AgentThreads, BoxFuture, Command, CreateOptions, Error, Harness, HarnessSession, MemoryStore, Message, Options,
    PermissionPolicy, RewindError, RewindPoint, SendOptions, SessionJob, ThreadContext, ThreadEvent, TurnEnd,
    resume_at_point, revert_point,
};
use serde_json::{Value, json};
use tokio::sync::broadcast;

type Point = fn(&[Option<TurnSession>], usize) -> Result<RewindPoint, RewindError>;
type Poster = Box<dyn Fn(SessionJob<Fake>) -> bool + Send + Sync>;
/// A backend, what its harness was asked to do, and how to post to its thread's session.
type Backend = (AgentThreads, Arc<Mutex<Counts>>, Arc<Mutex<Option<Poster>>>);

/// What the fake harness was asked to do.
#[derive(Default)]
struct Counts {
    compacts: usize,
    changes: usize,
}

/// A harness session whose turns the test ends, with the session it says.
struct Fake {
    point: Point,
    counts: Arc<Mutex<Counts>>,
}

impl HarnessSession for Fake {
    fn start(&mut self, _: &mut ThreadContext, _: Vec<Message>) {}
    fn steer(&mut self, _: &mut ThreadContext, _: Message) {}
    fn carry_over(&mut self, _: &mut ThreadContext, _: Vec<Message>) {}
    fn interrupt(&mut self, _: &mut ThreadContext) {}
    fn live(&self) -> bool {
        false
    }
    fn release(&mut self, _: &mut ThreadContext) {}
    fn options_changed(&mut self, _: &mut ThreadContext) {
        self.counts.lock().unwrap().changes += 1;
    }
    fn close(&mut self, _: &mut ThreadContext) -> BoxFuture<()> {
        Box::pin(async {})
    }
    fn can_compact(&self) -> bool {
        true
    }
    fn compact(&mut self, _: &mut ThreadContext) {
        self.counts.lock().unwrap().compacts += 1;
    }
    fn rewind_point(&self, sessions: &[Option<TurnSession>], index: usize) -> Option<Result<RewindPoint, RewindError>> {
        Some((self.point)(sessions, index))
    }
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

struct FakeHarness {
    point: Point,
    counts: Arc<Mutex<Counts>>,
    poster: Arc<Mutex<Option<Poster>>>,
}

impl Harness for FakeHarness {
    fn name(&self) -> &str {
        "fake"
    }
    fn open(&self, ctx: &ThreadContext) -> Box<dyn HarnessSession> {
        *self.poster.lock().unwrap() = Some(Box::new(ctx.poster::<Fake>()));
        Box::new(Fake {
            point: self.point,
            counts: self.counts.clone(),
        })
    }
}

struct Env {
    sdk: AgentThreads,
    id: String,
    counts: Arc<Mutex<Counts>>,
    poster: Arc<Mutex<Option<Poster>>>,
    rx: broadcast::Receiver<ThreadEvent>,
    events: Vec<ThreadEvent>,
}

async fn setup(point: Point, session_id: Option<&str>) -> Env {
    setup_in(point, session_id, Arc::new(MemoryStore::new())).await
}

/// A backend with the fake harness on `store`.
fn backend(point: Point, store: Arc<MemoryStore>) -> Backend {
    let counts = Arc::<Mutex<Counts>>::default();
    let poster = Arc::<Mutex<Option<Poster>>>::default();
    let harness = FakeHarness {
        point,
        counts: counts.clone(),
        poster: poster.clone(),
    };
    let sdk = AgentThreads::new(Options {
        store: Some(store),
        harnesses: vec![Arc::new(harness)],
        capabilities: agent_threads::Capabilities {
            permissions: Some(PermissionPolicy::allow()),
            ..Default::default()
        },
        ..Default::default()
    });
    (sdk, counts, poster)
}

async fn setup_in(point: Point, session_id: Option<&str>, store: Arc<MemoryStore>) -> Env {
    let (sdk, counts, poster) = backend(point, store);
    let rx = sdk.subscribe();
    let thread = sdk
        .create(CreateOptions {
            session_id: session_id.map(String::from),
            ..Default::default()
        })
        .await
        .unwrap();
    Env {
        sdk,
        id: thread.id,
        counts,
        poster,
        rx,
        events: Vec::new(),
    }
}

impl Env {
    /// Runs `f` with the thread's context, as the harness would; the next command comes after it.
    fn harness(&self, f: impl FnOnce(&mut ThreadContext) + Send + 'static) {
        let poster = self.poster.lock().unwrap();
        assert!((poster.as_ref().unwrap())(Box::new(move |_, ctx| f(ctx))));
    }

    /// A turn: it runs in `session` (a new one if the thread has none), and the harness marks it
    /// `at`.
    async fn turn(&self, text: &str, session: Option<&str>, at: Option<&str>) {
        self.sdk.send(&self.id, text, SendOptions::default()).await.unwrap();
        let (text, session, at) = (text.to_string(), session.map(String::from), at.map(String::from));
        self.harness(move |ctx| {
            if let Some(s) = session {
                ctx.set_thread(|t| t.session_id = Some(s));
            }
            ctx.add_item(
                json!({"id": format!("a-{text}"), "type": "assistant_message", "text": format!("re: {text}")}),
            );
            ctx.end_turn(
                TurnEnd {
                    ok: true,
                    session_at: at,
                    ..Default::default()
                },
                false,
            );
        });
    }

    async fn snap(&self) -> Value {
        serde_json::to_value(self.sdk.snapshot(&self.id).await.unwrap()).unwrap()
    }

    fn events(&mut self) -> &[ThreadEvent] {
        while let Ok(e) = self.rx.try_recv() {
            self.events.push(e);
        }
        &self.events
    }

    fn changes(&self) -> usize {
        self.counts.lock().unwrap().changes
    }
}

fn items(s: &Value) -> &Vec<Value> {
    s["items"].as_array().unwrap()
}

fn results(s: &Value) -> Vec<&Value> {
    items(s).iter().filter(|i| i["type"] == "turn_result").collect()
}

fn turn_ids(s: &Value) -> Vec<String> {
    results(s)
        .iter()
        .map(|r| r["turn_id"].as_str().unwrap().to_string())
        .collect()
}

/// Each turn_result's session (null for none).
fn sessions(s: &Value) -> Vec<Value> {
    results(s).iter().map(|r| r["session"].clone()).collect()
}

/// The items' types, with a notice's code instead.
fn kinds(s: &Value) -> Vec<String> {
    items(s)
        .iter()
        .map(|i| {
            let k = if i["type"] == "notice" { &i["code"] } else { &i["type"] };
            k.as_str().unwrap().to_string()
        })
        .collect()
}

fn refused(r: agent_threads::Result<()>, what: &str) {
    match r {
        Err(Error::Command(m)) => assert!(m.contains(what), "{m:?} doesn't say {what:?}"),
        other => panic!("not refused with {what:?}: {other:?}"),
    }
}

// ---------- a turn_result's session ----------

#[tokio::test]
async fn a_turn_results_session_has_the_session_the_turn_ended_in_its_mark_and_whether_it_started_it() {
    let env = setup(resume_at_point, None).await;
    env.turn("one", Some("S1"), Some("m1")).await;
    env.turn("two", None, Some("m2")).await;
    env.turn("three", None, None).await; // no mark
    env.sdk.new_session(&env.id).await.unwrap();
    env.turn("four", Some("S2"), Some("m4")).await;
    assert_eq!(
        sessions(&env.snap().await),
        vec![
            json!({"id": "S1", "at": "m1", "started": true}),
            json!({"id": "S1", "at": "m2"}),
            json!({"id": "S1"}),
            json!({"id": "S2", "at": "m4", "started": true}),
        ]
    );
}

#[tokio::test]
async fn a_turn_results_session_is_left_out_when_the_turn_ended_with_no_session() {
    let env = setup(resume_at_point, None).await;
    env.turn("one", None, None).await;
    assert_eq!(sessions(&env.snap().await), vec![Value::Null]);
}

// ---------- rewind ----------

#[tokio::test]
async fn rewind_removes_the_turns_items_and_later_turns_and_resumes_at_the_turn_befores_mark() {
    let mut env = setup(resume_at_point, None).await;
    env.turn("one", Some("S1"), Some("m1")).await;
    env.turn("two", None, Some("m2")).await;
    env.turn("three", None, Some("m3")).await;
    let before = env.snap().await;
    let t2 = turn_ids(&before)[1].clone();
    let changes = env.changes();
    env.sdk.rewind(&env.id, &t2).await.unwrap();
    let s = env.snap().await;
    assert_eq!(
        kinds(&s),
        ["user_message", "assistant_message", "turn_result", "rewind"]
    );
    let notice = items(&s).last().unwrap();
    assert_eq!((&notice["type"], &notice["level"]), (&json!("notice"), &json!("info")));
    assert_eq!(
        (&s["thread"]["session_id"], &s["thread"]["resume_at"]),
        (&json!("S1"), &json!("m1"))
    );
    assert_eq!(env.changes(), changes + 1);
    let removed: Vec<String> = env
        .events()
        .iter()
        .find_map(|e| match e {
            ThreadEvent::ItemsRemoved(e) => Some(e.item_ids.clone()),
            _ => None,
        })
        .unwrap();
    let want: Vec<String> = items(&before)[3..]
        .iter()
        .map(|i| i["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(removed, want);
    // Its snapshot is its events, folded.
    let all = env.events().to_vec();
    let ThreadEvent::ThreadUpdated(first) = &all[0] else {
        panic!("the first event isn't a thread.updated")
    };
    let mut folded = initial_state(first.thread.clone());
    apply_events(&mut folded, &all);
    assert_eq!(s, serde_json::to_value(&folded).unwrap());
}

#[tokio::test]
async fn rewind_to_before_a_sessions_first_turn_starts_a_new_one() {
    let env = setup(resume_at_point, None).await;
    env.turn("one", Some("S1"), Some("m1")).await;
    env.turn("two", None, Some("m2")).await;
    let t1 = turn_ids(&env.snap().await)[0].clone();
    env.sdk.rewind(&env.id, &t1).await.unwrap();
    let s = env.snap().await;
    assert!(s["thread"].get("session_id").is_none());
    assert!(s["thread"].get("resume_at").is_none());
    assert_eq!(kinds(&s), ["rewind"]);
}

#[tokio::test]
async fn rewind_to_before_the_first_turn_after_a_new_session_keeps_its_notice_and_starts_a_new_one() {
    let env = setup(resume_at_point, None).await;
    env.turn("one", Some("S1"), Some("m1")).await;
    env.sdk.new_session(&env.id).await.unwrap();
    env.turn("two", Some("S2"), Some("m2")).await;
    let t2 = turn_ids(&env.snap().await)[1].clone();
    env.sdk.rewind(&env.id, &t2).await.unwrap();
    let s = env.snap().await;
    assert!(s["thread"].get("session_id").is_none());
    assert_eq!(
        kinds(&s),
        [
            "user_message",
            "assistant_message",
            "turn_result",
            "session.new",
            "rewind"
        ]
    );
}

#[tokio::test]
async fn rewind_goes_back_into_the_session_before_a_new_session_taking_its_notice_with_it() {
    let env = setup(resume_at_point, None).await;
    env.turn("one", Some("S1"), Some("m1")).await;
    env.turn("two", None, Some("m2")).await;
    env.sdk.new_session(&env.id).await.unwrap();
    env.turn("three", Some("S2"), Some("m3")).await;
    let ids = turn_ids(&env.snap().await);
    env.sdk.rewind(&env.id, &ids[1]).await.unwrap();
    let s = env.snap().await;
    assert_eq!(
        (&s["thread"]["session_id"], &s["thread"]["resume_at"]),
        (&json!("S1"), &json!("m1"))
    );
    assert!(!kinds(&s).contains(&"session.new".to_string()));
    assert!(!turn_ids(&s).contains(&ids[2]));
}

#[tokio::test]
async fn rewind_is_refused_for_a_claude_session_the_thread_adopted_to_before_its_first_turn_in_it() {
    let env = setup(resume_at_point, Some("S0")).await;
    env.turn("one", None, Some("m1")).await;
    let before = env.snap().await;
    let t1 = turn_ids(&before)[0].clone();
    refused(env.sdk.rewind(&env.id, &t1).await, "can't be rewound");
    assert_eq!(env.snap().await, before);
}

#[tokio::test]
async fn rewind_reverts_a_codex_session_to_before_the_first_turn_from_there_that_has_a_mark() {
    let env = setup(|s, i| Ok(revert_point(s, i)), Some("S0")).await;
    env.turn("one", None, Some("c1")).await;
    env.turn("two", None, None).await; // no mark
    env.turn("three", None, Some("c3")).await;
    let ids = turn_ids(&env.snap().await);
    env.sdk.rewind(&env.id, &ids[1]).await.unwrap();
    let t = env.snap().await["thread"].clone();
    assert_eq!((&t["session_id"], &t["resume_at"]), (&json!("S0"), &json!("c3")));
    env.sdk.rewind(&env.id, &ids[0]).await.unwrap();
    let t = env.snap().await["thread"].clone();
    assert_eq!((&t["session_id"], &t["resume_at"]), (&json!("S0"), &json!("c1")));
}

#[tokio::test]
async fn rewind_keeps_a_codex_revert_not_yet_made_when_a_second_rewind_to_before_turns_with_no_mark_needs_it() {
    let env = setup(|s, i| Ok(revert_point(s, i)), None).await;
    env.turn("one", Some("S"), Some("c1")).await;
    env.turn("two", None, None).await; // failed before Codex marked it
    env.turn("three", None, Some("c3")).await;
    let ids = turn_ids(&env.snap().await);
    env.sdk.rewind(&env.id, &ids[2]).await.unwrap();
    let t = env.snap().await["thread"].clone();
    assert_eq!((&t["session_id"], &t["resume_at"]), (&json!("S"), &json!("c3")));
    // Codex still has turn three: reverting to before it is what takes it back to before turn two.
    env.sdk.rewind(&env.id, &ids[1]).await.unwrap();
    let s = env.snap().await;
    assert_eq!(
        (&s["thread"]["session_id"], &s["thread"]["resume_at"]),
        (&json!("S"), &json!("c3"))
    );
    assert_eq!(turn_ids(&s).len(), 1);
}

/// Turn one, steered with a message the harness doesn't take in; turn two (carrying it over) fails
/// without taking it in; turn three, with the user's next message, takes it in. The thread, and
/// the steered message's id.
async fn carried() -> (Env, Value, String) {
    let env = setup(resume_at_point, None).await;
    env.sdk.send(&env.id, "one", SendOptions::default()).await.unwrap();
    env.harness(|ctx| ctx.set_thread(|t| t.session_id = Some("S".into())));
    env.sdk.send(&env.id, "steered", SendOptions::default()).await.unwrap();
    env.harness(|ctx| {
        let end = |ok: bool, session_at: Option<&str>| TurnEnd {
            ok,
            error: (!ok).then(|| "failed".into()),
            session_at: session_at.map(String::from),
            ..Default::default()
        };
        ctx.end_turn(end(true, Some("m1")), false);
        ctx.end_turn(end(false, None), false);
    });
    env.sdk.send(&env.id, "three", SendOptions::default()).await.unwrap();
    let steered = Arc::new(Mutex::new(String::new()));
    let took = steered.clone();
    env.harness(move |ctx| {
        let id = ctx.queued()[0].id.clone();
        assert!(ctx.took_in(&id));
        *took.lock().unwrap() = id;
        ctx.end_turn(
            TurnEnd {
                ok: true,
                session_at: Some("m3".into()),
                ..Default::default()
            },
            false,
        );
    });
    let s = env.snap().await;
    let steered = steered.lock().unwrap().clone();
    let item = items(&s).iter().find(|i| i["id"] == steered.as_str()).unwrap();
    assert_eq!(item["turn_id"].as_str(), Some(turn_ids(&s)[2].as_str()));
    (env, s, steered)
}

#[tokio::test]
async fn rewind_goes_by_the_order_turns_ran_though_a_message_carried_over_to_a_later_turn_keeps_its_place() {
    let has = |s: &Value, id: &str| items(s).iter().any(|i| i["id"] == id);
    // To before turn two: turn three goes too, with the message it took in.
    let (a, before, steered) = carried().await;
    a.sdk.rewind(&a.id, &turn_ids(&before)[1]).await.unwrap();
    let s = a.snap().await;
    assert_eq!(turn_ids(&s), turn_ids(&before)[..1]);
    assert!(!has(&s, &steered));
    assert_eq!(kinds(&s), ["user_message", "turn_result", "rewind"]);
    // To before turn three: turn two stays.
    let (b, before, steered) = carried().await;
    b.sdk.rewind(&b.id, &turn_ids(&before)[2]).await.unwrap();
    let s = b.snap().await;
    assert_eq!(turn_ids(&s), turn_ids(&before)[..2]);
    assert!(!has(&s, &steered));
}

#[tokio::test]
async fn rewind_is_refused_while_a_turn_runs_and_for_a_turn_the_thread_hasnt() {
    let env = setup(resume_at_point, None).await;
    env.turn("one", Some("S1"), Some("m1")).await;
    refused(env.sdk.rewind(&env.id, "turn_nope").await, "no turn turn_nope");
    env.sdk.send(&env.id, "two", SendOptions::default()).await.unwrap();
    let t1 = turn_ids(&env.snap().await)[0].clone();
    refused(env.sdk.rewind(&env.id, &t1).await, "a turn is running");
    refused(env.sdk.new_session(&env.id).await, "a turn is running");
    refused(env.sdk.compact(&env.id).await, "a turn is running");
}

// ---------- new_session ----------

#[tokio::test]
async fn new_session_lets_go_of_the_session_and_does_nothing_when_theres_none() {
    let mut env = setup(resume_at_point, None).await;
    env.snap().await;
    let n = env.events().len();
    env.sdk.new_session(&env.id).await.unwrap();
    env.snap().await;
    assert_eq!(env.events().len(), n);
    env.turn("one", Some("S1"), Some("m1")).await;
    let command: Command = serde_json::from_value(json!({"type": "new_session", "thread_id": env.id})).unwrap();
    env.sdk.handle(command).await.unwrap();
    let s = env.snap().await;
    assert!(s["thread"].get("session_id").is_none());
    let last = items(&s).last().unwrap();
    assert_eq!(
        (&last["type"], &last["code"]),
        (&json!("notice"), &json!("session.new"))
    );
    assert!(env.changes() > 0);
}

// ---------- compact ----------

#[tokio::test]
async fn compact_runs_a_turn_with_no_message_and_is_refused_with_no_session() {
    let env = setup(resume_at_point, None).await;
    refused(env.sdk.compact(&env.id).await, "no conversation to compact");
    env.turn("one", Some("S1"), Some("m1")).await;
    let n = items(&env.snap().await).len();
    let command: Command = serde_json::from_value(json!({"type": "compact", "thread_id": env.id})).unwrap();
    env.sdk.handle(command).await.unwrap();
    assert_eq!(env.counts.lock().unwrap().compacts, 1);
    assert_eq!(env.snap().await["thread"]["status"], "running");
    env.harness(|ctx| {
        ctx.add_item(json!({"id": "c1", "type": "compaction", "trigger": "manual"}));
        ctx.end_turn(
            TurnEnd {
                ok: true,
                session_at: Some("m2".into()),
                ..Default::default()
            },
            false,
        );
    });
    let s = env.snap().await;
    let added: Vec<&str> = items(&s)[n..].iter().map(|i| i["type"].as_str().unwrap()).collect();
    assert_eq!(added, ["compaction", "turn_result"]);
    assert_eq!(sessions(&s).last().unwrap(), &json!({"id": "S1", "at": "m2"}));
}

// ---------- the rewind points ----------

fn s(id: &str, at: Option<&str>, started: bool) -> Option<TurnSession> {
    Some(serde_json::from_value(json!({"id": id, "at": at, "started": started})).unwrap())
}

fn point(session_id: Option<&str>, resume_at: Option<&str>) -> RewindPoint {
    RewindPoint {
        session_id: session_id.map(String::from),
        resume_at: resume_at.map(String::from),
    }
}

#[test]
fn the_rewind_points_resume_at_the_latest_mark_before_the_turn_in_its_session() {
    let a = |at: Option<&str>, started| s("A", at, started);
    assert_eq!(
        resume_at_point(&[a(Some("a1"), true), a(None, false), a(Some("a3"), false)], 2),
        Ok(point(Some("A"), Some("a1")))
    );
    assert_eq!(
        resume_at_point(&[a(Some("a1"), true), s("B", Some("b1"), true)], 1),
        Ok(point(None, None))
    );
    assert_eq!(resume_at_point(&[None, a(Some("a1"), true)], 0), Ok(point(None, None)));
    assert!(resume_at_point(&[a(None, true), a(Some("a2"), false)], 1).is_err());
    assert!(resume_at_point(&[a(Some("a1"), false)], 0).is_err());
}

#[test]
fn the_rewind_points_revert_to_before_the_first_mark_from_the_turn_on_in_its_session() {
    let a = |at: Option<&str>, started| s("A", at, started);
    assert_eq!(
        revert_point(&[a(Some("a1"), true), a(None, false), a(Some("a3"), false)], 1),
        point(Some("A"), Some("a3"))
    );
    assert_eq!(
        revert_point(&[a(Some("a1"), true), a(None, false), s("B", Some("b1"), true)], 1),
        point(Some("A"), None)
    );
    assert_eq!(revert_point(&[a(Some("a1"), true)], 0), point(None, None));
}

// ---------- a turn the backend lost ----------

/// A thread on `store`, made with `session_id`.
async fn to_lose(session_id: Option<&str>) -> (Env, Arc<MemoryStore>) {
    let store = Arc::new(MemoryStore::new());
    (setup_in(resume_at_point, session_id, store.clone()).await, store)
}

/// Sends a turn that the harness says runs in `session`, then the backend goes (without closing)
/// and another loads the thread: that backend, and the thread as it has it.
async fn lose(env: Env, store: Arc<MemoryStore>, session: &str) -> (AgentThreads, Value) {
    env.sdk
        .send(&env.id, "the lost one", SendOptions::default())
        .await
        .unwrap();
    let session = session.to_string();
    env.harness(move |ctx| ctx.set_thread(|t| t.session_id = Some(session)));
    env.sdk.events_since(&env.id, 0, None).await.unwrap();
    let (next, _, _) = backend(resume_at_point, store);
    let s = serde_json::to_value(next.snapshot(&env.id).await.unwrap()).unwrap();
    (next, s)
}

#[tokio::test]
async fn a_turn_the_backend_lost_records_that_it_started_the_session_it_got() {
    let (env, store) = to_lose(None).await;
    let id = env.id.clone();
    let (next, s) = lose(env, store, "S-new").await;
    assert_eq!(sessions(&s), vec![json!({"id": "S-new", "started": true})]);
    next.rewind(&id, &turn_ids(&s)[0]).await.unwrap();
    let s = serde_json::to_value(next.snapshot(&id).await.unwrap()).unwrap();
    assert!(s["thread"].get("session_id").is_none());
}

#[tokio::test]
async fn a_turn_the_backend_lost_records_that_it_started_the_one_it_got_after_a_new_session() {
    let (env, store) = to_lose(None).await;
    env.turn("one", Some("S-old"), Some("m1")).await;
    env.sdk.new_session(&env.id).await.unwrap();
    let (_, s) = lose(env, store, "S-new").await;
    assert_eq!(
        sessions(&s),
        vec![
            json!({"id": "S-old", "at": "m1", "started": true}),
            json!({"id": "S-new", "started": true})
        ]
    );
}

#[tokio::test]
async fn a_turn_the_backend_lost_is_a_compaction_that_had_no_items_yet_not_the_turn_before_it() {
    let (env, store) = to_lose(None).await;
    let id = env.id.clone();
    env.sdk.send(&id, "one", SendOptions::default()).await.unwrap();
    env.harness(|ctx| {
        ctx.set_thread(|t| t.session_id = Some("S".into()));
        ctx.end_turn(
            TurnEnd {
                ok: true,
                session_at: Some("m1".into()),
                ..Default::default()
            },
            false,
        );
    });
    env.sdk.compact(&id).await.unwrap();
    env.sdk.events_since(&id, 0, None).await.unwrap();
    let (next, _, _) = backend(resume_at_point, store);
    let s = serde_json::to_value(next.snapshot(&id).await.unwrap()).unwrap();
    let events = next.events_since(&id, 0, None).await.unwrap();
    let ids = |started: bool| -> Vec<String> {
        events
            .iter()
            .filter_map(|e| match e {
                ThreadEvent::TurnStarted(t) if started => Some(t.turn_id.clone()),
                ThreadEvent::TurnCompleted(t) if !started => Some(t.turn_id.clone()),
                _ => None,
            })
            .collect()
    };
    let started = ids(true);
    assert_eq!(ids(false), started);
    assert_eq!(turn_ids(&s), started);
    assert_eq!(
        sessions(&s),
        vec![json!({"id": "S", "at": "m1", "started": true}), json!({"id": "S"})]
    );
    next.rewind(&id, &started[1]).await.unwrap();
    let t = serde_json::to_value(next.snapshot(&id).await.unwrap()).unwrap()["thread"].clone();
    assert_eq!((&t["session_id"], &t["resume_at"]), (&json!("S"), &json!("m1")));
}

#[tokio::test]
async fn a_turn_the_backend_lost_records_that_it_continued_a_session_the_thread_adopted() {
    let (env, store) = to_lose(Some("S0")).await;
    let id = env.id.clone();
    let (next, s) = lose(env, store, "S0").await;
    assert_eq!(sessions(&s), vec![json!({"id": "S0"})]);
    refused(next.rewind(&id, &turn_ids(&s)[0]).await, "can't be rewound");
}
