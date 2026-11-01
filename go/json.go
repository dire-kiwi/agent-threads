package agentthreads

import (
	"bytes"
	"encoding/json"
)

// jmap is a JSON object whose values are kept as they came, for reading a harness's messages
// without changing what's passed on (a tool's input, say, keeps its keys' order and its numbers).
type jmap map[string]json.RawMessage

// parseObj is data as a jmap, or nil if it isn't an object.
func parseObj(data []byte) jmap {
	var m jmap
	if err := json.Unmarshal(data, &m); err != nil {
		return nil
	}
	return m
}

func (m jmap) raw(k string) json.RawMessage {
	v := m[k]
	if len(v) == 0 || string(v) == "null" {
		return nil
	}
	return v
}

func (m jmap) has(k string) bool { return m.raw(k) != nil }

func (m jmap) str(k string) string {
	var s string
	if v := m.raw(k); v != nil && v[0] == '"' {
		json.Unmarshal(v, &s)
	}
	return s
}

func (m jmap) obj(k string) jmap {
	v := m.raw(k)
	if v == nil || v[0] != '{' {
		return nil
	}
	return parseObj(v)
}

func (m jmap) arr(k string) []json.RawMessage {
	v := m.raw(k)
	if v == nil || v[0] != '[' {
		return nil
	}
	var a []json.RawMessage
	json.Unmarshal(v, &a)
	return a
}

func (m jmap) num(k string) (float64, bool) {
	v := m.raw(k)
	if v == nil {
		return 0, false
	}
	var f float64
	if err := json.Unmarshal(v, &f); err != nil {
		return 0, false
	}
	return f, true
}

func (m jmap) int(k string) (int64, bool) {
	f, ok := m.num(k)
	return int64(f), ok
}

func (m jmap) bool(k string) bool {
	return string(m.raw(k)) == "true"
}

// isStr says whether a value is a JSON string.
func isStr(v json.RawMessage) bool { return len(v) > 0 && v[0] == '"' }

func rawStr(v json.RawMessage) string {
	var s string
	json.Unmarshal(v, &s)
	return s
}

func mustJSON(v any) json.RawMessage {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return data
}

// orEmpty is v, or {} if there's none.
func orEmpty(v json.RawMessage) json.RawMessage {
	if len(v) == 0 || string(v) == "null" {
		return json.RawMessage("{}")
	}
	return v
}

// canonical is a JSON value with its objects' keys sorted, for comparing values whatever their
// keys' order.
func canonical(v json.RawMessage) string {
	if len(v) == 0 {
		return "null"
	}
	dec := json.NewDecoder(bytes.NewReader(v))
	dec.UseNumber()
	var x any
	if err := dec.Decode(&x); err != nil {
		return string(v)
	}
	out, _ := json.Marshal(x)
	return string(out)
}

func sameCanonical(a, b json.RawMessage) bool { return canonical(a) == canonical(b) }
