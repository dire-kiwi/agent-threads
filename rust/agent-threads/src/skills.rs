//! The app's skills, written out as a directory of `<name>/SKILL.md`s for a harness to load.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::harness::Skill;

/// Writes the skills into `root` (a skill given as a directory is copied, with what it refers to).
pub(crate) fn write_skills(root: &Path, skills: &[Skill]) -> io::Result<PathBuf> {
    fs::create_dir_all(root)?;
    for s in skills {
        match s {
            Skill::Dir(dir) => {
                let dir = std::path::absolute(dir)?;
                let name = dir
                    .file_name()
                    .ok_or_else(|| io::Error::other(format!("{} isn't a skill's directory", dir.display())))?;
                copy_dir(&dir, &root.join(name))?;
            }
            Skill::Inline { name, content } => {
                fs::create_dir_all(root.join(name))?;
                fs::write(root.join(name).join("SKILL.md"), content)?;
            }
        }
    }
    Ok(root.to_path_buf())
}

fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if fs::metadata(entry.path())?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}
