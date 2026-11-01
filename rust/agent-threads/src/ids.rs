//! Ids the backend picks (threads, turns, requests, and the items it makes itself), and timestamps.

use std::time::{SystemTime, UNIX_EPOCH};

/// A new id, `<prefix>_<time><random>`, so ids made later sort later.
pub(crate) fn new_id(prefix: &str) -> String {
    let mut bytes = [0u8; 6];
    let _ = getrandom::fill(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{prefix}_{}{hex}", base36(now_ms()))
}

/// Milliseconds since the epoch.
pub(crate) fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Now, as an RFC 3339 timestamp in UTC with milliseconds, as JavaScript's toISOString() has it.
pub(crate) fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// An RFC 3339 timestamp's milliseconds since the epoch.
pub(crate) fn parse_iso_ms(s: &str) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|t| t.timestamp_millis().max(0) as u64)
}

/// A random token, URL-safe.
pub(crate) fn token(bytes: usize) -> String {
    use base64::Engine;
    let mut buf = vec![0u8; bytes];
    let _ = getrandom::fill(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
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
