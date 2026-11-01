//! The shim spawner: harness processes run under agent-threads-shim (`shim/` in the repository),
//! detached from the backend, and everything between them goes through files in the run's
//! directory, as spec/RUNDIR.md says. The backend appends its input to input.jsonl and follows
//! out.jsonl, and the offset it has read to is saved with the events it made of the lines (see
//! [`Spawner::durable`]), so a backend that restarts re-attaches ([`Spawner::attach`]) and carries
//! on from exactly there.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::ids::{now_iso, now_ms, parse_iso_ms};
use crate::spawner::{
    ExitStatus, HarnessProcess, ProcessEvent, Signal, SpawnOptions, Spawned, Spawner, direct, signal_name,
};
use crate::store::{RunRecord, Store, StoreResult};

/// The run-directory format this backend writes and reads (spec/RUNDIR.md).
pub const RUN_FORMAT: u64 = 1;

/// How the shim spawner runs.
#[derive(Clone, Debug)]
pub struct ShimOptions {
    /// Where run directories go. It must be this store's alone: pruning stops and removes the runs
    /// in it that the store doesn't follow, so two stores sharing one would stop each other's
    /// runs.
    pub runs_dir: PathBuf,
    /// How long a finished run's directory is kept, for debugging. 14 days by default.
    pub keep: Duration,
    /// How long a run that's stopped has to exit after SIGTERM before it's sent SIGKILL. 10s by
    /// default.
    pub kill_grace: Duration,
    /// How often a run's directory is read when nothing says it changed. On Linux it's watched
    /// (inotify), which wakes the backend when the run writes, so this is only a fallback: 200ms by
    /// default. Elsewhere it's how often a run's output is read: 50ms by default.
    pub poll: Duration,
}

impl ShimOptions {
    pub fn new(runs_dir: impl Into<PathBuf>) -> Self {
        ShimOptions {
            runs_dir: runs_dir.into(),
            keep: Duration::from_secs(14 * 86_400),
            kill_grace: Duration::from_secs(10),
            poll: Duration::from_millis(if cfg!(target_os = "linux") { 200 } else { 50 }),
        }
    }
}

/// How long a finished run's directory with no record, or a dead run's, is kept: it may be a run
/// being started.
const KEEP_UNKNOWN_MS: u64 = 3_600_000;
/// How long the shim may take to record its pid after it's launched.
const START_TIMEOUT_MS: u64 = 10_000;
/// How much of err.log a re-attached run's stderr starts with.
const STDERR_TAIL: u64 = 4096;

/// Runs harness processes under agent-threads-shim (`path`, the binary: a path, or a name looked
/// for on the PATH), so they survive the backend. Where the shim doesn't run (Windows), it's
/// [`direct`].
pub fn shim(path: impl Into<PathBuf>, options: ShimOptions) -> Arc<dyn Spawner> {
    if cfg!(not(unix)) {
        return direct();
    }
    let path = path.into();
    // Made absolute here, as the shim starts in the thread's working directory.
    let bin = if path.components().count() > 1 && path.is_relative() {
        std::path::absolute(&path).unwrap_or(path)
    } else {
        path
    };
    let runs_dir = std::path::absolute(&options.runs_dir).unwrap_or(options.runs_dir.clone());
    Arc::new(Shim {
        bin,
        runs_dir,
        o: options,
        live: Arc::new(Mutex::new(HashSet::new())),
    })
}

struct Shim {
    bin: PathBuf,
    runs_dir: PathBuf,
    o: ShimOptions,
    /// Runs this backend follows, which pruning leaves alone.
    live: Arc<Mutex<HashSet<String>>>,
}

impl Shim {
    fn follow(
        &self,
        id: &str,
        dir: PathBuf,
        offset: u64,
        launched: bool,
        input: Option<u64>,
    ) -> (Arc<ShimProcess>, mpsc::UnboundedReceiver<ProcessEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        self.live.lock().unwrap().insert(id.to_string());
        let (live, run_id) = (self.live.clone(), id.to_string());
        let done: Box<dyn Fn() + Send + Sync> = Box::new(move || {
            live.lock().unwrap().remove(&run_id);
        });
        let proc = ShimProcess::new(dir, offset, launched, input, self.o.kill_grace, done);
        let (poll, p) = (self.o.poll, proc.clone());
        tokio::spawn(async move {
            p.clone().follow(tx, poll).await;
            (p.done)();
        });
        (proc, rx)
    }
}

fn run_dir(run: &RunRecord) -> Option<PathBuf> {
    run.data.as_ref()?.get("dir")?.as_str().map(PathBuf::from)
}

#[async_trait]
impl Spawner for Shim {
    fn name(&self) -> &str {
        "shim"
    }

    fn durable(&self) -> bool {
        true
    }

