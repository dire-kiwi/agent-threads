package protocol_test

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/dire-kiwi/agent-threads/go/protocol"
)

// Each example in spec/examples reads into the generated types and writes back as the same JSON.
func TestExamplesRoundTrip(t *testing.T) {
	for _, line := range lines(t, "../../spec/examples/thread.events.jsonl") {
		roundTrip[protocol.ThreadEvent](t, line)
	}
	for _, line := range lines(t, "../../spec/examples/commands.jsonl") {
		roundTrip[protocol.Command](t, line)
	}
	snapshot, err := os.ReadFile("../../spec/examples/thread.snapshot.json")
	if err != nil {
		t.Fatal(err)
	}
	roundTrip[protocol.Snapshot](t, snapshot)
	window, err := os.ReadFile("../../spec/examples/thread.window.json")
	if err != nil {
		t.Fatal(err)
	}
	roundTrip[protocol.Snapshot](t, window)
	page, err := os.ReadFile("../../spec/examples/thread.page.json")
	if err != nil {
		t.Fatal(err)
	}
	roundTrip[protocol.ItemPage](t, page)
}

func TestUnionVariants(t *testing.T) {
	var ev protocol.ThreadEvent
	data := `{"type":"item.added","thread_id":"th","seq":1,"item":{"id":"n","type":"notice","level":"info","text":"hi"}}`
	if err := json.Unmarshal([]byte(data), &ev); err != nil {
		t.Fatal(err)
	}
	added, ok := ev.Value.(*protocol.ItemAddedEvent)
	if !ok {
		t.Fatalf("got %T, want *ItemAddedEvent", ev.Value)
	}
	if notice, ok := added.Item.Value.(*protocol.Notice); !ok || notice.Level != protocol.NoticeLevelInfo {
		t.Fatalf("got %#v, want an info notice", added.Item.Value)
	}
	if err := json.Unmarshal([]byte(`{"type":"nope","thread_id":"th"}`), &ev); err == nil {
		t.Fatal("an unknown type should be an error")
	}
	if _, err := json.Marshal(protocol.Command{}); err == nil {
		t.Fatal("a union without a value should be an error")
	}
}

// An open object's values stay as they came: a large integer in a patch isn't rounded through a
// float64, and null (which removes a field) is still there.
func TestOpenObjectsKeepTheirValues(t *testing.T) {
	data := `{"type":"item.updated","thread_id":"th","seq":2,"item_id":"tc1","patch":{"size":9007199254740993,"title":null}}`
	var ev protocol.ThreadEvent
	if err := json.Unmarshal([]byte(data), &ev); err != nil {
		t.Fatal(err)
	}
	patch := ev.Value.(*protocol.ItemUpdatedEvent).Patch
	if string(patch["size"]) != "9007199254740993" || string(patch["title"]) != "null" {
		t.Fatalf("got %q and %q", patch["size"], patch["title"])
	}
	out, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(out, []byte(`"size":9007199254740993`)) {
		t.Fatalf("the integer changed: %s", out)
	}
}

func TestRequiredListsAreNotNull(t *testing.T) {
	out, err := json.Marshal(protocol.Snapshot{Thread: protocol.Thread{ID: "th", Harness: "claude", Status: protocol.ThreadStatusIdle}})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	json.Unmarshal(out, &got)
	if !reflect.DeepEqual(got["items"], []any{}) || !reflect.DeepEqual(got["requests"], []any{}) {
		t.Fatalf("items and requests should be [], got %s", out)
	}
}

func roundTrip[T any](t *testing.T, data []byte) {
	t.Helper()
	var v T
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatalf("%s: %v", data, err)
	}
	out, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("%s: %v", data, err)
	}
	var want, got any
	json.Unmarshal(data, &want)
	json.Unmarshal(out, &got)
	if !reflect.DeepEqual(want, got) {
		t.Errorf("round trip changed it:\n in: %s\nout: %s", data, out)
	}
}

func lines(t *testing.T, path string) [][]byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out [][]byte
	scan := bufio.NewScanner(bytes.NewReader(data))
	scan.Buffer(nil, 1<<20)
	for scan.Scan() {
		if line := bytes.TrimSpace(scan.Bytes()); len(line) > 0 {
			out = append(out, append([]byte(nil), line...))
		}
	}
	return out
}
