//! The shim, run as a backend runs it: it detaches, and everything it does is seen in the run
//! directory.
#![cfg(unix)]

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

const SHIM: &str = env!("CARGO_BIN_EXE_agent-threads-shim");

fn rundir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("agent-threads-shim-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Starts the shim on `sh -c script`; it returns as soon as it has forked.
fn launch(dir: &Path, script: &str) {
    let status = Command::new(SHIM)
        .arg(dir)
        .args(["--", "sh", "-c", script])
        .status()
        .unwrap();
    assert!(status.success());
}

fn wait_for(dir: &Path, name: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(s) = fs::read_to_string(dir.join(name)) {
            return s;
        }
        assert!(Instant::now() < deadline, "no {name} in {}", dir.display());
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn read(dir: &Path, name: &str) -> String {
    fs::read_to_string(dir.join(name)).unwrap_or_default()
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

#[test]
fn records_output_and_how_it_exited() {
    let dir = rundir("output");
    launch(&dir, "echo '{\"a\":1}'; echo oops >&2; echo '{\"b\":2}'; exit 3");
    assert_eq!(wait_for(&dir, "exit"), r#"{"code":3,"signal":null}"#);
    assert_eq!(read(&dir, "out.jsonl"), "{\"a\":1}\n{\"b\":2}\n");
    assert_eq!(read(&dir, "err.log"), "oops\n");
    let pid: i32 = read(&dir, "pid").parse().unwrap();
    let shim: i32 = read(&dir, "shim.pid").parse().unwrap();
    assert!(pid > 0 && shim > 0 && pid != shim);
    // No temporary files are left behind.
    let mut names: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, ["err.log", "exit", "out.jsonl", "pid", "shim.pid"]);
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn gives_the_prompt_then_relays_input_until_it_is_closed() {
    let dir = rundir("input");
    fs::write(dir.join("prompt"), "first\n").unwrap();
    fs::write(dir.join("input.jsonl"), "").unwrap();
    launch(&dir, "while read -r line; do echo \"got $line\"; done; echo eof");
    wait_for(&dir, "pid");
    let mut input = fs::OpenOptions::new()
        .append(true)
        .open(dir.join("input.jsonl"))
        .unwrap();
    input.write_all(b"second\n").unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while read(&dir, "out.jsonl") != "got first\ngot second\n" {
        assert!(Instant::now() < deadline, "out.jsonl: {:?}", read(&dir, "out.jsonl"));
        std::thread::sleep(Duration::from_millis(10));
    }
    // Still reading: its input isn't closed.
    std::thread::sleep(Duration::from_millis(100));
    assert!(!dir.join("exit").exists());
    // What's written before input.closed still goes through.
    input.write_all(b"third\n").unwrap();
    fs::write(dir.join("input.closed"), "").unwrap();
    assert_eq!(wait_for(&dir, "exit"), r#"{"code":0,"signal":null}"#);
    assert_eq!(read(&dir, "out.jsonl"), "got first\ngot second\ngot third\neof\n");
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn closes_stdin_after_the_prompt_when_the_run_takes_no_input() {
    let dir = rundir("prompt-only");
    fs::write(dir.join("prompt"), "only\n").unwrap();
    launch(&dir, "cat; echo done");
    assert_eq!(wait_for(&dir, "exit"), r#"{"code":0,"signal":null}"#);
    assert_eq!(read(&dir, "out.jsonl"), "only\ndone\n");
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn runs_the_program_in_a_group_of_its_own_that_can_be_stopped_whole() {
    let dir = rundir("group");
    fs::write(dir.join("input.jsonl"), "").unwrap();
    // A child of the program's that would outlive it if only the program were signalled.
    launch(&dir, "sleep 30 & echo $!; wait");
    wait_for(&dir, "pid");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !read(&dir, "out.jsonl").ends_with('\n') {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    let pid: i32 = read(&dir, "pid").parse().unwrap();
    let sleeper: i32 = read(&dir, "out.jsonl").trim().parse().unwrap();
    let shim: i32 = read(&dir, "shim.pid").parse().unwrap();
    assert_eq!(unsafe { libc::getpgid(pid) }, pid);
    assert_eq!(unsafe { libc::getpgid(sleeper) }, pid);
    // The shim leads a session of its own, apart from the program's group.
    assert_eq!(unsafe { libc::getsid(shim) }, shim);
    assert_ne!(unsafe { libc::getpgid(shim) }, pid);
    unsafe { libc::kill(-pid, libc::SIGTERM) };
    assert_eq!(
        wait_for(&dir, "exit"),
        format!(r#"{{"code":null,"signal":{}}}"#, libc::SIGTERM)
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while alive(sleeper) || alive(shim) {
        assert!(Instant::now() < deadline, "the group's still running");
        std::thread::sleep(Duration::from_millis(10));
    }
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn records_why_a_program_could_not_be_started() {
    let dir = rundir("missing");
    let status = Command::new(SHIM)
        .arg(&dir)
        .args(["--", "/nonexistent/program"])
        .status()
        .unwrap();
    assert!(status.success());
    let exit = wait_for(&dir, "exit");
    assert!(
        exit.starts_with(r#"{"code":null,"signal":null,"error":"couldn't start /nonexistent/program: "#),
        "{exit}"
    );
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn refuses_bad_arguments() {
    let out = Command::new(SHIM).args(["/tmp", "sh"]).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("usage"));
}
