package agentthreads

import "time"

// RunFormat is the run-directory format this backend writes and reads (spec/RUNDIR.md).
const RunFormat = 1

// ShimOptions configure the shim spawner.
type ShimOptions struct {
	// RunsDir is where run directories go. It must be this store's alone: pruning stops and removes
	// the runs in it that the store doesn't follow, so two stores sharing one would stop each other's
	// runs.
	RunsDir string
	// KeepDays is how long a finished run's directory is kept, for debugging. 14 days by default.
	KeepDays int
	// KillGrace is how long a run that's stopped has to exit after SIGTERM before it's sent SIGKILL,
	// for the runs the spawner stops itself: one nothing follows any more (found by Prune, or given up
	// on with StopRun), one in a newer format, one whose shim has gone, and a Kill with SIGTERM. 10s by
	// default. A driver's own stops (an interrupted turn that doesn't end, Stop) go by its CloseGrace
	// instead: SIGTERM that long after the input's closed, SIGKILL twice that.
	KillGrace time.Duration
	// Poll is how often the output is read, at most, when nothing's happening. 200ms by default.
	Poll time.Duration
}
