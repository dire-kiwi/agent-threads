//! The spec directory, and temporary directories, for the tests.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

pub fn spec_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spec").canonicalize().unwrap()
}

pub fn read_json(path: &str) -> Value {
    let path = spec_dir().join(path);
    serde_json::from_str(&fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

pub fn read_jsonl(path: &str) -> Vec<Value> {
    let path = spec_dir().join(path);
    fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

/// A new temporary directory, kept for the rest of the test run (the OS clears /tmp).
pub fn temp_dir() -> PathBuf {
    tempfile::Builder::new().prefix("agent-threads-").tempdir().unwrap().keep()
}

/// agent-threads-shim, built from ../../shim if it isn't yet (or from $AGENT_THREADS_SHIM).
pub fn shim_path() -> PathBuf {
    if let Ok(p) = std::env::var("AGENT_THREADS_SHIM") {
        return PathBuf::from(p);
    }
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../shim");
    let bin = dir.join("target/debug/agent-threads-shim");
    static BUILD: std::sync::Once = std::sync::Once::new();
    BUILD.call_once(|| {
        if !bin.exists() {
            let ok = std::process::Command::new("cargo")
                .args(["build", "--quiet", "--manifest-path"])
                .arg(dir.join("Cargo.toml"))
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            assert!(ok, "agent-threads-shim couldn't be built");
        }
    });
    bin
}
