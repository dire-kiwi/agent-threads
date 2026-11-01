package agentthreads

import (
	"crypto/rand"
	"encoding/hex"
	"strconv"
	"time"
)

// NewID is a new id, <prefix>_<time><random>, so ids made later sort later: for the threads, turns,
// requests and items the backend makes itself.
func NewID(prefix string) string {
	b := make([]byte, 6)
	rand.Read(b)
	return prefix + "_" + strconv.FormatInt(time.Now().UnixMilli(), 36) + hex.EncodeToString(b)
}

// now is the time as the protocol writes it (RFC 3339, UTC, with milliseconds).
func now() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}
