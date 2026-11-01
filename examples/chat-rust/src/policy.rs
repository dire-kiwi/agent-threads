//! The app's permission policy: allow what only reads, and ask the user about everything else (the
//! frontend shows a permission card). It's plain code, run for each tool call the agent wants to
//! make. The same as chat-node's server/policy.ts.

use agent_threads::protocol::ToolKind;
use agent_threads::{PermissionDecision, PermissionPolicy};

/// Tools that only read: the app's own lookup, and Claude loading a skill.
const READ_ONLY_TOOLS: &[&str] = &["lookup_order", "Skill"];

/// Programs that only read what they're given (Codex reads files, its skills included, with these).
const READERS: &[&str] = &["cat", "head", "tail", "ls", "wc", "grep", "pwd", "nl", "stat"];

/// Whether a shell command only reads: one of READERS, or `sed -n '<lines>p' <files>`, with no shell
/// syntax (pipes, redirections, substitutions, several commands) that could make it do anything
/// else, and no globs: the shell would expand those into names the check never sees.
pub fn reads_only(command: &str) -> bool {
    if command.contains([';', '&', '|', '<', '>', '`', '$', '(', ')', '{', '}', '\n', '\\', '"']) {
        return false;
    }
    // Words: each either quoted whole in single quotes (nothing in them is expanded) or not quoted
    // at all.
    let mut words: Vec<String> = Vec::new();
    let mut rest = command.trim();
    while !rest.is_empty() {
        if let Some(r) = rest.strip_prefix('\'')
            && let Some(end) = r.find('\'')
            && r[end + 1..].chars().next().is_none_or(char::is_whitespace)
        {
            words.push(r[..end].to_string());
            rest = r[end + 1..].trim_start();
            continue;
        }
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let bare = &rest[..end];
        if bare.contains(['\'', '*', '?', '[', ']']) {
            return false; // a quote partway through a word, or a glob
        }
        words.push(bare.to_string());
        rest = rest[end..].trim_start();
    }
    let Some((program, args)) = words.split_first() else {
        return false;
    };
    // GNU sed takes options anywhere (`sed -n 1p -i file` edits in place), so after the script there
    // must be only files, none that looks like an option.
    if program == "sed" {
        let lines = |s: &str| {
            let Some(s) = s.strip_suffix('p') else { return false };
            let mut parts = s.splitn(2, ',');
            parts.all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        };
        return args.first().is_some_and(|a| a == "-n")
            && args.get(1).is_some_and(|a| lines(a))
            && args.len() > 2
            && args[2..].iter().all(|a| !a.starts_with('-'));
    }
    READERS.contains(&program.as_str())
}

pub fn permissions() -> PermissionPolicy {
    PermissionPolicy::from_fn(|q, _| {
        if matches!(q.kind, ToolKind::Read | ToolKind::Search) || READ_ONLY_TOOLS.contains(&q.name.as_str()) {
            return PermissionDecision::Allow;
        }
        if q.kind == ToolKind::Shell && q.command.as_deref().is_some_and(reads_only) {
            return PermissionDecision::Allow;
        }
        PermissionDecision::Ask
    })
}

#[cfg(test)]
mod tests {
    use super::reads_only;

    #[test]
    fn allows_only_commands_that_read() {
        for ok in [
            "cat notes.txt",
            "wc -l notes.txt",
            "ls",
            "sed -n '1,20p' a.txt",
            "grep -n 'two words' a.txt",
            "head 'a b.txt'",
        ] {
            assert!(reads_only(ok), "{ok}");
        }
        for no in [
            "rm -rf /",
            "cat a; rm b",
            "cat $(whoami)",
            "cat a > b",
            "cat *",
            "sed -n 1p -i a.txt",
            "sed -i 's/a/b/' a.txt",
            "sed -n 1p",
            "cat it's",
            "sed -n 1p *",
            "'cat'chsegv",
            "cat a'b'",
            "sed -n '1p' -i a.txt",
            "echo hi",
            "",
        ] {
            assert!(!reads_only(no), "{no}");
        }
    }
}
