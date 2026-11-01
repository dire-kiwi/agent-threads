//! agent-threads: run threads of agents on Claude Code and Codex.
//!
//! [`protocol`] has the types of the shared spec (`spec/` in the repository): items, requests,
//! events, commands and snapshots.

pub mod protocol;
pub mod reducer;
pub mod store;
pub mod stores;

mod ids;

pub use store::{RunRecord, Store, StoreError, StoreErrorKind, StoreResult};
pub use stores::file::FileStore;
pub use stores::memory::{MemoryState, MemoryStore};
pub use stores::sqlite::SqliteStore;