    fn spawn(&self, o: SpawnOptions) -> io::Result<Spawned> {
        let dir = self.runs_dir.join(&o.run_id);
        create_private_dir_all(&self.runs_dir)?;
        create_private_dir(&dir)?;
        let run = json!({"format": RUN_FORMAT, "run_id": o.run_id, "thread_id": o.thread_id, "command": o.command, "started_at": now_iso()});
        fs::write(dir.join("run.json"), format!("{run}\n"))?;
        fs::write(dir.join("input.jsonl"), "")?;
        let (proc, rx) = self.follow(&o.run_id, dir.clone(), 0, true, None);
        // The shim forks and its first process exits at once; the run is the fork's.
        let mut cmd = tokio::process::Command::new(&self.bin);
        cmd.arg(&dir).arg("--").arg(&o.command).args(&o.args);
        cmd.env_clear()
            .envs(&o.env)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(cwd) = &o.cwd {
            cmd.current_dir(cwd);
        }
        #[cfg(unix)]
        cmd.process_group(0);
        match cmd.spawn() {
            Err(e) => proc.launch_failed(format!("agent-threads-shim couldn't be started: {e}")),
            Ok(mut child) => {
                let p = proc.clone();
                tokio::spawn(async move {
                    match child.wait().await {
                        Ok(s) if s.success() => p.launched(),
                        Ok(s) => {
                            let status = crate::spawner::exit_status(s);
                            let how = match (status.signal, status.code) {
                                (Some(sig), _) => format!("was stopped by {sig}"),
                                (None, c) => format!("exited with code {}", c.map_or("null".into(), |c| c.to_string())),
                            };
                            p.launch_failed(format!("agent-threads-shim {how}"));
                        }
                        Err(e) => p.launch_failed(format!("agent-threads-shim couldn't be started: {e}")),
                    }
                });
            }
        }
        Ok((proc, rx))
    }

    fn can_attach(&self) -> bool {
        true
    }

    fn attach(&self, run: &RunRecord) -> io::Result<Spawned> {
        let dir = run_dir(run).unwrap_or_else(|| self.runs_dir.join(&run.id));
        let input = run.data.as_ref().and_then(|d| d.get("input")).and_then(Value::as_u64);
        let (proc, rx) = self.follow(&run.id, dir.clone(), run.offset.unwrap_or(0), false, input);
        let format = read_format(&dir);
        if format > RUN_FORMAT {
            stop_dir(&dir, self.o.kill_grace);
            proc.fail(format!(
                "the run was started by a newer backend (run directory format {format}), which this one can't follow"
            ));
        }
        Ok((proc, rx))
    }

    fn stop_run(&self, run: &RunRecord) {
        stop_dir(
            &run_dir(run).unwrap_or_else(|| self.runs_dir.join(&run.id)),
            self.o.kill_grace,
        );
    }

    fn prunes(&self) -> bool {
        true
    }

    async fn prune(&self, store: &dyn Store) -> StoreResult<usize> {
        let Ok(entries) = fs::read_dir(&self.runs_dir) else {
            return Ok(0);
        };
        let mut removed = 0;
        let now = now_ms();
        for entry in entries.flatten() {
            let id = entry.file_name().to_string_lossy().to_string();
            let dir = entry.path();
            let Ok(meta) = fs::metadata(&dir) else { continue };
            if !meta.is_dir() {
                continue;
            }
            // A run being stopped when a backend went: whatever's left of it is stopped still.
            if read_stopping(&dir).is_some() {
                escalate(&dir);
                continue;
            }
            if self.live.lock().unwrap().contains(&id) {
                continue;
            }
            let record = store.get_run(&id).await?;
            if record.as_ref().is_some_and(|r| r.ended_at.is_none()) {
                continue; // A run the backend will follow.
            }
            let mtime = mtime_ms(&meta);
            // Its shim, or (with the shim gone) what it ran, which nothing would stop.
            let running = (!dir.join("exit").exists() && shim_alive(&dir, None)) || live_group(&dir).is_some();
            if running {
                // Nothing follows it, so nothing will stop it: a run its backend gave up on (and
                // was stopping when it went), or one started by a backend that died before saving
                // it.
                if record.is_some() || now.saturating_sub(mtime) > START_TIMEOUT_MS {
                    stop_dir(&dir, self.o.kill_grace);
                }
                continue;
            }
            let since = match &record {
                Some(r) => r.ended_at.as_deref().and_then(parse_iso_ms).unwrap_or(now),
                None => mtime,
            };
            let keep = if record.is_some() {
                self.o.keep.as_millis() as u64
            } else {
                KEEP_UNKNOWN_MS
            };
            if now.saturating_sub(since) > keep && fs::remove_dir_all(&dir).is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    }

    async fn settle(&self) {
        // Runs being stopped are seen through first: their groups get SIGKILL when it's due.
        loop {
            let pending: Vec<tokio::task::JoinHandle<()>> =
                ESCALATING.lock().unwrap().drain().map(|(_, h)| h).collect();
            if pending.is_empty() {
                return;
            }
            for h in pending {
                let _ = h.await;
            }
        }
    }
}

fn create_private_dir_all(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
    }
    #[cfg(not(unix))]
    fs::create_dir_all(dir)
}

fn create_private_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(dir)
    }
    #[cfg(not(unix))]
    fs::create_dir(dir)
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

/// A line written to input.jsonl after the checkpoint a run was re-attached from, which reading
/// the output again hasn't written again yet.
struct Delivered {
    text: String,
    at: u64,
    /// The harness request it answers, if it's an answer.
    answers: Option<String>,
}

