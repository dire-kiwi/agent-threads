//go:build linux

package agentthreads

import "time"

// bootTime is when the machine started.
func bootTime() (time.Time, bool) { return procBtime() }
