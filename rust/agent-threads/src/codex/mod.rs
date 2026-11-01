//! The Codex driver (placeholder while it's written).
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use crate::harness::Harness;
#[derive(Clone, Debug, Default)]
pub struct CodexOptions { pub bin: String, pub bin_args: Vec<String>, pub args: Vec<String>, pub env: HashMap<String, Option<String>>, pub home: Option<PathBuf>, pub login: Option<PathBuf>, pub user_config: bool, pub stop_grace: Duration, pub close_grace: Duration }
pub fn codex(_o: CodexOptions) -> Arc<dyn Harness> { Arc::new(X) }
struct X;
impl Harness for X { fn name(&self) -> &str { "codex" } fn open(&self, _c: &crate::thread::ThreadContext) -> Box<dyn crate::harness::HarnessSession> { todo!() } }
