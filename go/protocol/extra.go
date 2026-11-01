package protocol

import (
	"bytes"
	"encoding/json"
	"sort"
)

// What the generated types' MarshalJSON and UnmarshalJSON use to keep the fields the spec doesn't
// name (Extra).

func fieldSet(names ...string) map[string]bool {
	set := make(map[string]bool, len(names))
	for _, n := range names {
		set[n] = true
	}
	return set
}

func isNull(data []byte) bool {
	return string(bytes.TrimSpace(data)) == "null"
}

// extraFields is an object's fields that aren't in known, or nil if there are none.
func extraFields(data []byte, known map[string]bool) (map[string]json.RawMessage, error) {
	var all map[string]json.RawMessage
	if err := json.Unmarshal(data, &all); err != nil {
		return nil, err
	}
	var extra map[string]json.RawMessage
	for k, v := range all {
		if known[k] {
			continue
		}
		if extra == nil {
			extra = map[string]json.RawMessage{}
		}
		extra[k] = v
	}
	return extra, nil
}

// withExtra adds extra's fields (but not ones the spec names) to the JSON object data.
func withExtra(data []byte, extra map[string]json.RawMessage, known map[string]bool) ([]byte, error) {
	keys := make([]string, 0, len(extra))
	for k := range extra {
		if !known[k] {
			keys = append(keys, k)
		}
	}
	if len(keys) == 0 {
		return data, nil
	}
	sort.Strings(keys)
	end := bytes.LastIndexByte(data, '}')
	out := append([]byte(nil), data[:end]...)
	empty := bytes.Equal(bytes.TrimSpace(out), []byte("{"))
	for _, k := range keys {
		v := extra[k]
		if len(v) == 0 {
			v = json.RawMessage("null")
		}
		name, err := json.Marshal(k)
		if err != nil {
			return nil, err
		}
		if !empty {
			out = append(out, ',')
		}
		empty = false
		out = append(out, name...)
		out = append(out, ':')
		out = append(out, v...)
	}
	return append(out, '}'), nil
}
