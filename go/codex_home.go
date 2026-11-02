package agentthreads

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// The app's own CODEX_HOME: where Codex keeps the app's sessions (which thread/resume needs), with
// none of the user's config, MCP servers, skills or history, but with their login linked in.

// userCodexHome is the user's own CODEX_HOME.
func userCodexHome() string {
	if h := os.Getenv("CODEX_HOME"); h != "" {
		return h
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex")
}

// defaultCodexHome is the app's CODEX_HOME when it doesn't name one.
func defaultCodexHome() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".agent-threads", "codex")
}

// prepareCodexHome makes the app's CODEX_HOME, with the login (auth.json) from login linked in if it
// has none of its own (or copied, where links can't be made); none if login is "". A link keeps it
// the user's login: when Codex refreshes its tokens, the user's own Codex sees them.
func prepareCodexHome(home, login string) (string, error) {
	dir, err := filepath.Abs(home)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if login == "" {
		return dir, nil
	}
	from, err := filepath.Abs(filepath.Join(login, "auth.json"))
	if err != nil {
		return dir, nil
	}
	to := filepath.Join(dir, "auth.json")
	if from == to {
		return dir, nil
	}
	if _, err := os.Stat(from); err != nil {
		return dir, nil
	}
	// A link whose login has gone is made again; a login of the app's own is left alone.
	if fi, err := os.Lstat(to); err == nil {
		if _, err := os.Stat(to); err == nil || fi.Mode()&os.ModeSymlink == 0 {
			return dir, nil
		}
		os.Remove(to)
	}
	if err := os.Symlink(from, to); err != nil {
		data, err := os.ReadFile(from)
		if err != nil {
			return "", err
		}
		if err := os.WriteFile(to, data, 0o600); err != nil {
			return "", err
		}
	}
	return dir, nil
}

// toolSpec is a tool as Codex has it as a dynamic tool.
type toolSpec struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

func specOf(t Tool) toolSpec {
	return toolSpec{Name: t.Name(), Description: t.Description(), InputSchema: t.InputSchema()}
}

func sameSpec(a, b toolSpec) bool {
	return a.Name == b.Name && a.Description == b.Description && sameCanonical(a.InputSchema, b.InputSchema)
}

// codexSessionState is what the driver keeps about a Codex session, next to Codex's own record of
// it: the dynamic tools the session was started with, which Codex keeps for it (resuming can't
// change them).
type codexSessionState struct {
	DynamicTools []toolSpec `json:"dynamicTools"`
}

func sessionStatePath(home, session string) string {
	return filepath.Join(home, "agent-threads", "sessions", encodeURIComponent(session)+".json")
}

// readSessionState is the session's state, or nil if there's none (it was started elsewhere, or by
// an older driver).
func readSessionState(home, session string) *codexSessionState {
	data, err := os.ReadFile(sessionStatePath(home, session))
	if err != nil {
		return nil
	}
	var s codexSessionState
	if json.Unmarshal(data, &s) != nil || s.DynamicTools == nil {
		return nil
	}
	return &s
}

func writeSessionState(home, session string, s codexSessionState) error {
	path := sessionStatePath(home, session)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if s.DynamicTools == nil {
		s.DynamicTools = []toolSpec{}
	}
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	if err := os.WriteFile(path+".tmp", data, 0o600); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}
