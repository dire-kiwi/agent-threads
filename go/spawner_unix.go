//go:build unix

package agentthreads

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/unix"
)

func setGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killGroup(pid int, sig syscall.Signal) error {
	return syscall.Kill(-pid, sig)
}

func signalName(sig syscall.Signal) string {
	if name := unix.SignalName(sig); name != "" {
		return name
	}
	return sig.String()
}