struct State {
    pid: Option<u32>,
    input_closed: bool,
    /// Signals to send once the program's pid is known.
    signals: Vec<Signal>,
    /// Launched by this backend: when the launcher came back, or why it failed.
    launch: Option<(u64, Option<String>)>,
    /// input.jsonl's size, as written.
    input: u64,
    delivered: Vec<Delivered>,
    /// The driver has had the output there was when it re-attached.
    caught_up: bool,
    over: bool,
    /// An error to end with, without reading further.
    failed: Option<String>,
}

/// One run under the shim, followed through its directory.
struct ShimProcess {
    dir: PathBuf,
    grace: Duration,
    launched_here: bool,
    since: u64,
    offset: u64,
    /// How much of out.jsonl there was when it was re-attached to.
    out_at_attach: u64,
    state: Mutex<State>,
    /// Lets pruning have the run: it isn't followed any more.
    done: Box<dyn Fn() + Send + Sync>,
}

impl ShimProcess {
    fn new(
        dir: PathBuf,
        offset: u64,
        launched: bool,
        input: Option<u64>,
        grace: Duration,
        done: Box<dyn Fn() + Send + Sync>,
    ) -> Arc<Self> {
        let mut st = State {
            pid: None,
            input_closed: false,
            signals: Vec::new(),
            launch: None,
            input: 0,
            delivered: Vec::new(),
            caught_up: launched,
            over: false,
            failed: None,
        };
        let mut out_at_attach = 0;
        if !launched {
            // What's been written, and what of it came after the checkpoint (`input`: where it was
            // then).
            if let Ok(all) = fs::read(dir.join("input.jsonl")) {
                st.input = all.len() as u64;
                if let Some(input) = input {
                    // Offsets are counted on the bytes as written, line by line.
                    let mut at = input.min(all.len() as u64);
                    for line in all[at as usize..].split_inclusive(|&b| b == b'\n') {
                        if line.ends_with(b"\n") {
                            let text = String::from_utf8_lossy(line).into_owned();
                            let answers = answering(&text);
                            st.delivered.push(Delivered { text, at, answers });
                        }
                        at += line.len() as u64;
                    }
                }
            }
            out_at_attach = fs::metadata(dir.join("out.jsonl")).map_or(0, |m| m.len());
            st.input_closed = dir.join("input.closed").exists();
            // Being stopped when the backend went: it's carried on with.
            if read_stopping(&dir).is_some() {
                escalate(&dir);
            }
        }
        Arc::new(ShimProcess {
            dir,
            grace,
            launched_here: launched,
            since: now_ms(),
            offset,
            out_at_attach,
            state: Mutex::new(st),
            done,
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn launched(&self) {
        let mut st = self.lock();
        if st.launch.is_none() {
            st.launch = Some((now_ms(), None));
        }
    }

    fn launch_failed(&self, error: String) {
        self.lock().launch = Some((now_ms(), Some(error)));
    }

    /// Ends the run with an error, without reading it further (a run this backend can't follow).
    fn fail(&self, error: String) {
        let mut st = self.lock();
        if !st.over {
            st.failed = Some(error);
        }
    }

    /// Follows the run until it's over, sending what it says.
    async fn follow(self: Arc<Self>, tx: mpsc::UnboundedSender<ProcessEvent>, poll: Duration) {
        let mut out = Tail::new(self.dir.join("out.jsonl"), self.offset, false);
        // A re-attached run's stderr starts with the end of what it wrote before.
        let err_start = if self.launched_here {
            0
        } else {
            fs::metadata(self.dir.join("err.log")).map_or(0, |m| m.len().saturating_sub(STDERR_TAIL))
        };
        let mut err = Tail::new(self.dir.join("err.log"), err_start, err_start > 0);
        let mut announced = self.lock().caught_up;
        let mut checked = 0u64;
        let mut identity: Option<Identity> = None;
        // Watched from before the first read, so nothing written after it goes unnoticed.
        let watch = DirWatch::new(&self.dir);
        loop {
            if let Some(e) = {
                let mut st = self.lock();
                if st.over {
                    return;
                }
                st.failed.take()
            } {
                self.lock().over = true;
                let _ = tx.send(ProcessEvent::Exit(ExitStatus {
                    error: Some(e),
                    ..Default::default()
                }));
                return;
            }
            // Looked for first, so all the output written before it is read below.
            let exited = self.dir.join("exit").exists();
            for (line, _) in err.lines(exited) {
                let _ = tx.send(ProcessEvent::Stderr(line));
            }
            let mut read = out.at;
            for (line, end) in out.lines(exited) {
                read = end;
                if self.lock().over {
                    return;
                }
                let _ = tx.send(ProcessEvent::Line { line, end: Some(end) });
            }
            // What was there when it was re-attached to has been sent: once the driver has taken it
            // in (and written what that writes), lines written before aren't written again.
            if !announced && read.max(out.at) >= self.out_at_attach {
                announced = true;
                let _ = tx.send(ProcessEvent::CaughtUp);
            }
            let signals: Vec<Signal> = {
                let mut st = self.lock();
                if st.pid.is_none() {
                    st.pid = read_pid(&self.dir, "pid");
                }
                if st.pid.is_some() {
                    std::mem::take(&mut st.signals)
                } else {
                    Vec::new()
                }
            };
            for s in signals {
                terminate(&self.dir, self.grace, s);
            }
            if exited {
                self.lock().over = true;
                let _ = tx.send(ProcessEvent::Exit(read_exit(&self.dir)));
                return;
            }
            if let Some(gone) = self.gone(&mut checked, &mut identity) {
                // Recorded as the shim would have, unless it did after all.
                if !self.dir.exists() {
                    self.lock().over = true;
                    let _ = tx.send(ProcessEvent::Exit(ExitStatus {
                        error: Some(gone),
                        ..Default::default()
                    }));
                    return;
                }
                write_exit(&self.dir, json!({"code": null, "signal": null, "error": gone}));
                // With its shim gone, nothing would stop the program, which may well still be
                // running.
                terminate(&self.dir, self.grace, Signal::Term);
                continue;
            }
            // Until the run writes something, or (as the watch can't see everything: whether the
            // shim is still there, say) for the poll at most.
            match &watch {
                Some(w) => {
                    let _ = tokio::time::timeout(poll, w.changed()).await;
                }
                None => tokio::time::sleep(poll).await,
            }
        }
    }

    /// Why the run is gone though it has no exit file, if it is.
    fn gone(&self, checked: &mut u64, identity: &mut Option<Identity>) -> Option<String> {
        if !self.dir.exists() {
            return Some("the run's directory was removed".into());
        }
        let launch = self.lock().launch.clone();
        if let Some((_, Some(e))) = &launch {
            return Some(e.clone());
        }
        // Not every time: it's a few system calls.
        let now = now_ms();
        if now.saturating_sub(*checked) < 1000 {
            return None;
        }
        *checked = now;
        if read_pid(&self.dir, "shim.pid").is_some() {
            let alive = shim_alive(&self.dir, Some(identity)) || self.dir.join("exit").exists();
            return (!alive).then(|| "its supervisor (agent-threads-shim) went away".into());
        }
        // No shim.pid: one still starting, or one that never started.
        let since = if self.launched_here {
            launch.map(|(at, _)| at)
        } else {
            Some(self.since)
        };
        if since.is_some_and(|s| now.saturating_sub(s) > START_TIMEOUT_MS) {
            return Some("agent-threads-shim didn't start the run".into());
        }
        None
    }
}

impl HarnessProcess for ShimProcess {
    fn pid(&self) -> Option<u32> {
        let mut st = self.lock();
        if st.pid.is_none() {
            st.pid = read_pid(&self.dir, "pid");
        }
        st.pid
    }

    fn write(&self, line: &str) {
        let mut st = self.lock();
        if st.over || st.input_closed {
            return;
        }
        let text = if line.ends_with('\n') {
            line.to_string()
        } else {
            format!("{line}\n")
        };
        // Written already, after the checkpoint this run was re-attached from: what's read again
        // since writes it again, and it isn't. The first (in order) of those it's the same as; or
        // an answer to a request that was answered already (another way, by a user asked again,
        // say): the harness has its answer.
        let mut at = st.delivered.iter().position(|d| d.text == text);
        if at.is_none()
            && let Some(answers) = answering(&text)
        {
            at = st
                .delivered
                .iter()
                .position(|d| d.answers.as_deref() == Some(answers.as_str()));
        }
        if let Some(at) = at {
            st.delivered.remove(at);
            return;
        }
        // One write, so the shim never relays half a line.
        if let Ok(mut f) = OpenOptions::new().append(true).open(self.dir.join("input.jsonl"))
            && f.write_all(text.as_bytes()).is_ok()
        {
            st.input += text.len() as u64;
        }
    }

    fn close_input(&self) {
        let mut st = self.lock();
        if st.input_closed {
            return;
        }
        st.input_closed = true;
        let _ = fs::write(self.dir.join("input.closed"), "");
    }

    fn kill(&self, signal: Signal) {
        if self.pid().is_none() {
            // The shim hasn't started it yet: it's signalled once it has.
            let mut st = self.lock();
            if !st.over {
                st.signals.push(signal);
            }
            return;
        }
        // Its group, even once the program has exited: what it started may still be running.
        terminate(&self.dir, self.grace, signal);
    }

    fn stop(&self, grace: Duration, now: bool) -> bool {
        let mut st = self.lock();
        if st.over {
            return true;
        }
        st.input_closed = true;
        drop(st);
        begin_stop(&self.dir, if now { Duration::ZERO } else { grace }, grace * 2);
        true
    }

    fn detach(&self) {
        self.lock().over = true;
        (self.done)();
    }

    fn can_detach(&self) -> bool {
        true
    }

    fn answered(&self, id: &str) -> bool {
        self.lock().delivered.iter().any(|d| d.answers.as_deref() == Some(id))
    }

    fn input_offset(&self, unanswered: &[String]) -> Option<u64> {
        let mut st = self.lock();
        // Not past a line that's to be written again (and isn't): a restart before it is must know
        // it's there. (An answer's kept only while its request's open.)
        if st.caught_up {
            st.delivered
                .retain(|d| d.answers.as_ref().is_some_and(|a| unanswered.contains(a)));
        }
        Some(st.delivered.first().map_or(st.input, |d| d.at))
    }

    fn retire(&self, unanswered: &[String]) {
        let mut st = self.lock();
        st.caught_up = true;
        st.delivered
            .retain(|d| d.answers.as_ref().is_some_and(|a| unanswered.contains(a)));
    }

    fn dir(&self) -> Option<String> {
        Some(self.dir.to_string_lossy().into())
    }
}

/// A run directory, watched with inotify: what the run writes to it (output, its pid, its exit)
/// wakes whoever's following it.
#[cfg(target_os = "linux")]
struct DirWatch(tokio::io::unix::AsyncFd<std::os::fd::OwnedFd>);

#[cfg(target_os = "linux")]
impl DirWatch {
    /// None if the directory can't be watched (it's followed by polling alone).
    fn new(dir: &Path) -> Option<Self> {
        use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
        let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        if fd < 0 {
            return None;
        }
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        let mask = libc::IN_MODIFY
            | libc::IN_CLOSE_WRITE
            | libc::IN_CREATE
            | libc::IN_MOVED_TO
            | libc::IN_DELETE_SELF
            | libc::IN_MOVE_SELF;
        if unsafe { libc::inotify_add_watch(fd.as_raw_fd(), path.as_ptr(), mask) } < 0 {
            return None;
        }
        // Safety: the fd is ours alone, and is closed only when the AsyncFd is dropped.
        unsafe { tokio::io::unix::AsyncFd::register(fd) }.ok().map(DirWatch)
    }

    /// Resolves once something in the directory has changed since the last call. Which change is
    /// left to the caller to find out: it reads the directory again.
    async fn changed(&self) {
        use std::os::fd::AsRawFd;
        loop {
            let Ok(mut ready) = self.0.readable().await else {
                // Can't be waited on: the caller's poll goes on alone.
                return std::future::pending().await;
            };
            let mut any = false;
            let mut buf = [0u8; 4096];
            loop {
                let n = unsafe { libc::read(self.0.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
                if n > 0 {
                    any = true;
                    continue;
                }
                if n < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                break;
            }
            ready.clear_ready();
            if any {
                return;
            }
        }
    }
}

/// Where there's no inotify, runs are followed by polling alone.
#[cfg(not(target_os = "linux"))]
struct DirWatch;

#[cfg(not(target_os = "linux"))]
impl DirWatch {
    fn new(_dir: &Path) -> Option<Self> {
        None
    }

    async fn changed(&self) {}
}

/// Reads a file's whole lines as they're appended, from an offset.
struct Tail {
    path: PathBuf,
    file: Option<File>,
    /// Where `pending` starts in the file.
    at: u64,
    pending: Vec<u8>,
    /// Drop what comes before the first newline (a tail started mid-line).
    skip: bool,
}

impl Tail {
    fn new(path: PathBuf, offset: u64, skip: bool) -> Self {
        Tail {
            path,
            file: None,
            at: offset,
            pending: Vec::new(),
            skip,
        }
    }

    /// The whole lines appended since the last call, each with the offset after it. Once the
    /// writer is done (`last`), a last line with no newline counts too.
    fn lines(&mut self, last: bool) -> Vec<(String, u64)> {
        self.read();
        let mut out = Vec::new();
        let mut start = 0;
        while let Some(nl) = self.pending[start..].iter().position(|&b| b == b'\n') {
            let mut line = &self.pending[start..start + nl];
            start += nl + 1;
            if self.skip {
                self.skip = false;
                continue;
            }
            if line.ends_with(b"\r") {
                line = &line[..line.len() - 1];
            }
            out.push((String::from_utf8_lossy(line).into_owned(), self.at + start as u64));
        }
        if last && start < self.pending.len() && !self.skip {
            out.push((
                String::from_utf8_lossy(&self.pending[start..]).into_owned(),
                self.at + self.pending.len() as u64,
            ));
            start = self.pending.len();
        }
        self.at += start as u64;
        self.pending.drain(..start);
        out
    }

    fn read(&mut self) {
        if self.file.is_none() {
            let Ok(f) = File::open(&self.path) else { return }; // Not there yet.
            self.file = Some(f);
        }
        let f = self.file.as_mut().unwrap();
        if f.seek(SeekFrom::Start(self.at + self.pending.len() as u64)).is_err() {
            return;
        }
        let _ = f.read_to_end(&mut self.pending);
    }
}

/// The pid in a run directory's `pid` or `shim.pid`.
fn read_pid(dir: &Path, name: &str) -> Option<u32> {
    fs::read_to_string(dir.join(name))
        .ok()?
        .trim()
        .parse()
        .ok()
        .filter(|&n| n > 0)
}

fn read_format(dir: &Path) -> u64 {
    fs::read_to_string(dir.join("run.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["format"].as_u64())
        .unwrap_or(1)
}

/// A run directory's `exit`, as an ExitStatus.
fn read_exit(dir: &Path) -> ExitStatus {
    let e: Value = match fs::read_to_string(dir.join("exit"))
        .map_err(|e| e.to_string())
        .and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string()))
    {
        Ok(v) => v,
        Err(err) => {
            return ExitStatus {
                error: Some(format!("the run's exit file can't be read: {err}")),
                ..Default::default()
            };
        }
    };
    let signal = match &e["signal"] {
        Value::Number(n) => n.as_i64().map(|n| signal_name(n as i32)),
        Value::String(s) => Some(s.clone()),
        _ => None,
    };
    ExitStatus {
        code: e["code"].as_i64().map(|c| c as i32),
        signal,
        error: e["error"].as_str().map(String::from),
    }
}

/// Which of the harness's requests an input line answers, if it's an answer: a Claude
/// `control_response`'s `request_id`, or a JSON-RPC response's `id` (Codex's).
fn answering(line: &str) -> Option<String> {
    let m: Value = serde_json::from_str(line).ok()?;
    let text = |id: &Value| match id {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    };
    if m["type"] == "control_response" {
        return text(&m["response"]["request_id"]);
    }
    let o = m.as_object()?;
    if !o.contains_key("method") && (o.contains_key("result") || o.contains_key("error")) {
        return text(o.get("id")?);
    }
    None
}

/// Writes a run directory's file whole, as the shim does.
fn write_atomic(dir: &Path, name: &str, content: &str) {
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    if fs::write(&tmp, content).is_ok() {
        let _ = fs::rename(&tmp, dir.join(name));
    }
}

/// Writes `exit` atomically, as the shim does, unless there's one.
fn write_exit(dir: &Path, exit: Value) {
    let tmp = dir.join(format!(".exit.{}.tmp", std::process::id()));
    if fs::write(&tmp, exit.to_string()).is_err() {
        return;
    }
    if dir.join("exit").exists() {
        let _ = fs::remove_file(&tmp);
    } else {
        let _ = fs::rename(&tmp, dir.join("exit"));
    }
}

fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, 0) == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    false
}

fn signal_group(pid: u32, signal: Signal) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), signal.number());
    }
}

