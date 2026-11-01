//go:build unix && !linux

package agentthreads

import (
	"time"

	"golang.org/x/sys/unix"
)

// bootTime is when the machine started.
func bootTime() (time.Time, bool) {
	tv, err := unix.SysctlTimeval("kern.boottime")
	if err != nil {
		return time.Time{}, false
	}
	return time.Unix(tv.Sec, int64(tv.Usec)*1000), true
}
