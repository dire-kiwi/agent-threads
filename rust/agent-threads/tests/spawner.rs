//! The spawners: lines out, exit after the last one, and stopping everything a process started;
//! and for the shim, reading whole lines from an offset, re-attaching, not writing input twice, and
//! noticing a run that's gone. As the Node backend's spawner.test.ts does.
#![cfg(unix)]

mod common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_threads::{
    ExitStatus, HarnessProcess, MemoryStore, ProcessEvent, RunRecord, ShimOptions, Signal, SpawnOptions, Spawner,
    Store, direct, shim,
};
use serde_json::{Value, json};

/// A process and what it has said.
struct Followed {
    proc: Arc<dyn HarnessProcess>,
    lines: Arc<Mutex<Vec<String>>>,
    stderr: Arc<Mutex<Vec<String>>>,
    offset: Arc<Mutex<Option<u64>>>,
    exit: Arc<Mutex<Option<ExitStatus>>>,
}

impl Followed {
    fn new((proc, mut rx): agent_threads::Spawned) -> Self {
        let f = Followed {
            proc,
            lines: Arc::default(),
            stderr: Arc::default(),
            offset: Arc::default(),
            exit: Arc::default(),
        };
        let (lines, stderr, offset, exit) = (f.lines.clone(), f.stderr.clone(), f.offset.clone(), f.exit.clone());
        tokio::spawn(async move {
            while let Some(e) = rx.recv().await {
                match e {
                    ProcessEvent::Line { line, end } => {
                        *offset.lock().unwrap() = end;
                        lines.lock().unwrap().push(line);
                    }
                    ProcessEvent::Stderr(l) => stderr.lock().unwrap().push(l),
                    ProcessEvent::CaughtUp => {}
                    ProcessEvent::Exit(s) => *exit.lock().unwrap() = Some(s),
                }
            }
        });
        f
    }

    fn lines(&self) -> Vec<String> {
        self.lines.lock().unwrap().clone()
    }

    fn exit(&self) -> Option<ExitStatus> {
        self.exit.lock().unwrap().clone()
    }
}

async fn wait(what: impl Fn() -> bool) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !what() {
        if std::time::Instant::now() > deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    true
}