/// Whether anything is left in process group `pgid` (whoever's it is).
fn group_exists(pgid: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pgid as i32), 0) == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    false
}

/// When the machine started (ms since the epoch), read once.
static BOOT: LazyLock<Option<u64>> = LazyLock::new(|| {
    if let Ok(stat) = fs::read_to_string("/proc/stat") {
        return stat
            .lines()
            .find_map(|l| l.strip_prefix("btime "))
            .and_then(|s| s.trim().parse::<u64>().ok())
            .map(|s| s * 1000);
    }
    // { sec = 1700000000, usec = 0 } ...
    let out = std::process::Command::new("sysctl")
        .args(["-n", "kern.boottime"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let sec = text
        .split("sec = ")
        .nth(1)?
        .split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse::<u64>()
        .ok()?;
    Some(sec * 1000)
});

/// When a run directory's file was written, if it was since the machine started (before, its pid
/// is stale).
fn written_this_boot(dir: &Path, name: &str) -> Option<u64> {
    let at = mtime_ms(&fs::metadata(dir.join(name)).ok()?);
    let boot = (*BOOT).unwrap_or(0);
    (at + 1000 >= boot).then_some(at)
}

/// A process's identity: its pid, when it started, and where that was read, since /proc and `ps`
/// don't tell it alike.
#[derive(Clone, Copy, Debug)]
struct Identity {
    pid: u32,
    start: u64,
    proc: bool,
}

/// What's known of a running process.
struct ProcInfo {
    start: u64,
    zombie: bool,
    /// Read from /proc (to the clock tick), not `ps` (to the second).
    proc: bool,
}

/// Whether the run's shim is alive: the process in `shim.pid` (written since the machine started)
/// is running (not a zombie), and is the shim, which started before `shim.pid` was written. `known`
/// keeps the identity found the first time, which the process with the pid must still have each
/// time after. When that can't be told, a running process with the pid counts as the shim.
fn shim_alive(dir: &Path, known: Option<&mut Option<Identity>>) -> bool {
    let (Some(pid), Some(written)) = (read_pid(dir, "shim.pid"), written_this_boot(dir, "shim.pid")) else {
        return false;
    };
    if !alive(pid) {
        return false;
    }
    let Some(info) = proc_info(pid) else { return true };
    if info.zombie {
        return false;
    }
    if let Some(id) = known.as_ref().and_then(|k| **k)
        && id.pid == pid
    {
        // /proc and ps agree on a start to within a second (ps has it to the second).
        return if id.proc == info.proc {
            id.start == info.start
        } else {
            id.start.abs_diff(info.start) < 1000
        };
    }
    let ours = info.start <= written + 1000;
    if ours && let Some(k) = known {
        *k = Some(Identity {
            pid,
            start: info.start,
            proc: info.proc,
        });
    }
    ours
}

/// A process's start (ms since the epoch) and state, if it's running and that can be told: from
/// /proc on Linux, or from `ps` elsewhere.
fn proc_info(pid: u32) -> Option<ProcInfo> {
    if let Some(info) = proc_stat(pid) {
        return Some(info);
    }
    let out = ps(&["-o", "stat=", "-o", "lstart=", "-p", &pid.to_string()])?;
    let out = out.trim();
    let (stat, start) = out.split_once(char::is_whitespace)?;
    let start = chrono::NaiveDateTime::parse_from_str(
        &start.split_whitespace().collect::<Vec<_>>().join(" "),
        "%a %b %d %H:%M:%S %Y",
    )
    .ok()?;
    let start = start
        .and_local_timezone(chrono::Local)
        .earliest()?
        .timestamp_millis()
        .max(0) as u64;
    Some(ProcInfo {
        start,
        zombie: stat.starts_with(['Z', 'X']),
        proc: false,
    })
}

/// Runs `ps` with LC_ALL=C, giving up after two seconds.
fn ps(args: &[&str]) -> Option<String> {
    let mut child = std::process::Command::new("ps")
        .args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    Some(out)
}

/// The fields of /proc/<pid>/stat after the command (the first is field 3, the state).
fn proc_fields(pid: &str) -> Option<Vec<String>> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // After the command, which is in parentheses and may have spaces or parentheses in it.
    let rest = &stat[stat.rfind(')')? + 2..];
    Some(rest.split(' ').map(String::from).collect())
}

/// A process's start and state from /proc/<pid>/stat and /proc/stat's btime.
fn proc_stat(pid: u32) -> Option<ProcInfo> {
    let boot = (*BOOT)?;
    let fields = proc_fields(&pid.to_string())?;
    // starttime is field 22; fields[0] here is field 3 (state). /proc counts in USER_HZ (100).
    let ticks: u64 = fields.get(19)?.parse().ok()?;
    let state = fields.first()?;
    Some(ProcInfo {
        start: boot + ticks * 10,
        zombie: state == "Z" || state == "X",
        proc: true,
    })
}

/// The session ids of the processes in process group `pgid`, if that can be told.
fn group_sessions(pgid: u32) -> Option<Vec<u32>> {
    if let Ok(entries) = fs::read_dir("/proc") {
        let mut sids = Vec::new();
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.bytes().all(|b| b.is_ascii_digit()) {
                continue;
            }
            // pgrp is field 5 and session field 6.
            if let Some(f) = proc_fields(&name)
                && f.get(2).and_then(|g| g.parse::<u32>().ok()) == Some(pgid)
                && let Some(sid) = f.get(3).and_then(|s| s.parse().ok())
            {
                sids.push(sid);
            }
        }
        return Some(sids);
    }
    let out = ps(&["-e", "-o", "pgid=", "-o", "sid="])?;
    Some(
        out.lines()
            .filter_map(|l| {
                let mut it = l.split_whitespace().map(|x| x.parse::<u32>());
                match (it.next(), it.next()) {
                    (Some(Ok(g)), Some(Ok(sid))) if g == pgid => Some(sid),
                    _ => None,
                }
            })
            .collect(),
    )
}

