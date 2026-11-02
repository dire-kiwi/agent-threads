//! Ids the backend picks (threads, turns, requests, and the items it makes itself), and timestamps.

use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// A new id, `<prefix>_<time><random>`, so ids made later sort later. Ids needn't be secret, only
/// distinct: where the OS has no randomness to give, a counter and the process id stand in for it.
pub(crate) fn new_id(prefix: &str) -> String {
    let mut bytes = [0u8; 6];
    if getrandom::fill(&mut bytes).is_err() {
        static COUNT: AtomicU64 = AtomicU64::new(0);
        let n = COUNT.fetch_add(1, Ordering::Relaxed) ^ ((std::process::id() as u64) << 24);
        bytes.copy_from_slice(&n.to_be_bytes()[2..]);
    }
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{prefix}_{}{hex}", base36(now_ms()))
}

/// A new directory in the OS's temporary directory, made for this alone (it didn't exist) and, on
/// Unix, readable by the user only (0700): for a thread's generated files and attachments.
pub(crate) fn private_temp_dir() -> io::Result<PathBuf> {
    for _ in 0..16 {
        let dir = std::env::temp_dir().join(new_id("agent-threads"));
        let mut b = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
        match b.create(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "no new temporary directory could be made",
    ))
}

/// Milliseconds since the epoch.
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Now, as an RFC 3339 timestamp in UTC with milliseconds, as JavaScript's toISOString() has it.
pub(crate) fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// An RFC 3339 timestamp's milliseconds since the epoch.
pub(crate) fn parse_iso_ms(s: &str) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|t| t.timestamp_millis().max(0) as u64)
}

/// A random token, URL-safe; an error if the OS has no randomness to give.
pub(crate) fn token(bytes: usize) -> io::Result<String> {
    use base64::Engine;
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| io::Error::other(format!("no random token could be made: {e}")))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf))
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

/// Unix seconds as an RFC 3339 time, to the second (`YYYY-MM-DDTHH:MM:SSZ`), if it's a time.
pub(crate) fn unix_time(seconds: f64) -> Option<String> {
    if !seconds.is_finite() {
        return None;
    }
    let t = chrono::DateTime::from_timestamp(seconds.floor() as i64, 0)?;
    Some(t.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}
