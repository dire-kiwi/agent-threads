package agentthreads

import (
	"encoding/json"
	"fmt"
)

// The client half of the JSON-RPC that `codex app-server` speaks over stdio: one JSON message per
// line, without the "jsonrpc" field. It runs on the thread's goroutine: a request's answer comes as
// a call of its resolve or reject.

// rpcError is an error response to one of our requests, or the process ending before it was answered.
type rpcError struct {
	method  string
	message string
	code    *int
	// data is the error response's error object, if it was one.
	data json.RawMessage
}

func (e *rpcError) Error() string { return e.message }

type rpcPending struct {
	method  string
	meta    json.RawMessage
	resolve func(jmap)
	reject  func(error)
	// resolveRaw, when it's set, is given the result as it came instead of resolve.
	resolveRaw func(json.RawMessage)
}

// rpcPendingState is a request of ours not yet answered, as a checkpoint keeps it.
type rpcPendingState struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Meta   json.RawMessage `json:"meta,omitempty"`
}

type rpcState struct {
	Next    int               `json:"next"`
	Pending []rpcPendingState `json:"pending"`
}

type rpcClient struct {
	write   func(msg any)
	next    int
	pending map[string]*rpcPending // by the id's JSON
	order   []string
	closed  error
}

func newRPC(write func(any)) *rpcClient {
	return &rpcClient{write: write, next: 1, pending: map[string]*rpcPending{}}
}

// request sends a request; meta is kept with it while it's pending, for a checkpoint.
func (c *rpcClient) request(method string, params any, meta any, resolve func(jmap), reject func(error)) {
	if resolve == nil {
		resolve = func(jmap) {}
	}
	if reject == nil {
		reject = func(error) {}
	}
	if c.closed != nil {
		reject(&rpcError{method: method, message: c.closed.Error()})
		return
	}
	id := c.next
	c.next++
	key := fmt.Sprint(id)
	p := &rpcPending{method: method, resolve: resolve, reject: reject}
	if meta != nil {
		p.meta = mustJSON(meta)
	}
	c.pending[key] = p
	c.order = append(c.order, key)
	msg := map[string]any{"id": id, "method": method}
	if params != nil {
		msg["params"] = params
	}
	c.write(msg)
}

// requestRaw sends a request of the app's own: its result goes to resolve as it came.
func (c *rpcClient) requestRaw(method string, params json.RawMessage, resolve func(json.RawMessage), reject func(error)) {
	var p any
	if params != nil {
		p = params
	}
	c.request(method, p, nil, nil, reject)
	// Its answer comes later, on this goroutine: there's time to say where it goes.
	if c.closed == nil {
		c.pending[fmt.Sprint(c.next-1)].resolveRaw = resolve
	}
}

func (c *rpcClient) notify(method string, params any) {
	if c.closed != nil {
		return
	}
	msg := map[string]any{"method": method}
	if params != nil {
		msg["params"] = params
	}
	c.write(msg)
}

// respond answers one of the server's requests.
func (c *rpcClient) respond(id json.RawMessage, result any) {
	if c.closed == nil {
		c.write(map[string]any{"id": id, "result": result})
	}
}

func (c *rpcClient) respondError(id json.RawMessage, message string, code int) {
	if c.closed == nil {
		c.write(map[string]any{"id": id, "error": map[string]any{"code": code, "message": message}})
	}
}

// take takes a response to one of our requests, and says whether it was one.
func (c *rpcClient) take(msg jmap) bool {
	if msg.has("method") || !msg.has("id") {
		return false
	}
	key := canonical(msg.raw("id"))
	p := c.pending[key]
	if p == nil {
		return true
	}
	delete(c.pending, key)
	c.order = without(c.order, key)
	if e := msg.obj("error"); e != nil {
		text := e.str("message")
		if text == "" {
			text = p.method + " failed"
		}
		var code *int
		if n, ok := e.int("code"); ok {
			x := int(n)
			code = &x
		}
		p.reject(&rpcError{method: p.method, message: text, code: code, data: msg.raw("error")})
		return true
	}
	if p.resolveRaw != nil {
		r := msg.raw("result")
		if r == nil {
			r = json.RawMessage("null")
		}
		p.resolveRaw(r)
		return true
	}
	if r := msg.obj("result"); r != nil {
		p.resolve(r)
	} else {
		p.resolve(jmap{})
	}
	return true
}

func (c *rpcClient) state() rpcState {
	st := rpcState{Next: c.next, Pending: []rpcPendingState{}}
	for _, key := range c.order {
		p := c.pending[key]
		st.Pending = append(st.Pending, rpcPendingState{ID: json.RawMessage(key), Method: p.method, Meta: p.meta})
	}
	return st
}

// restore carries on from state(), with what's to be done with the answers to the requests then
// pending.
func (c *rpcClient) restore(st rpcState, handle func(p rpcPendingState) (func(jmap), func(error))) {
	c.next = st.Next
	for _, p := range st.Pending {
		key := canonical(p.ID)
		resolve, reject := handle(p)
		c.pending[key] = &rpcPending{method: p.Method, meta: p.Meta, resolve: resolve, reject: reject}
		c.order = append(c.order, key)
	}
}

// close says the process ended: requests still waiting fail with err, and later ones straight away.
func (c *rpcClient) close(err error) {
	c.closed = err
	order := c.order
	pending := c.pending
	c.order, c.pending = nil, map[string]*rpcPending{}
	for _, key := range order {
		if p := pending[key]; p != nil {
			p.reject(&rpcError{method: p.method, message: err.Error()})
		}
	}
}
