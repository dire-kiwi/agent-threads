//! placeholder
use std::path::PathBuf;
use std::sync::Arc;
use crate::spawner::Spawner;
pub struct ShimOptions { pub runs_dir: PathBuf }
impl ShimOptions { pub fn new(runs_dir: impl Into<PathBuf>) -> Self { ShimOptions { runs_dir: runs_dir.into() } } }
pub fn shim(_path: impl Into<PathBuf>, _o: ShimOptions) -> Arc<dyn Spawner> { todo!() }
