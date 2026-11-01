//go:build windows

package agentthreads

import (
	"errors"
	"os/exec"
	"syscall"
)

func setGroup(*exec.Cmd) {}

func killGroup(int, syscall.Signal) error { return errors.New("no process groups") }

func signalName(sig syscall.Signal) string { return sig.String() }