/// The run's process group (the program's pid), if it's still the run's and anything in it is
/// running: never a group whose id the system has since given to another process.
fn live_group(dir: &Path) -> Option<u32> {
    let pid = read_pid(dir, "pid")?;
    // Written before the machine restarted: the pid means nothing now.
    let written = written_this_boot(dir, "pid")?;
    let leader = if alive(pid) {
        // Can't tell whose it is.
        Some(proc_info(pid)?)
    } else {
        None
    };
    if let Some(leader) = leader.filter(|l| !l.zombie) {
        // The program, if it started before its pid was written; not a new process given the same
        // pid.
        return (leader.start <= written + 1000).then_some(pid);
    }
    // The program's gone. What's left in a group with its id is the run's only if it's in the
    // run's session, which the shim leads (its pid is the session's id).
    let shim = read_pid(dir, "shim.pid")?;
    written_this_boot(dir, "shim.pid")?;
    let sids = group_sessions(pid)?;
    (!sids.is_empty() && sids.iter().all(|&s| s == shim)).then_some(pid)
}

/// A run being stopped (its `stopping` file): when its group gets SIGTERM, if it hasn't yet, and
/// when SIGKILL.
fn read_stopping(dir: &Path) -> Option<(Option<u64>, u64)> {
    let s: Value = serde_json::from_str(&fs::read_to_string(dir.join("stopping")).ok()?).ok()?;
    let kill = s["kill_at"].as_f64()? as u64;
    Some((s["term_at"].as_f64().map(|t| t as u64), kill))
}

