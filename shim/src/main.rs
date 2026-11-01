//! agent-threads-shim: runs one harness process so that it outlives the backend that started it.
//!
//! Usage: `agent-threads-shim <rundir> -- <program> [args...]`
//!
//! It forks (the launcher gets control back at once) and calls setsid, then runs the program in a
//! process group of its own, with stdout appended to `<rundir>/out.jsonl` and stderr to
//! `<rundir>/err.log`. The program's stdin is a pipe: the shim writes `prompt` to it (if there is
//! one), then, if the run directory has an `input.jsonl`, whatever is appended to that as it
//! arrives, and closes it once `input.closed` exists and everything before it has gone through. It
//! records its own pid in `shim.pid` and the program's (also its process group's id) in `pid`, and
//! once the program exits, how in `exit`: `{"code":0,"signal":null}`, with an `error` if it couldn't
//! be started. The working directory and environment are inherited.
//!
//! spec/RUNDIR.md specifies the run directory; this is a port of Huntaway's ia-shim. Shims that are
//! running are never upgraded, so it's kept small, depends on nothing but libc, and should rarely
//! change. It's Unix-only.

#[cfg(unix)]
fn main() {
    unix::main()
}

#[cfg(not(unix))]
fn main() {
    eprintln!("agent-threads-shim runs on Unix only");
    std::process::exit(2);
}

#[cfg(unix)]
mod unix {
    use std::fs::{self, File, OpenOptions};
    use std::io::{Read, Write};
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    use std::path::Path;
    use std::process::{ChildStdin, Command, Stdio};
    use std::time::Duration;

    /// How often the relay looks for more input.
    const POLL: Duration = Duration::from_millis(20);

    pub fn main() {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if args.len() < 3 || args[1] != "--" {
            eprintln!("usage: agent-threads-shim <rundir> -- <program> [args...]");
            std::process::exit(2);
        }
        let dir = Path::new(&args[0]);
        let (program, program_args) = (&args[2], &args[3..]);
        if !dir.is_dir() {
            eprintln!("agent-threads-shim: {} isn't a directory", dir.display());
            std::process::exit(2);
        }

        // The launcher gets control back straight away, and the new session has no controlling
        // terminal or process group of the launcher's, so nothing that happens to it reaches us.
        unsafe {
            match libc::fork() {
                -1 => fail(dir, "fork failed"),
                0 => {}
                _ => std::process::exit(0),
            }
            libc::setsid();
        }
        write_atomic(dir, "shim.pid", &std::process::id().to_string());

        let append = |name: &str| OpenOptions::new().create(true).append(true).open(dir.join(name));
        let (out, err) = match (append("out.jsonl"), append("err.log")) {
            (Ok(o), Ok(e)) => (o, e),
            _ => fail(dir, "couldn't open out.jsonl and err.log"),
        };
        let mut child = match Command::new(program)
            .args(program_args)
            .stdin(Stdio::piped())
            .stdout(out)
            .stderr(err)
            // A group of its own, so everything it starts can be signalled with kill(-pid).
            .process_group(0)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => fail(dir, &format!("couldn't start {program}: {e}")),
        };
        write_atomic(dir, "pid", &child.id().to_string());
        if let Some(pipe) = child.stdin.take() {
            let dir = dir.to_path_buf();
            std::thread::spawn(move || relay(&dir, pipe));
        }
        let exit = match child.wait() {
            Ok(s) => format!(r#"{{"code":{},"signal":{}}}"#, opt(s.code()), opt(s.signal())),
            Err(e) => format!(
                r#"{{"code":null,"signal":null,"error":{}}}"#,
                json_string(&e.to_string())
            ),
        };
        write_atomic(dir, "exit", &exit);
    }

    /// Gives the program `prompt`, then `input.jsonl` as it grows, until `input.closed` appears.
    /// Returns (closing its stdin) once that's done, or once the program stops reading.
    fn relay(dir: &Path, mut pipe: ChildStdin) {
        if let Ok(prompt) = fs::read(dir.join("prompt"))
            && pipe.write_all(&prompt).is_err()
        {
            return;
        }
        let Ok(mut input) = File::open(dir.join("input.jsonl")) else {
            return;
        };
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            // Looked for before reading, so everything written before the marker goes through.
            let closed = dir.join("input.closed").exists();
            loop {
                match input.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) if pipe.write_all(&buf[..n]).is_ok() => {}
                    _ => return,
                }
            }
            if closed {
                return;
            }
            std::thread::sleep(POLL);
        }
    }

    fn fail(dir: &Path, msg: &str) -> ! {
        write_atomic(
            dir,
            "exit",
            &format!(r#"{{"code":null,"signal":null,"error":{}}}"#, json_string(msg)),
        );
        std::process::exit(1);
    }

    /// Backends poll for these files, so they must never see one half-written.
    fn write_atomic(dir: &Path, name: &str, content: &str) {
        let tmp = dir.join(format!(".{name}.tmp"));
        if fs::write(&tmp, content).is_ok() {
            let _ = fs::rename(tmp, dir.join(name));
        }
    }

    fn opt(v: Option<i32>) -> String {
        v.map(|n| n.to_string()).unwrap_or_else(|| "null".into())
    }

    fn json_string(s: &str) -> String {
        let mut out = String::from("\"");
        for c in s.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out.push('"');
        out
    }
}
