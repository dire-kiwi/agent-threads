package protocol

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"
	"sync"
)

// Checks values against the protocol's schemas (protocol.schema.json, copied from spec/ by
// internal/gen), e.g. a command from a client before a backend acts on it: the same as validate in
// @dire-kiwi/agent-threads-protocol. It handles the JSON Schema the spec uses ($ref, oneOf, type,
// const, enum, required, properties, additionalProperties, items, minItems, minimum, the date-time
// format and base64 content) and no more. Fields a schema doesn't name are allowed, as the protocol
// says receivers ignore them.

//go:embed protocol.schema.json
var schemaJSON []byte

type schema struct {
	Ref                  string             `json:"$ref"`
	OneOf                []*schema          `json:"oneOf"`
	Const                json.RawMessage    `json:"const"`
	Enum                 []json.RawMessage  `json:"enum"`
	Type                 json.RawMessage    `json:"type"`
	Required             []string           `json:"required"`
	Properties           map[string]*schema `json:"properties"`
	AdditionalProperties json.RawMessage    `json:"additionalProperties"`
	Items                *schema            `json:"items"`
	MinItems             *int               `json:"minItems"`
	Minimum              *float64           `json:"minimum"`
	Format               string             `json:"format"`
	ContentEncoding      string             `json:"contentEncoding"`
}

var (
	defsOnce sync.Once
	defs     map[string]*schema
)

func loadDefs() map[string]*schema {
	defsOnce.Do(func() {
		var root struct {
			Defs map[string]*schema `json:"$defs"`
		}
		if err := json.Unmarshal(schemaJSON, &root); err != nil {
			panic(fmt.Sprintf("protocol: the embedded schema doesn't parse: %v", err))
		}
		defs = root.Defs
	})
	return defs
}

func deref(s *schema) *schema {
	for s != nil && s.Ref != "" {
		s = loadDefs()[strings.TrimPrefix(s.Ref, "#/$defs/")]
	}
	return s
}

var (
	dateTime = regexp.MustCompile(`(?i)^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$`)
	base64Re = regexp.MustCompile(`^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$`)
)

// Validate says what's wrong with data (JSON) as the protocol's definition name (e.g. "Command",
// "ThreadEvent", "Snapshot"), as "path: problem" strings; none when it's valid.
func Validate(data []byte, name string) []string {
	s := loadDefs()[name]
	if s == nil {
		return []string{fmt.Sprintf("the protocol has no definition %s", name)}
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return []string{fmt.Sprintf("(the value): isn't JSON: %v", err)}
	}
	return check(v, s, "")
}

// ValidateValue is Validate for a Go value, as it marshals to JSON.
func ValidateValue(v any, name string) []string {
	data, err := json.Marshal(v)
	if err != nil {
		return []string{fmt.Sprintf("(the value): can't be written as JSON: %v", err)}
	}
	return Validate(data, name)
}

func typeOf(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	case string:
		return "string"
	case bool:
		return "boolean"
	case json.Number:
		if f, err := x.Float64(); err == nil && f == math.Trunc(f) && !math.IsInf(f, 0) {
			return "integer"
		}
		return "number"
	}
	return "unknown"
}

func show(v any) string {
	data, _ := json.Marshal(v)
	return string(data)
}

func decodeRaw(raw json.RawMessage) any {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	_ = dec.Decode(&v)
	return v
}

func sameValue(a any, b json.RawMessage) bool {
	return sameJSON(json.RawMessage(show(a)), json.RawMessage(show(decodeRaw(b))))
}

func check(v any, sch *schema, path string) []string {
	s := deref(sch)
	if s == nil {
		return nil
	}
	at := path
	if at == "" {
		at = "(the value)"
	}
	if len(s.OneOf) > 0 {
		// A union told apart by `type`: check the branch it names; otherwise exactly one must fit.
		var branches []*schema
		for _, b := range s.OneOf {
			if d := deref(b); d != nil {
				branches = append(branches, d)
			}
		}
		var typ any
		if o, ok := v.(map[string]any); ok {
			typ = o["type"]
		}
		tagged := true
		var tags []string
		for _, b := range branches {
			t := b.Properties["type"]
			if t == nil || t.Const == nil {
				tagged = false
				continue
			}
			tags = append(tags, string(t.Const))
			if typ != nil && sameValue(typ, t.Const) {
				return check(v, b, path)
			}
		}
		if tagged {
			return []string{fmt.Sprintf("%s: type should be one of %s, not %s", at, strings.Join(tags, ", "), show(typ))}
		}
		fits := 0
		for _, b := range branches {
			if len(check(v, b, path)) == 0 {
				fits++
			}
		}
		if fits == 1 {
			return nil
		}
		return []string{fmt.Sprintf("%s: matches %d of the %d possibilities, not exactly one", at, fits, len(branches))}
	}
	if s.Const != nil && !sameValue(v, s.Const) {
		return []string{fmt.Sprintf("%s: should be %s", at, string(s.Const))}
	}
	if s.Enum != nil && !slices.ContainsFunc(s.Enum, func(e json.RawMessage) bool { return sameValue(v, e) }) {
		var all []string
		for _, e := range s.Enum {
			all = append(all, string(e))
		}
		return []string{fmt.Sprintf("%s: should be one of %s, not %s", at, strings.Join(all, ", "), show(v))}
	}
	if s.Type != nil {
		var types []string
		if err := json.Unmarshal(s.Type, &types); err != nil {
			var one string
			_ = json.Unmarshal(s.Type, &one)
			types = []string{one}
		}
		t := typeOf(v)
		if !slices.Contains(types, t) && !(t == "integer" && slices.Contains(types, "number")) {
			return []string{fmt.Sprintf("%s: should be %s, not %s", at, strings.Join(types, " or "), t)}
		}
	}
	var errs []string
	switch x := v.(type) {
	case json.Number:
		if f, err := x.Float64(); err == nil && s.Minimum != nil && f < *s.Minimum {
			errs = append(errs, fmt.Sprintf("%s: should be at least %v", at, *s.Minimum))
		}
	case string:
		if s.Format == "date-time" && !dateTime.MatchString(x) {
			errs = append(errs, fmt.Sprintf("%s: should be a date-time", at))
		}
		if s.ContentEncoding == "base64" && !base64Re.MatchString(x) {
			errs = append(errs, fmt.Sprintf("%s: should be base64", at))
		}
	case []any:
		if s.MinItems != nil && len(x) < *s.MinItems {
			errs = append(errs, fmt.Sprintf("%s: should have at least %d entries", at, *s.MinItems))
		}
		if s.Items != nil {
			for i, e := range x {
				errs = append(errs, check(e, s.Items, fmt.Sprintf("%s[%d]", path, i))...)
			}
		}
	case map[string]any:
		for _, k := range s.Required {
			if _, ok := x[k]; !ok {
				errs = append(errs, fmt.Sprintf("%s: is missing %s", at, k))
			}
		}
		var extra *schema
		closed := false
		if len(s.AdditionalProperties) > 0 {
			if string(s.AdditionalProperties) == "false" {
				closed = true
			} else if s.AdditionalProperties[0] == '{' {
				extra = new(schema)
				_ = json.Unmarshal(s.AdditionalProperties, extra)
			}
		}
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		for _, k := range keys {
			p := s.Properties[k]
			if p == nil {
				p = extra
			}
			if p != nil {
				errs = append(errs, check(x[k], p, path+"."+k)...)
			} else if closed {
				errs = append(errs, fmt.Sprintf("%s: shouldn't have %s", at, k))
			}
		}
	}
	return errs
}