/// Held while a run's `stopping` is read, changed and acted on, so this backend's stops of a run (an
/// escalation, a terminate(), a begin_stop()) never both take a SIGTERM as still to send.
fn stopping_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Signals the run's process group, if it's still the run's; after SIGTERM (or another signal),
/// SIGKILL to whatever is left of it after `grace`, even if the program itself has exited. That's
/// written down (`stopping`), so a backend that restarts before then carries on with it.
fn terminate(dir: &Path, grace: Duration, signal: Signal) {
    let Some(pid) = live_group(dir) else { return };
    let lock = stopping_lock();
    match read_stopping(dir) {
        // A stop under way whose SIGTERM is still to come doesn't send it again: written down
        // first.
        Some((Some(_), kill_at)) if signal == Signal::Term => {
            write_atomic(dir, "stopping", &json!({"kill_at": kill_at}).to_string())
        }
        None if signal != Signal::Kill => write_atomic(
            dir,
            "stopping",
            &json!({"kill_at": now_ms() + grace.as_millis() as u64}).to_string(),
        ),
        _ => {}
    }
    signal_group(pid, signal);
    drop(lock);
    if signal != Signal::Kill {
        escalate(dir);
    }
}

/// Stops a run: ends its input, then SIGTERM to its group in `term` (if it's still there) and
/// SIGKILL in `kill`. It's written down first (`stopping`, with both deadlines), so a backend that
/// restarts meanwhile carries on with it. A stop already under way only ever comes sooner.
fn begin_stop(dir: &Path, term: Duration, kill: Duration) {
    let lock = stopping_lock();
    let now = now_ms();
    let was = read_stopping(dir);
    // Once SIGTERM's gone (no term_at), it isn't sent again.
    let term_at = match was {
        Some((None, _)) => None,
        Some((Some(t), _)) => Some(t.min(now + term.as_millis() as u64)),
        None => Some(now + term.as_millis() as u64),
    };
    let kill_at = was.map_or(u64::MAX, |(_, k)| k).min(now + kill.as_millis() as u64);
    let stopping = match term_at {
        Some(t) => json!({"term_at": t, "kill_at": kill_at}),
        None => json!({"kill_at": kill_at}),
    };
    write_atomic(dir, "stopping", &stopping.to_string());
    drop(lock);
    if fs::write(dir.join("input.closed"), "").is_err() {
        return; // Its directory's gone.
    }
    escalate(dir);
}

