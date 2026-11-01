package agentthreads

type ShimOptions struct{ RunsDir string }

func Shim(path string, o ShimOptions) Spawner { return Direct() }
