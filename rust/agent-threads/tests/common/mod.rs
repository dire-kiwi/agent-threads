//! The spec directory, and temporary directories, for the tests.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

pub fn spec_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../spec")
        .canonicalize()
        .unwrap()
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

/// A new temporary directory under the target directory's (not /tmp), removed when the test
/// process exits.
pub fn temp_dir() -> PathBuf {
    static ROOT: std::sync::LazyLock<tempfile::TempDir> = std::sync::LazyLock::new(|| {
        let base = Path::new(env!("CARGO_TARGET_TMPDIR"));
        fs::create_dir_all(base).unwrap();
        let root = tempfile::Builder::new()
            .prefix("agent-threads-")
            .tempdir_in(base)
            .unwrap();
        let path = root.path().to_path_buf();
        // Statics aren't dropped, so it's removed at exit.
        extern "C" fn cleanup() {
            if let Some(p) = CLEANUP.get() {
                let _ = fs::remove_dir_all(p);
            }
        }
        CLEANUP.set(path).ok();
        unsafe { libc_atexit(cleanup) };
        root
    });
    tempfile::Builder::new().tempdir_in(ROOT.path()).unwrap().keep()
}

static CLEANUP: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

unsafe extern "C" {
    #[link_name = "atexit"]
    fn libc_atexit(f: extern "C" fn()) -> i32;
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

/// The Node backend's scriptable stand-ins for `claude` and `codex` (mini-claude.mjs,
/// mini-codex.mjs), for what the recorded fixtures don't cover.
pub fn mini(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../ts/packages/node/src/test")
        .join(format!("mini-{name}.mjs"))
        .canonicalize()
        .unwrap()
}

/// Compares events with a fixture's expected events by spec/tools/check-events.mjs's rules (the
/// expected ones without deltas when `saved_only`). Err with the first difference.
pub fn compare(fixture: &str, events: &[Value], saved_only: bool) -> Result<(), String> {
    let mut expected = read_jsonl(&format!("fixtures/{fixture}/expected.jsonl"));
    if saved_only {
        expected.retain(|e| e["type"] != "delta");
    }
    let dir = temp_dir();
    let write = |name: &str, list: &[Value]| {
        let text: String = list.iter().map(|e| format!("{e}\n")).collect();
        fs::write(dir.join(name), text).unwrap();
        dir.join(name)
    };
    let (e, a) = (write("expected.jsonl", &expected), write("actual.jsonl", events));
    let script = format!(
        "import {{ compare }} from {:?}; import {{ readFileSync }} from 'node:fs';\n\
         const read = (p) => readFileSync(p, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));\n\
         const r = compare(read(process.argv[1]), read(process.argv[2]));\n\
         if (!r.ok) {{ console.log(r.error); process.exit(1); }}",
        format!("file://{}", spec_dir().join("tools/check-events.mjs").display())
    );
    let out = std::process::Command::new("node")
        .args(["--input-type=module", "-e", &script])
        .arg(&e)
        .arg(&a)
        .output()
        .unwrap();
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ))
    }
}

/// Waits until `what` gives something, for up to `secs` seconds.
pub async fn until<T, F: std::future::Future<Output = Option<T>>>(secs: u64, mut what: impl FnMut() -> F) -> T {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    loop {
        if let Some(v) = what().await {
            return v;
        }
        assert!(std::time::Instant::now() < deadline, "timed out");
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
}

/// Waits until the thread is idle (or failed), with no message queued, and returns its snapshot
/// as JSON.
pub async fn settle(sdk: &agent_threads::AgentThreads, id: &str) -> Value {
    until(10, || async {
        let s = serde_json::to_value(sdk.snapshot(id).await.unwrap()).unwrap();
        let status = s["thread"]["status"].as_str().unwrap_or("");
        let queued = s["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["type"] == "user_message" && i["queued"] == true);
        ((status == "idle" || status == "error") && !queued).then_some(s)
    })
    .await
}

/// A snapshot's items of a type.
pub fn items<'a>(s: &'a Value, ty: &str) -> Vec<&'a Value> {
    s["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["type"] == ty)
        .collect()
}

/// What the agent said, in order.
pub fn texts(s: &Value) -> Vec<String> {
    items(s, "assistant_message")
        .iter()
        .map(|i| i["text"].as_str().unwrap().to_string())
        .collect()
}

/// What each run of mini-claude or mini-codex was started with and sent, from its log.
pub struct MiniRun {
    pub argv: Vec<String>,
    /// Its CLAUDE_CONFIG_DIR or CODEX_HOME, and the variables MINI_LOG_ENV names (null if unset).
    pub config_dir: Option<String>,
    pub env: Value,
    pub sent: Vec<Value>,
    pub notes: Vec<Value>,
}

pub fn mini_runs(log: &Path) -> Vec<MiniRun> {
    let Ok(text) = fs::read_to_string(log) else {
        return Vec::new();
    };
    let mut out: Vec<MiniRun> = Vec::new();
    for l in text.lines().filter(|l| !l.is_empty()) {
        let v: Value = serde_json::from_str(l).unwrap();
        if let Some(argv) = v.get("argv") {
            let argv = argv
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a.as_str().unwrap().to_string())
                .collect();
            let config_dir = v.get("configDir").or(v.get("codexHome")).and_then(Value::as_str);
            out.push(MiniRun {
                argv,
                config_dir: config_dir.map(String::from),
                env: v.get("env").cloned().unwrap_or_default(),
                sent: Vec::new(),
                notes: Vec::new(),
            });
        } else if v.get("jsonrpc").is_some()
            || v.get("method").is_some()
            || v.get("id").is_some()
            || v.get("type").is_some()
            || v.get("result").is_some()
        {
            out.last_mut().unwrap().sent.push(v);
        } else {
            out.last_mut().unwrap().notes.push(v);
        }
    }
    out
}

/// The thread `id` as `store` holds it now (its record and events), in a store of its own: as a
/// backend that stopped without closing left it, for another to load (the first's processes, still
/// running, can't change it).
pub async fn crashed(store: &dyn agent_threads::Store, id: &str) -> agent_threads::MemoryStore {
    use agent_threads::Store;
    let copy = agent_threads::MemoryStore::new();
    copy.create_thread(&store.get_thread(id).await.unwrap().unwrap())
        .await
        .unwrap();
    let events = store.read_events(id, 0, None).await.unwrap();
    copy.append_events(id, &events, &[]).await.unwrap();
    copy
}
