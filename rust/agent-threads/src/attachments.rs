//! A message's attachments in the shapes harnesses take: images with data as images, files with
//! textual data as their text, and other files with data written out to a path the agent is told.

use std::path::Path;

use base64::Engine;

use crate::harness::Message;

pub(crate) enum Part {
    Text(String),
    Image {
        media_type: String,
        data: String,
    },
    /// An attachment that's a file on disk: one given by path, or one with data, written out.
    Path {
        image: bool,
        path: String,
        name: String,
        media_type: Option<String>,
        written: bool,
    },
}

/// Whether a media type's content goes to the agent as text.
fn textual(media_type: &str) -> bool {
    let word_end = |rest: &str| !rest.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_');
    if media_type.starts_with("text/") {
        return true;
    }
    if let Some(sub) = media_type.strip_prefix("application/") {
        for t in [
            "json",
            "xml",
            "yaml",
            "x-yaml",
            "toml",
            "javascript",
            "x-sh",
            "x-ndjson",
            "csv",
        ] {
            if let Some(rest) = sub.strip_prefix(t)
                && word_end(rest)
            {
                return true;
            }
        }
    }
    ["+json", "+xml"].iter().any(|s| {
        media_type
            .match_indices(s)
            .any(|(at, _)| word_end(&media_type[at + s.len()..]))
    })
}

/// A message as parts: its text, then each attachment. Files with data that isn't textual are
/// written to `dir()/attachments/<message id>/` (dir() is the thread's private directory), readable
/// by the user only. One that can't be written is a note to the agent instead, and what went wrong
/// is added to `errors`, for the app.
pub(crate) fn message_parts(
    m: &Message,
    dir: &mut dyn FnMut() -> std::io::Result<std::path::PathBuf>,
    errors: &mut Vec<String>,
) -> Vec<Part> {
    let mut parts = vec![Part::Text(m.text.clone())];
    for (i, a) in m.attachments.iter().enumerate() {
        let name = a
            .name
            .clone()
            .or_else(|| a.path.clone())
            .unwrap_or_else(|| format!("attachment-{}", i + 1));
        let image = a.kind == crate::protocol::AttachmentKind::Image;
        if let Some(data) = &a.data {
            if image {
                parts.push(Part::Image {
                    media_type: a.media_type.clone().unwrap_or_else(|| "image/png".into()),
                    data: data.clone(),
                });
                continue;
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data.trim())
                .unwrap_or_default();
            if a.media_type.as_deref().is_some_and(textual) {
                parts.push(Part::Text(format!(
                    "Attached file {name}:\n{}",
                    String::from_utf8_lossy(&bytes)
                )));
                continue;
            }
            let base = Path::new(&name)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            // Runs of other characters become one _.
            let mut clean = String::new();
            let mut run = false;
            for c in base.chars() {
                if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' {
                    clean.push(c);
                    run = false;
                } else if !run {
                    clean.push('_');
                    run = true;
                }
            }
            let file = format!("{}-{clean}", i + 1);
            let path = match dir().and_then(|d| write_private(&d.join("attachments").join(&m.id), &file, &bytes)) {
                Ok(p) => p,
                Err(e) => {
                    errors.push(format!(
                        "the attached file {name} couldn't be written for the agent: {e}"
                    ));
                    parts.push(Part::Text(format!(
                        "Attached file {name}: it couldn't be passed on ({e})."
                    )));
                    continue;
                }
            };
            parts.push(Part::Path {
                image: false,
                path: path.to_string_lossy().into(),
                name,
                media_type: a.media_type.clone(),
                written: true,
            });
        } else if let Some(path) = &a.path {
            parts.push(Part::Path {
                image,
                path: path.clone(),
                name,
                media_type: a.media_type.clone(),
                written: false,
            });
        }
    }
    parts
}

/// Writes `bytes` to `dir/name` (making `dir`), readable by the user only.
fn write_private(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<std::path::PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(name);
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    std::io::Write::write_all(&mut o.open(&path)?, bytes)?;
    Ok(path)
}

/// What the agent is told about an attachment that's a file on disk.
pub(crate) fn path_text(path: &str, name: &str, media_type: Option<&str>, written: bool) -> String {
    if written {
        match media_type {
            Some(t) => format!("Attached file {name} ({t}): {path}"),
            None => format!("Attached file {name}: {path}"),
        }
    } else {
        format!("Attached file: {path}")
    }
}