fn options(script: &str, run_id: &str) -> SpawnOptions {
    SpawnOptions {
        command: "sh".into(),
        args: vec!["-c".into(), script.into()],
        cwd: None,
        env: std::env::vars().collect::<HashMap<_, _>>(),
        thread_id: "th".into(),
        run_id: run_id.into(),
    }
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

fn record(id: &str, offset: u64, data: Value) -> RunRecord {
    serde_json::from_value(
        json!({"id": id, "thread_id": "th", "spawner": "shim", "offset": offset, "started_at": "", "data": data}),
    )
    .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn direct_passes_lines_through_and_says_how_it_exited_after_the_last() {
    let p = Followed::new(
        direct()
            .spawn(options("read x; echo got $x; echo bye; exit 3", "run"))
            .unwrap(),
    );
    p.proc.write("hi");
    assert!(wait(|| p.exit().is_some()).await);
    assert_eq!(p.lines(), ["got hi", "bye"]);
    assert_eq!(p.exit().unwrap().code, Some(3));
}

#[tokio::test(flavor = "multi_thread")]
async fn direct_stops_what_a_process_started_after_the_process_itself_has_exited() {
    // The shell exits at once, leaving a sleep that holds its stdout open.
    let p = Followed::new(direct().spawn(options("sleep 30 & echo started", "run")).unwrap());
    assert!(wait(|| !p.lines().is_empty()).await);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(p.exit().is_none());
    p.proc.kill(Signal::Kill);
    assert!(wait(|| p.exit().is_some()).await);
}

struct ShimSetup {
    runs_dir: std::path::PathBuf,
    spawner: Arc<dyn Spawner>,
}

impl Drop for ShimSetup {
    /// Kills what's left running, so a test that fails leaves nothing behind.
    fn drop(&mut self) {
        agent_threads::kill_runs(&self.runs_dir);
    }
}

fn shim_setup() -> ShimSetup {
    let runs_dir = common::temp_dir();
    let mut o = ShimOptions::new(&runs_dir);
    o.poll = Duration::from_millis(20);
    o.kill_grace = Duration::from_millis(500);
    ShimSetup {
        spawner: shim(common::shim_path(), o),
        runs_dir,
    }
}

impl ShimSetup {
    fn run(&self, script: &str, run_id: &str) -> Followed {
        Followed::new(self.spawner.spawn(options(script, run_id)).unwrap())
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn shim_passes_whole_lines_through_with_the_offset_after_each_and_says_how_it_exited_after_the_last() {
    let s = shim_setup();
    // The last line has no newline: it counts once the run is over.
    let p = s.run(
        r"read x; echo got $x; printf 'part'; sleep 0.3; printf 'ial\nlast'; echo oops >&2; exit 3",
        "run_1",
    );
    p.proc.write("hi");
    assert!(wait(|| p.lines().len() == 1).await);
    tokio::time::sleep(Duration::from_millis(150)).await;
    // Half a line isn't given, nor counted.
    assert_eq!(p.lines(), ["got hi"]);
    assert_eq!(*p.offset.lock().unwrap(), Some("got hi\n".len() as u64));
    assert!(wait(|| p.exit().is_some()).await);
    assert_eq!(p.lines(), ["got hi", "partial", "last"]);
    assert_eq!(*p.stderr.lock().unwrap(), ["oops"]);
    let exit = p.exit().unwrap();
    assert_eq!((exit.code, exit.signal), (Some(3), None));
    let dir = s.runs_dir.join("run_1");
    assert_eq!(
        *p.offset.lock().unwrap(),
        Some(std::fs::metadata(dir.join("out.jsonl")).unwrap().len())
    );
    let run: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("run.json")).unwrap()).unwrap();
    assert_eq!(
        (
            run["format"].clone(),
            run["run_id"].clone(),
            run["thread_id"].clone(),
            run["command"].clone()
        ),
        (json!(1), json!("run_1"), json!("th"), json!("sh"))
    );
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn shim_reads_what_a_run_writes_as_it_writes_it_without_waiting_for_the_poll() {
    let runs_dir = common::temp_dir();
    let mut o = ShimOptions::new(&runs_dir);
    // Longer than wait() waits: only the run's directory being watched gets anything through.
    o.poll = Duration::from_secs(60);
    let s = ShimSetup {
        spawner: shim(common::shim_path(), o),
        runs_dir,
    };
    let p = s.run(r#"read x; echo "got $x"; sleep 0.2; echo bye"#, "run_1");
    p.proc.write("hi");
    assert!(wait(|| p.lines().len() == 1).await);
    assert_eq!(p.lines(), ["got hi"]);
    assert!(wait(|| p.exit().is_some()).await);
    assert_eq!(p.lines(), ["got hi", "bye"]);
    assert_eq!(p.exit().unwrap().code, Some(0));
}

#[tokio::test(flavor = "multi_thread")]
async fn shim_kill_runs_leaves_nothing_running() {
    let s = shim_setup();
    let p = s.run("sleep 30 & echo $!; wait", "run_1");
    assert!(wait(|| p.lines().len() == 1).await);
    let sleeper: i32 = p.lines()[0].parse().unwrap();
    let shim_pid: i32 = std::fs::read_to_string(s.runs_dir.join("run_1/shim.pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    drop(s);
    assert!(wait(|| !alive(sleeper) && !alive(shim_pid)).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn shim_kill_runs_stops_a_run_still_being_launched_however_long_its_launch_takes() {
    use std::os::unix::fs::PermissionsExt;
    // A launcher that stalls for longer than a run's start may take, then starts the shim.
    let dir = common::temp_dir();
    let (bin, launcher) = (dir.join("slow-shim"), dir.join("launcher.pid"));
    std::fs::write(
        &bin,
        format!(
            "#!/bin/sh\necho $$ > '{}'\nsleep 12\nexec '{}' \"$@\"\n",
            launcher.display(),
            common::shim_path().display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    let runs_dir = common::temp_dir();
    let s = ShimSetup {
        spawner: shim(&bin, ShimOptions::new(&runs_dir)),
        runs_dir: runs_dir.clone(),
    };
    // It ignores its input closing.
    let _p = s.run("exec sleep 30", "run_1");
    assert!(wait(|| launcher.exists()).await);
    let pgid: i32 = std::fs::read_to_string(&launcher).unwrap().trim().parse().unwrap();
    let started = std::time::Instant::now();
    drop(s);
    assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
    // The launcher's gone, with its sleep: nothing is left to start the run.
    assert!(wait(|| unsafe { libc::kill(-pgid, 0) } != 0).await);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!runs_dir.join("run_1/shim.pid").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn shim_reattaches_from_an_offset_and_leaves_a_run_going_when_it_detaches() {
    let s = shim_setup();
    let a = s.run(r#"while read -r x; do echo "got $x"; done; echo bye"#, "run_1");
    a.proc.write("one");
    assert!(wait(|| a.lines().len() == 1).await);
    let offset = a.offset.lock().unwrap().unwrap();
    a.proc.write("two");
    a.proc.detach();
    // What it says while nothing follows it is read by what re-attaches.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(a.lines(), ["got one"]);
    let b = Followed::new(s.spawner.attach(&record("run_1", offset, Value::Null)).unwrap());
    assert!(wait(|| b.lines().len() == 1).await);
    assert_eq!(b.lines(), ["got two"]);
    b.proc.write("three");
    b.proc.close_input();
    assert!(wait(|| b.exit().is_some()).await);
    assert_eq!(b.lines(), ["got two", "got three", "bye"]);
    assert_eq!(b.exit().unwrap().code, Some(0));
    assert!(a.exit().is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn shim_after_reattaching_doesnt_answer_again_a_request_it_answered_before() {
    let s = shim_setup();
    let a = s.run(r#"while read -r x; do echo "$x"; done"#, "run_1");
    let answer = |id: &str, behavior: &str| {
        json!({"type": "control_response", "response": {"subtype": "success", "request_id": id, "response": {"behavior": behavior}}}).to_string()
    };
    let input_path = s.runs_dir.join("run_1/input.jsonl");
    let input = || std::fs::read_to_string(&input_path).unwrap();
    // Saved before these were written.
    let saved = a.proc.input_offset(&[]).unwrap();
    a.proc.write("hello");
    a.proc.write(&answer("r1", "allow"));
    a.proc.write(&answer("r2", "allow"));
    assert!(wait(|| a.lines().len() == 3).await);
    a.proc.detach();

    // Re-attached past all the output: lines written before aren't written again, but the answer to
    // r1, which the driver still has open (a user asked again, say), is kept until it's answered.
    let open = vec!["r1".to_string()];
    let offset = std::fs::metadata(s.runs_dir.join("run_1/out.jsonl")).unwrap().len();
    let b = Followed::new(
        s.spawner
            .attach(&record("run_1", offset, json!({"input": saved})))
            .unwrap(),
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    // The driver has taken in the output there was (ProcessEvent::CaughtUp).
    b.proc.retire(&open);
    let r1 = saved + "hello\n".len() as u64;
    assert_eq!(b.proc.input_offset(&open), Some(r1));
    let before = input();
    b.proc.write(&answer("r2", "deny"));
    assert_eq!(input(), format!("{before}{}\n", answer("r2", "deny")));
    // Answered otherwise this time: Claude has its answer already.
    b.proc.write(&answer("r1", "deny"));
    assert_eq!(input(), format!("{before}{}\n", answer("r2", "deny")));
    assert_eq!(b.proc.input_offset(&open), Some(input().len() as u64));

    // Re-attached again from before r1's answer: one whose request is closed meanwhile (cancelled,
    // say) is let go of.
    b.proc.detach();
    let c = Followed::new(
        s.spawner
            .attach(&record("run_1", offset, json!({"input": r1})))
            .unwrap(),
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    c.proc.retire(&open);
    assert_eq!(c.proc.input_offset(&open), Some(r1));
    assert_eq!(c.proc.input_offset(&[]), Some(input().len() as u64));
    c.proc.close_input();
}

#[tokio::test(flavor = "multi_thread")]
async fn shim_stops_the_runs_whole_process_group() {
    let s = shim_setup();
    let p = s.run("sleep 30 & echo $!; wait", "run_1");
    assert!(wait(|| p.lines().len() == 1).await);
    let sleeper: i32 = p.lines()[0].parse().unwrap();
    p.proc.kill(Signal::Term);
    assert!(wait(|| p.exit().is_some()).await);
    let exit = p.exit().unwrap();
    assert_eq!((exit.code, exit.signal.as_deref()), (None, Some("SIGTERM")));
    assert!(wait(|| !alive(sleeper)).await);
    assert!(s.runs_dir.join("run_1/exit").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn shim_signals_a_run_its_stopped_before_the_shim_has_started_it_once_it_has() {
    let s = shim_setup();
    let p = s.run("sleep 30", "run_1");
    p.proc.kill(Signal::Kill);
    assert!(wait(|| p.exit().is_some()).await);
    assert_eq!(p.exit().unwrap().signal.as_deref(), Some("SIGKILL"));
}

#[tokio::test(flavor = "multi_thread")]
async fn shim_notices_a_shim_that_went_away_without_saying_how_its_run_ended() {
    let s = shim_setup();
    let p = s.run("echo started; exec sleep 30", "run_1");
    assert!(wait(|| p.lines().len() == 1).await);
    let dir = s.runs_dir.join("run_1");
    let shim_pid: i32 = std::fs::read_to_string(dir.join("shim.pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    unsafe { libc::kill(shim_pid, libc::SIGKILL) };
    assert!(wait(|| p.exit().is_some()).await);
    assert!(
        p.exit()
            .unwrap()
            .error
            .unwrap()
            .contains("agent-threads-shim) went away")
    );
    let exit: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("exit")).unwrap()).unwrap();
    assert!(exit["code"].is_null() && exit["error"].as_str().unwrap().contains("went away"));
    // With nothing left to stop it, the program it ran is stopped.
    let pid: i32 = std::fs::read_to_string(dir.join("pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(wait(|| !alive(pid)).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn shim_stops_whats_left_of_the_group_after_the_program_exits_with_sigkill_for_what_ignores_sigterm() {
    let s = shim_setup();
    // The child says its pid once it ignores SIGTERM.
    let p = s.run(r#"sh -c 'trap "" TERM; echo $$; exec sleep 30' & wait"#, "run_1");
    assert!(wait(|| p.lines().len() == 1).await);
    let stubborn: i32 = p.lines()[0].parse().unwrap();
    p.proc.kill(Signal::Term);
    assert!(wait(|| p.exit().is_some()).await);
    assert_eq!(p.exit().unwrap().signal.as_deref(), Some("SIGTERM"));
    assert!(alive(stubborn));
    assert!(wait(|| !alive(stubborn)).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn shim_says_why_a_run_couldnt_be_started() {
    let runs_dir = common::temp_dir();
    let p = Followed::new(
        shim("/nonexistent/agent-threads-shim", ShimOptions::new(&runs_dir))
            .spawn(options("true", "r"))
            .unwrap(),
    );
    assert!(wait(|| p.exit().is_some()).await);
    assert!(p.exit().unwrap().error.unwrap().contains("couldn't be started"));
    let s = shim_setup();
    let q = s.run("true", "r");
    assert!(wait(|| q.exit().is_some()).await);
    assert_eq!(q.exit().unwrap().code, Some(0));
}

#[tokio::test(flavor = "multi_thread")]
async fn shim_prunes_runs_the_backend_finished_with_a_while_ago_and_stops_runs_nothing_follows() {
    let s = shim_setup();
    let store = MemoryStore::new();
    store
        .create_thread(
            &json!({"id": "th", "harness": "claude", "status": "idle", "created_at": "2026-11-01T00:00:00Z"}),
        )
        .await
        .unwrap();
    let done = async |id: &str, ended_days_ago: Option<i64>| {
        let dir = s.runs_dir.join(id);
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("exit"), r#"{"code":0,"signal":null}"#).unwrap();
        let mut run =
            json!({"id": id, "thread_id": "th", "spawner": "shim", "offset": 0, "started_at": "2026-11-01T00:00:00Z"});
        if let Some(days) = ended_days_ago {
            let at = chrono::Utc::now() - chrono::Duration::days(days);
            run["ended_at"] = json!(at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        }
        store.put_run(&serde_json::from_value(run).unwrap()).await.unwrap();
    };
    done("old", Some(20)).await;
    done("recent", Some(1)).await;
    done("active", None).await;
    // No record, finished long ago (a backend that died before saving it), and one just made.
    std::fs::create_dir(s.runs_dir.join("stray")).unwrap();
    std::fs::write(s.runs_dir.join("stray/exit"), "{}").unwrap();
    let two_hours_ago = std::time::SystemTime::now() - Duration::from_secs(7200);
    std::fs::File::open(s.runs_dir.join("stray"))
        .unwrap()
        .set_modified(two_hours_ago)
        .unwrap();
    std::fs::create_dir(s.runs_dir.join("new")).unwrap();
    // Running, but the store has it as ended: its backend gave up on it.
    let orphan = s.run("sleep 30", "orphan");
    let pid = s.runs_dir.join("orphan/pid");
    assert!(wait(|| pid.exists()).await);
    orphan.proc.detach();
    let ended = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let run = json!({"id": "orphan", "thread_id": "th", "spawner": "shim", "offset": 0, "started_at": "2026-11-01T00:00:00Z", "ended_at": ended});
    store.put_run(&serde_json::from_value(run).unwrap()).await.unwrap();

    assert_eq!(s.spawner.prune(&store).await.unwrap(), 2);
    let mut left: Vec<String> = std::fs::read_dir(&s.runs_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    left.sort();
    assert_eq!(left, ["active", "new", "orphan", "recent"]);
    let exit = s.runs_dir.join("orphan/exit");
    assert!(wait(|| exit.exists()).await);
    let exit: Value = serde_json::from_str(&std::fs::read_to_string(exit).unwrap()).unwrap();
    assert_eq!(exit["signal"], 15);
}

#[tokio::test(flavor = "multi_thread")]
async fn shim_sends_sigterm_once_when_its_signalled_during_a_stop_whose_sigterm_is_still_to_come() {
    let s = shim_setup();
    // It says so each time it gets SIGTERM, and doesn't exit at it, nor when its input closes.
    let p = s.run(
        "trap 'echo term' TERM; echo ready; while :; do sleep 0.05; done",
        "run_1",
    );
    assert!(wait(|| p.lines().len() == 1).await);
    assert!(p.proc.stop(Duration::from_millis(300), false));
    p.proc.kill(Signal::Term);
    assert!(wait(|| p.exit().is_some()).await);
    assert_eq!(p.exit().unwrap().signal.as_deref(), Some("SIGKILL"));
    assert_eq!(p.lines(), ["ready", "term"]);
}
