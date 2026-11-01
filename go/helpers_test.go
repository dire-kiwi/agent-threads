package agentthreads_test

import (
	"encoding/json"
	"testing"

	"github.com/dire-kiwi/agent-threads/go/protocol"
)

func thread(id string) protocol.Thread {
	return protocol.Thread{ID: id, Harness: "claude", Status: protocol.ThreadStatusIdle, CreatedAt: "2026-11-01T00:00:00Z"}
}

func events(t *testing.T, lines ...string) []protocol.ThreadEvent {
	t.Helper()
	var out []protocol.ThreadEvent
	for _, l := range lines {
		var e protocol.ThreadEvent
		if err := json.Unmarshal([]byte(l), &e); err != nil {
			t.Fatal(err)
		}
		out = append(out, e)
	}
	return out
}
