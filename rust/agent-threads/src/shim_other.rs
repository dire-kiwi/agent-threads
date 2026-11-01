//! The shim spawner where agent-threads-shim doesn't run (it's Unix-only): harness processes run as
//! child processes ([`direct`]), so runs don't outlive the backend.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::spawner::{Spawner, direct};

/// The run-directory format the Unix backend writes and reads (spec/RUNDIR.md).
pub const RUN_FORMAT: u64 = 1;

/// How the shim spawner runs (where it does).
#[derive(Clone, Debug)]
pub struct ShimOptions {
    pub runs_dir: PathBuf,
    pub keep: Duration,
    pub kill_grace: Duration,
    pub poll: Duration,
}

impl ShimOptions {
    pub fn new(runs_dir: impl Into<PathBuf>) -> Self {
        ShimOptions {
            runs_dir: runs_dir.into(),
            keep: Duration::from_secs(14 * 86_400),
            kill_grace: Duration::from_secs(10),
            poll: Duration::from_millis(50),
        }
    }
}

/// Nothing to kill: runs don't outlive the backend here.
#[doc(hidden)]
pub fn kill_runs(_runs_dir: &std::path::Path) {}

/// [`direct`]: the shim doesn't run here.
pub fn shim(_path: impl Into<PathBuf>, _options: ShimOptions) -> Arc<dyn Spawner> {
    direct()
}
