// Package storetest runs the store conformance cases (spec/conformance/store.json) against a Store,
// as spec/conformance/store.md says to run them: for the built-in stores' tests, and for an app's
// own Store.
package storetest

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"testing"

	agentthreads "github.com/dire-kiwi/agent-threads/go"
	"github.com/dire-kiwi/agent-threads/go/protocol"
)

// Opener makes a new, empty store for a case; reopen closes it and opens it again on the same data.
// A store that doesn't persist (persistent false) skips the cases that need it.
type Opener func(t *testing.T) (store agentthreads.Store, reopen func() agentthreads.Store, persistent bool)

type step struct {
	Op     string            `json:"op"`
	Args   []json.RawMessage `json:"args"`
	Result json.RawMessage   `json:"result"`
	Error  string            `json:"error"`
}

type suite struct {
	Values map[string]json.RawMessage `json:"values"`
	Cases  []struct {
		Name       string `json:"name"`
		Persistent bool   `json:"persistent"`
		Steps      []step `json:"steps"`
	} `json:"cases"`
}

// Run runs every case in the store.json at path, each on a store from open.
func Run(t *testing.T, path string, open Opener) {
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var s suite
	if err := json.Unmarshal(data, &s); err != nil {
		t.Fatal(err)
	}
	for _, c := range s.Cases {
		t.Run(c.Name, func(t *testing.T) {
			store, reopen, persistent := open(t)
			if c.Persistent && !persistent {
				t.Skip("the store doesn't persist")
			}
			defer func() { store.Close() }()
			for i, st := range c.Steps {
				where := fmt.Sprintf("step %d (%s)", i+1, st.Op)
				if st.Op == "reopen" {
					store = reopen()
					continue
				}
				var args []json.RawMessage
				for _, a := range st.Args {
					args = append(args, resolve(t, s.Values, a))
				}
				got, err := call(store, st.Op, args)
				if st.Error != "" {
					var se *agentthreads.StoreError
					if !errors.As(err, &se) || string(se.Kind) != st.Error {
						t.Fatalf("%s: want a %s error, got %v", where, st.Error, err)
					}
					continue
				}
				if err != nil {
					t.Fatalf("%s: %v", where, err)
				}
				want := resolve(t, s.Values, st.Result)
				if len(st.Result) == 0 {
					want = json.RawMessage("null")
				}
				if !sameJSON(got, want) {
					t.Fatalf("%s:\n got %s\nwant %s", where, got, want)
				}
			}
		})
	}
}

// resolve replaces each {"$": "NAME"} in v with the value NAME.
func resolve(t *testing.T, values map[string]json.RawMessage, v json.RawMessage) json.RawMessage {
	if len(v) == 0 {
		return v
	}
	var x any
	if err := json.Unmarshal(v, &x); err != nil {
		t.Fatal(err)
	}
	var walk func(any) any
	walk = func(x any) any {
		switch y := x.(type) {
		case []any:
			for i := range y {
				y[i] = walk(y[i])
			}
		case map[string]any:
			if name, ok := y["$"].(string); ok && len(y) == 1 {
				var val any
				d := json.NewDecoder(bytes.NewReader(values[name]))
				d.UseNumber()
				if err := d.Decode(&val); err != nil {
					t.Fatalf("no value %s", name)
				}
				return val
			}
			for k := range y {
				y[k] = walk(y[k])
			}
		}
		return x
	}
	d := json.NewDecoder(bytes.NewReader(v))
	d.UseNumber()
	d.Decode(&x)
	out, err := json.Marshal(walk(x))
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func decode[T any](raw json.RawMessage) (T, error) {
	var v T
	err := json.Unmarshal(raw, &v)
	return v, err
}

func arg[T any](args []json.RawMessage, i int) T {
	var v T
	if i < len(args) {
		json.Unmarshal(args[i], &v)
	}
	return v
}

func call(s agentthreads.Store, op string, args []json.RawMessage) (json.RawMessage, error) {
	ctx := context.Background()
	var out any
	var err error
	switch op {
	case "createThread":
		var th protocol.Thread
		if th, err = decode[protocol.Thread](args[0]); err == nil {
			err = s.CreateThread(ctx, th)
		}
	case "getThread":
		out, err = s.GetThread(ctx, arg[string](args, 0))
	case "listThreads":
		out, err = s.ListThreads(ctx)
	case "updateThread":
		var th protocol.Thread
		if th, err = decode[protocol.Thread](args[0]); err == nil {
			err = s.UpdateThread(ctx, th)
		}
	case "deleteThread":
		out, err = s.DeleteThread(ctx, arg[string](args, 0))
	case "appendEvents":
		var events []protocol.ThreadEvent
		var runs []agentthreads.RunRecord
		if events, err = decode[[]protocol.ThreadEvent](args[1]); err == nil {
			if len(args) > 2 {
				runs, err = decode[[]agentthreads.RunRecord](args[2])
			}
			if err == nil {
				err = s.AppendEvents(ctx, arg[string](args, 0), events, runs)
			}
		}
	case "readEvents":
		var o struct {
			After int64 `json:"after"`
			Limit int   `json:"limit"`
		}
		if len(args) > 1 {
			json.Unmarshal(args[1], &o)
		}
		out, err = s.ReadEvents(ctx, arg[string](args, 0), o.After, o.Limit)
	case "lastSeq":
		out, err = s.LastSeq(ctx, arg[string](args, 0))
	case "saveSnapshot":
		var snap protocol.Snapshot
		if snap, err = decode[protocol.Snapshot](args[1]); err == nil {
			err = s.SaveSnapshot(ctx, arg[string](args, 0), snap)
		}
	case "loadSnapshot":
		out, err = s.LoadSnapshot(ctx, arg[string](args, 0))
	case "putRun":
		var r agentthreads.RunRecord
		if r, err = decode[agentthreads.RunRecord](args[0]); err == nil {
			err = s.PutRun(ctx, r)
		}
	case "getRun":
		out, err = s.GetRun(ctx, arg[string](args, 0))
	case "activeRuns":
		out, err = s.ActiveRuns(ctx)
	default:
		return nil, fmt.Errorf("unknown op %s", op)
	}
	if err != nil {
		return nil, err
	}
	if v := reflect.ValueOf(out); out != nil && (v.Kind() == reflect.Slice && v.IsNil()) {
		return json.RawMessage("[]"), nil
	}
	data, err := json.Marshal(out)
	return data, err
}

func sameJSON(a, b json.RawMessage) bool {
	var x, y any
	da := json.NewDecoder(bytes.NewReader(a))
	da.UseNumber()
	db := json.NewDecoder(bytes.NewReader(b))
	db.UseNumber()
	if da.Decode(&x) != nil || db.Decode(&y) != nil {
		return false
	}
	return reflect.DeepEqual(x, y)
}
