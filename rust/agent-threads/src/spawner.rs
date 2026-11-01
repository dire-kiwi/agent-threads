//! How harness processes are started. [`direct`] runs them as child processes, which end with the
//! backend; [`shim`](crate::shim()) runs them under agent-threads-shim, so they outlive it and a
//! restarted backend re-attaches to them.

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::store::{RunRecord, Store, StoreResult};

/// What a process is started with.
#[derive(Clone, Debug)]
pub struct SpawnOptions {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// Its whole environment.
    pub env: HashMap<String, String>,
    /// The thread the process runs, and the run's id, for spawners that keep records.
    pub thread_id: String,
    pub run_id: String,
}

/// How a process ended.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ExitStatus {
    pub code: Option<i32>,
    /// The signal that killed it, by name (`SIGTERM`).
    pub signal: Option<String>,
    /// Why it couldn't be started, or why its end is unknown.
    pub error: Option<String>,
}

/// What a process says, in order.
#[derive(Clone, Debug)]
pub enum ProcessEvent {
    /// A line of its stdout; with a durable spawner, with how far into its output the lines given
    /// so far go (bytes), which the backend saves with the events it made of them.
    Line { line: String, end: Option<u64> },
    /// A line of its stderr.
    Stderr(String),
    /// A re-attached run's output has been read again as far as it went when the backend
    /// re-attached: input written before that won't be written again (see
    /// [`HarnessProcess::retire`]).
    CaughtUp,
    /// It ended (or never started), after its last line.
    Exit(ExitStatus),
}

/// A signal for a process's group.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    Term,
    Kill,
    Int,
}

impl Signal {
    pub(crate) fn number(self) -> i32 {
        match self {
            Signal::Term => libc::SIGTERM,
            Signal::Kill => libc::SIGKILL,
            Signal::Int => libc::SIGINT,
        }
    }
}

/// A process's name for a signal number.
pub(crate) fn signal_name(n: i32) -> String {
    match n {
        libc::SIGHUP => "SIGHUP".into(),
        libc::SIGINT => "SIGINT".into(),
        libc::SIGQUIT => "SIGQUIT".into(),
        libc::SIGABRT => "SIGABRT".into(),
        libc::SIGKILL => "SIGKILL".into(),
        libc::SIGSEGV => "SIGSEGV".into(),
        libc::SIGPIPE => "SIGPIPE".into(),
        libc::SIGTERM => "SIGTERM".into(),
        _ => n.to_string(),
    }
}

/// A running harness process, as its driver sees it.
pub trait HarnessProcess: Send + Sync {
    fn pid(&self) -> Option<u32>;
    /// Writes a line to its stdin.
    fn write(&self, line: &str);
    /// Closes its stdin.
    fn close_input(&self);
    /// Signals it, and whatever it started (its process group).
    fn kill(&self, signal: Signal);
    /// Stops it: closes its stdin, then SIGTERM in `grace` (at once with `now`) and SIGKILL in twice
    /// that, unless it has gone. A process that outlives the backend writes that down first, so a
    /// backend that restarts meanwhile carries on with it. Whether it does this; if not, the driver
    /// does it with `close_input` and `kill`.
    fn stop(&self, _grace: Duration, _now: bool) -> bool {
        false
    }
    /// Stops following it and leaves it running, for a backend that's shutting down and will
    /// re-attach (a process that outlives the backend only). No event comes after this.
    fn detach(&self) {}
    /// Whether an answer to its request `id` was written to its input already, after the checkpoint
    /// it was re-attached from (and before the backend restarted): the harness has it, so the
    /// request isn't asked again.
    fn answered(&self, _id: &str) -> bool {
        false
    }
    /// Whether it can be left running with [`detach`](Self::detach).
    fn can_detach(&self) -> bool {
        false
    }
    /// How much of its input has been written (bytes), for a process that outlives the backend:
    /// saved with the driver's state, so input written after it isn't written again when what led
    /// to it is read again after a restart. `unanswered` is the harness's requests the driver has
    /// yet to answer (Claude's control requests' `request_id`s, Codex's JSON-RPC ids).
    fn input_offset(&self, _unanswered: &[String]) -> Option<u64> {
        None
    }
    /// Forgets the input written before a restart that won't be written again (after
    /// [`ProcessEvent::CaughtUp`]): all of it but answers to requests in `unanswered`.
    fn retire(&self, _unanswered: &[String]) {}
    /// Where its files are (the shim's run directory).
    fn dir(&self) -> Option<String> {
        None
    }
}

/// A process just started or re-attached to, and its events.
pub type Spawned = (Arc<dyn HarnessProcess>, mpsc::UnboundedReceiver<ProcessEvent>);

