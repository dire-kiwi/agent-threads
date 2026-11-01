package agentthreads

// CodexOptions configure the Codex harness.
type CodexOptions struct {
	Bin  string
	Env  map[string]string
	Home string
	NoLogin bool
}

// Codex is the Codex harness.
func Codex(o CodexOptions) Harness { return claudeHarness{} }
