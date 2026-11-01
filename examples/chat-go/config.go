package main

// What the server runs with, from its environment (see the README):
//
//	PORT                 the port, 3001 by default (on 127.0.0.1)
//	CHAT_DATA            where threads, runs and the agents' workspace go; ./data by default
//	CHAT_WEB             the built frontend to serve; ../chat-node/web/dist by default
//	CHAT_HARNESSES       the harnesses to offer, claude,codex by default
//	CHAT_CLAUDE_MODEL    the default model for new threads on Claude Code (haiku)
//	CHAT_CODEX_MODEL     and on Codex (gpt-5.6-luna, with effort CHAT_CODEX_EFFORT, low)
//	CHAT_SHIM            run the harnesses under agent-threads-shim, so they outlive the server:
//	                     1 for the one `make shim` builds, or the binary's path
//	CHAT_FAKE_CLAUDE     replay a recorded session (a spec/fixtures directory) with the fake CLI
//	CHAT_FAKE_CODEX      in place of the real one: for the tests, with no login needed
//	CHAT_FAKE_STATE      where the fake CLIs keep their state, kept across restarts (a fresh one by default)

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// root is examples/chat-go, and repo the repository.
var root, repo = func() (string, string) {
	_, file, _, ok := runtime.Caller(0)
	dir := filepath.Dir(file)
	if !ok || !exists(filepath.Join(dir, "go.mod")) {
		dir, _ = os.Getwd()
	}
	return dir, filepath.Clean(filepath.Join(dir, "..", ".."))
}()

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// devPort is Vite's dev server's port (chat-node's vite.config.ts), whose pages may use the server too.
const devPort = 5173

// restartCode is the exit code that asks the supervisor to start the server again.
const restartCode = 75

type harnessInfo struct {
	Name   string   `json:"name"`
	Label  string   `json:"label"`
	Model  string   `json:"model"`
	Models []string `json:"models"`
	// Effort is the default effort, if the harness takes one.
	Effort string `json:"-"`
	// Fake is the fixture to replay instead of running the real CLI.
	Fake string `json:"-"`
}

type config struct {
	port      int
	data, web string
	harnesses []harnessInfo
	// shim is the agent-threads-shim binary, when runs should outlive the server.
	shim string
	// fake says it's replaying fixtures: no MCP server or skill, as they were recorded without
	// them, and the app's tool only if they were recorded with it (fakeTools).
	fake, fakeTools bool
	fakeState       string
	// supervised says the supervisor started it, and starts it again when it exits for a restart.
	supervised bool
}

func loadConfig(env func(string) string) (config, error) {
	or := func(k, def string) string {
		if v := env(k); v != "" {
			return v
		}
		return def
	}
	fakes := map[string]string{"claude": env("CHAT_FAKE_CLAUDE"), "codex": env("CHAT_FAKE_CODEX")}
	fake := fakes["claude"] != "" || fakes["codex"] != ""
	var wanted []string
	if fake {
		for _, h := range []string{"claude", "codex"} {
			if fakes[h] != "" {
				wanted = append(wanted, h)
			}
		}
	} else {
		for _, h := range strings.Split(or("CHAT_HARNESSES", "claude,codex"), ",") {
			if h = strings.TrimSpace(h); h != "" {
				wanted = append(wanted, h)
			}
		}
	}
	all := map[string]harnessInfo{
		"claude": {Name: "claude", Label: "Claude Code", Model: or("CHAT_CLAUDE_MODEL", "haiku"), Models: []string{"haiku", "sonnet", "opus"}},
		"codex":  {Name: "codex", Label: "Codex", Model: or("CHAT_CODEX_MODEL", "gpt-5.6-luna"), Models: []string{"gpt-5.6-luna", "gpt-5.6"}, Effort: or("CHAT_CODEX_EFFORT", "low")},
	}
	c := config{fake: fake, fakeTools: true, supervised: env("CHAT_SUPERVISED") == "1"}
	for _, name := range wanted {
		h, ok := all[name]
		if !ok {
			return c, fmt.Errorf("CHAT_HARNESSES: there's no harness %s (there's claude and codex)", name)
		}
		if dir := fakes[name]; dir != "" {
			// The model and effort the session was recorded with, which the fake CLI checks.
			dir, _ = filepath.Abs(dir)
			var fx struct {
				Thread struct{ Model, Effort string } `json:"thread"`
				Tools  []struct{ Name string }        `json:"tools"`
			}
			data, err := os.ReadFile(filepath.Join(dir, "fixture.json"))
			if err != nil {
				return c, err
			}
			json.Unmarshal(data, &fx)
			hasTool := false
			for _, t := range fx.Tools {
				hasTool = hasTool || t.Name == "lookup_order"
			}
			c.fakeTools = c.fakeTools && hasTool
			h.Model, h.Models, h.Effort, h.Fake = fx.Thread.Model, []string{fx.Thread.Model}, fx.Thread.Effort, dir
		}
		c.harnesses = append(c.harnesses, h)
	}
	if s := env("CHAT_SHIM"); s != "" && s != "0" {
		c.shim = s
		if s == "1" {
			c.shim = filepath.Join(repo, "shim", "target", "debug", "agent-threads-shim")
		}
		c.shim, _ = filepath.Abs(c.shim)
		if !exists(c.shim) {
			return c, fmt.Errorf("CHAT_SHIM: there's no %s (run make shim in the repository first)", c.shim)
		}
	}
	port, err := strconv.Atoi(or("PORT", "3001"))
	if err != nil {
		return c, fmt.Errorf("PORT: %w", err)
	}
	c.port = port
	c.data, _ = filepath.Abs(or("CHAT_DATA", filepath.Join(root, "data")))
	c.web, _ = filepath.Abs(or("CHAT_WEB", filepath.Join(root, "..", "chat-node", "web", "dist")))
	if s := env("CHAT_FAKE_STATE"); s != "" {
		c.fakeState, _ = filepath.Abs(s)
	}
	return c, nil
}