/// How harness processes are started.
#[async_trait]
pub trait Spawner: Send + Sync {
    /// `direct` or `shim`.
    fn name(&self) -> &str;
    /// Its processes outlive the backend. The backend then saves each run (its offset and what's
    /// needed to carry on reading it) with the thread's events, and re-attaches after a restart.
    fn durable(&self) -> bool {
        false
    }
    fn spawn(&self, options: SpawnOptions) -> io::Result<Spawned>;
    /// Whether it can follow a run started before a restart.
    fn can_attach(&self) -> bool {
        false
    }
    /// Follows a run started before a restart, from the offset saved with it.
    fn attach(&self, _run: &RunRecord) -> io::Result<Spawned> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "this spawner can't re-attach to runs",
        ))
    }
    /// Stops a run nothing will follow (its thread has gone on without it, or can't re-attach):
    /// ends its input and signals its process group, escalating to SIGKILL.
    fn stop_run(&self, _run: &RunRecord) {}
    /// Removes what's left of runs the backend is done with (their directories), after the time it
    /// keeps them, and stops runs that aren't the store's. The number removed.
    async fn prune(&self, _store: &dyn Store) -> StoreResult<usize> {
        Ok(0)
    }
    /// Whether it has anything to prune.
    fn prunes(&self) -> bool {
        false
    }
    /// Resolves once what it's doing in the background (stopping runs) is done, for a backend
    /// that's closing.
    async fn settle(&self) {}
}

/// Runs harness processes as children of the backend, each in its own process group.
pub fn direct() -> Arc<dyn Spawner> {
    Arc::new(Direct)
}

struct Direct;

impl Spawner for Direct {
    fn name(&self) -> &str {
        "direct"
    }

    fn spawn(&self, o: SpawnOptions) -> io::Result<Spawned> {
        let mut cmd = tokio::process::Command::new(&o.command);
        cmd.args(&o.args)
            .env_clear()
            .envs(&o.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = &o.cwd {
            cmd.current_dir(cwd);
        }
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd.spawn()?;
        let pid = child.id();
        let (events, rx) = mpsc::unbounded_channel();
        let (input, mut lines) = mpsc::unbounded_channel::<String>();
        let mut stdin = child.stdin.take();
        // Writing to a process that has gone fails; its exit says what happened.
        tokio::spawn(async move {
            while let Some(line) = lines.recv().await {
                let Some(w) = stdin.as_mut() else { break };
                if w.write_all(line.as_bytes()).await.is_err() || w.flush().await.is_err() {
                    break;
                }
            }
        });
        let closed = Arc::new(AtomicBool::new(false));
        let out = tokio::spawn(read_lines(child.stdout.take().unwrap(), events.clone(), false));
        let err = tokio::spawn(read_lines(child.stderr.take().unwrap(), events.clone(), true));
        let done = closed.clone();
        tokio::spawn(async move {
            let status = child.wait().await;
            // After the process exits and its stdio ends, so after the last line. Until then
            // something it started may still hold its stdio, so its group can still be signalled.
            let _ = out.await;
            let _ = err.await;
            done.store(true, Ordering::SeqCst);
            let status = match status {
                Ok(s) => exit_status(s),
                Err(e) => ExitStatus {
                    error: Some(e.to_string()),
                    ..Default::default()
                },
            };
            let _ = events.send(ProcessEvent::Exit(status));
        });
        let proc = DirectProcess {
            pid,
            input: Mutex::new(Some(input)),
            closed,
        };
        Ok((Arc::new(proc), rx))
    }
}

pub(crate) fn exit_status(s: std::process::ExitStatus) -> ExitStatus {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        ExitStatus {
            code: s.code(),
            signal: s.signal().map(signal_name),
            error: None,
        }
    }
    #[cfg(not(unix))]
    ExitStatus {
        code: s.code(),
        signal: None,
        error: None,
    }
}

/// Sends each line of `r` (stderr ones as such) until it ends.
async fn read_lines(r: impl AsyncRead + Unpin, events: mpsc::UnboundedSender<ProcessEvent>, stderr: bool) {
    let mut r = BufReader::new(r);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match r.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if buf.ends_with(b"\n") {
            buf.pop();
        }
        if buf.ends_with(b"\r") {
            buf.pop();
        }
        let line = String::from_utf8_lossy(&buf).into_owned();
        let e = if stderr {
            ProcessEvent::Stderr(line)
        } else {
            ProcessEvent::Line { line, end: None }
        };
        if events.send(e).is_err() {
            return;
        }
    }
}

struct DirectProcess {
    pid: Option<u32>,
    input: Mutex<Option<mpsc::UnboundedSender<String>>>,
    closed: Arc<AtomicBool>,
}

impl HarnessProcess for DirectProcess {
    fn pid(&self) -> Option<u32> {
        self.pid
    }

    fn write(&self, line: &str) {
        if let Some(input) = self.input.lock().unwrap().as_ref() {
            let _ = input.send(if line.ends_with('\n') {
                line.to_string()
            } else {
                format!("{line}\n")
            });
        }
    }

    fn close_input(&self) {
        // The writer ends once it has written what's queued, and drops stdin.
        self.input.lock().unwrap().take();
    }

    fn kill(&self, signal: Signal) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        let Some(pid) = self.pid else { return };
        #[cfg(unix)]
        unsafe {
            // The group outlives its leader while anything in it runs.
            if libc::kill(-(pid as i32), signal.number()) != 0 {
                libc::kill(pid as i32, signal.number());
            }
        }
    }
}
