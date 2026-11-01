//go:build windows

package agentthreads

// Shim is the direct spawner on Windows, where agent-threads-shim doesn't run.
func Shim(path string, o ShimOptions) Spawner { return Direct() }
