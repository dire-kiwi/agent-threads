package main

// The app's permission policy: allow what only reads, and ask the user about everything else (the
// frontend shows a permission card). It's plain code, run for each tool call the agent wants to make.

import (
	"context"
	"regexp"
	"strings"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
	"github.com/dire-kiwi/agent-threads/go/protocol"
)

// readOnlyTools are tools that only read: the app's own lookup, and Claude loading a skill.
var readOnlyTools = map[string]bool{"lookup_order": true, "Skill": true}

// readers are programs that only read what they're given (Codex reads files, its skills included,
// with these).
var readers = map[string]bool{"cat": true, "head": true, "tail": true, "ls": true, "wc": true, "grep": true, "pwd": true, "nl": true, "stat": true}

var (
	shellSyntax = regexp.MustCompile("[;&|<>`$(){}\n\\\\\"]")
	sedLines    = regexp.MustCompile(`^\d+(,\d+)?p$`)
)

// readsOnly says whether a shell command only reads: one of readers, or `sed -n '<lines>p' <files>`,
// with no shell syntax (pipes, redirections, substitutions, several commands) that could make it do
// anything else.
func readsOnly(command string) bool {
	if shellSyntax.MatchString(command) {
		return false
	}
	words, ok := shellWords(strings.TrimSpace(command))
	if !ok || len(words) == 0 {
		return false
	}
	program, args := words[0], words[1:]
	// GNU sed takes options anywhere (`sed -n 1p -i file` edits in place, `-e 'w file'` writes), so
	// after the script there must be only files, none that looks like an option.
	if program == "sed" {
		if len(args) < 3 || args[0] != "-n" || !sedLines.MatchString(args[1]) {
			return false
		}
		for _, a := range args[2:] {
			if strings.HasPrefix(a, "-") {
				return false
			}
		}
		return true
	}
	return readers[program]
}

// shellWords is a command's words, each either quoted whole in single quotes (nothing in them is
// expanded) or not quoted at all; false if one has a quote partway through it (which the shell joins
// up with what's next to it) or a glob (which it expands: with a file called -i there,
// `sed -n 1p *` is `sed -n 1p -i notes.txt`).
func shellWords(command string) ([]string, bool) {
	var words []string
	space := func(c byte) bool { return c == ' ' || c == '\t' || c == '\r' || c == '\f' || c == '\v' }
	for i := 0; i < len(command); {
		if space(command[i]) {
			i++
			continue
		}
		if command[i] == '\'' {
			// A quoted word: the quotes, and whitespace or the end right after.
			if end := strings.IndexByte(command[i+1:], '\''); end >= 0 {
				after := i + 1 + end + 1
				if after == len(command) || space(command[after]) {
					words = append(words, command[i+1:i+1+end])
					i = after
					continue
				}
			}
		}
		// A bare word, to the next whitespace.
		j := i
		for j < len(command) && !space(command[j]) {
			j++
		}
		word := command[i:j]
		if strings.ContainsAny(word, "'*?[]") {
			return nil, false
		}
		words = append(words, word)
		i = j
	}
	return words, true
}

var permissions = agentthreads.PolicyFunc(func(_ context.Context, q agentthreads.PermissionQuery, _ agentthreads.PermissionContext) agentthreads.Decision {
	if q.Kind == protocol.ToolKindRead || q.Kind == protocol.ToolKindSearch || readOnlyTools[q.Name] {
		return agentthreads.Allow
	}
	if q.Kind == protocol.ToolKindShell && q.Command != "" && readsOnly(q.Command) {
		return agentthreads.Allow
	}
	return agentthreads.Ask
})