/// Runs whose groups this backend is waiting to SIGTERM or SIGKILL.
static ESCALATING: LazyLock<Mutex<HashMap<PathBuf, tokio::task::JoinHandle<()>>>> = LazyLock::new(Default::default);

/// Carries on stopping a run (it has `stopping`): SIGTERM to its group at `term_at`, SIGKILL to
/// what's left of it at `kill_at`, each only if the group is still the run's, until it has gone. A
/// run its shim hasn't started yet is waited for (while its shim may still start it); one whose
/// shim has gone gets the `exit` the shim would have written. A backend killed meanwhile carries on
/// after it restarts (when it re-attaches, or in prune()); one that closes waits for it
/// ([`Spawner::settle`]).
fn escalate(dir: &Path) {
    let mut escalating = ESCALATING.lock().unwrap();
    if escalating.get(dir).is_some_and(|h| !h.is_finished()) {
        return;
    }
    let Ok(rt) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let d = dir.to_path_buf();
    let handle = rt.spawn(async move {
        let mut checked = false;
        loop {
            let Some((term_at, kill_at)) = read_stopping(&d) else {
                return;
            };
            let pid = read_pid(&d, "pid");
            let exited = d.join("exit").exists();
            let Some(pid) = pid else {
                let has_shim = read_pid(&d, "shim.pid").is_some();
                let never = exited
                    || if has_shim {
                        !shim_alive(&d, None)
                    } else {
                        now_ms().saturating_sub(started_at(&d)) > START_TIMEOUT_MS
                    };
                if never {
                    let _ = fs::remove_file(d.join("stopping"));
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            };
            if !group_exists(pid) {
                let _ = fs::remove_file(d.join("stopping"));
                return;
            }
            if !checked {
                checked = true;
                if !exited && !shim_alive(&d, None) {
                    write_exit(
                        &d,
                        json!({"code": null, "signal": null, "error": "its supervisor (agent-threads-shim) went away"}),
                    );
                }
            }
            let now = now_ms();
            if now >= kill_at {
                if let Some(group) = live_group(&d) {
                    signal_group(group, Signal::Kill);
                }
                let _ = fs::remove_file(d.join("stopping"));
                return;
            }
            if let Some(t) = term_at
                && now >= t
            {
                // Read again under the lock: a terminate() may have sent it meanwhile. Written down
                // first: it's sent once.
                let _lock = stopping_lock();
                if let Some((Some(_), kill_at)) = read_stopping(&d) {
                    write_atomic(&d, "stopping", &json!({"kill_at": kill_at}).to_string());
                    if let Some(group) = live_group(&d) {
                        signal_group(group, Signal::Term);
                    }
                }
            }
            let next = match term_at {
                Some(t) if t > now => t,
                _ => kill_at,
            };
            tokio::time::sleep(Duration::from_millis(next.saturating_sub(now).min(100))).await;
        }
    });
    escalating.insert(dir.to_path_buf(), handle);
}

/// When the run was started (run.json written), as near as can be told.
fn started_at(dir: &Path) -> u64 {
    for p in [dir.join("run.json"), dir.to_path_buf()] {
        if let Ok(m) = fs::metadata(p) {
            return mtime_ms(&m);
        }
    }
    0
}

/// Kills every run in `runs_dir` at once, without waiting for anything: SIGKILL to each run's shim
/// and to its group (if they're still the run's). For tests, so one that fails leaves no process
/// behind; an app stops its runs with [`AgentThreads::close`](crate::AgentThreads::close).
#[doc(hidden)]
pub fn kill_runs(runs_dir: &Path) {
    let Ok(entries) = fs::read_dir(runs_dir) else { return };
    for dir in entries.flatten().map(|e| e.path()).filter(|d| d.is_dir()) {
        let _ = fs::write(dir.join("input.closed"), "");
        // The shim first, so it starts nothing more.
        if let Some(pid) = read_pid(&dir, "shim.pid")
            && proc_info(pid).is_some()
            && shim_alive(&dir, None)
        {
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        }
        if let Some(group) = live_group(&dir) {
            signal_group(group, Signal::Kill);
        }
    }
}

/// Stops the run in `dir`, which nothing follows: ends its input, then SIGTERM to its group and
/// SIGKILL after `grace`.
fn stop_dir(dir: &Path, grace: Duration) {
    begin_stop(dir, Duration::ZERO, grace);
}
