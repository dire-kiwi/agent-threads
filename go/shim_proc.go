//go:build unix

package agentthreads

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Telling whether a run's shim and its process group are still the run's (spec/RUNDIR.md, "A run
// whose shim is gone" and "Stopping a run").

// alive says whether a process with the pid is running (or there, and not ours to signal).
func alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

// groupExists says whether anything is left in process group pgid (whoever's it is).
func groupExists(pgid int) bool {
	err := syscall.Kill(-pgid, 0)
	return err == nil || err == syscall.EPERM
}

// writtenThisBoot is when a run directory's file was written, if it was since the machine started
// (before, its pid is stale).
func writtenThisBoot(dir, name string) (time.Time, bool) {
	st, err := os.Stat(filepath.Join(dir, name))
	if err != nil {
		return time.Time{}, false
	}
	at := st.ModTime()
	boot, ok := bootTime()
	if ok && at.Before(boot.Add(-time.Second)) {
		return time.Time{}, false
	}
	return at, true
}

// identity is a process's identity: its pid, when it started (which a pid given to another process
// differs in), and where that was read, since /proc and ps don't tell it alike.
type identity struct {
	pid    int
	start  time.Time
	source string
}

type identityBox struct{ id *identity }

// procInfo is what's known of a running process: when it started, whether it has exited unreaped,
// and where that was read.
type procInfo struct {
	start  time.Time
	zombie bool
	source string
}

// shimAlive says whether the run's shim is alive: the process in shim.pid (written since the machine
// started) is running (not a zombie), and is the shim, which started before shim.pid was written
// (not another process given the same pid since). known keeps the identity found the first time,
// which the process with the pid must still have each time after. When that can't be told, a
// running process with the pid counts as the shim, and it's checked again next time.
func shimAlive(dir string, known *identityBox) bool {
	pid := readPid(dir, "shim.pid")
	written, ok := writtenThisBoot(dir, "shim.pid")
	if pid == 0 || !ok || !alive(pid) {
		return false
	}
	info := processInfo(pid)
	if info == nil {
		return true
	}
	if info.zombie {
		return false
	}
	if known != nil && known.id != nil && known.id.pid == pid {
		id := known.id
		if id.source == info.source {
			return id.start.Equal(info.start)
		}
		// /proc and ps agree on a start to within a second (ps has it to the second).
		d := id.start.Sub(info.start)
		return d < time.Second && d > -time.Second
	}
	ours := !info.start.After(written.Add(time.Second))
	if ours && known != nil {
		known.id = &identity{pid: pid, start: info.start, source: info.source}
	}
	return ours
}

// processInfo is a process's start and state, if it's running and that can be told: from /proc on
// Linux (cheap, and to the clock tick), or from ps (to the second) elsewhere.
func processInfo(pid int) *procInfo {
	if runtime.GOOS == "linux" {
		if info := procStat(pid); info != nil {
			return info
		}
	}
	out, err := runPS("-o", "stat=", "-o", "lstart=", "-p", strconv.Itoa(pid))
	if err != nil {
		return nil
	}
	m := psLine.FindStringSubmatch(out)
	if m == nil {
		return nil
	}
	at, err := time.ParseInLocation("Mon Jan _2 15:04:05 2006", strings.Join(strings.Fields(m[2]), " "), time.Local)
	if err != nil {
		at, err = time.ParseInLocation("Mon Jan 2 15:04:05 2006", strings.Join(strings.Fields(m[2]), " "), time.Local)
	}
	if err != nil {
		return nil
	}
	return &procInfo{start: at, zombie: strings.HasPrefix(m[1], "Z") || strings.HasPrefix(m[1], "X"), source: "ps"}
}

var psLine = regexp.MustCompile(`(?s)^\s*(\S+)\s+(.+?)\s*$`)

func runPS(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ps", args...)
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	out, err := cmd.Output()
	return string(out), err
}

// procFields is the fields of /proc/<pid>/stat after the command (the first is field 3, the state).
func procFields(pid string) []string {
	data, err := os.ReadFile("/proc/" + pid + "/stat")
	if err != nil {
		return nil
	}
	s := string(data)
	// After the command, which is in parentheses and may have spaces or parentheses in it.
	at := strings.LastIndexByte(s, ')')
	if at < 0 || at+2 > len(s) {
		return nil
	}
	return strings.Fields(s[at+2:])
}

var (
	btimeOnce sync.Once
	btime     time.Time
	btimeOK   bool
)

// procBtime is when the machine started, as /proc/stat's btime has it.
func procBtime() (time.Time, bool) {
	btimeOnce.Do(func() {
		data, err := os.ReadFile("/proc/stat")
		if err != nil {
			return
		}
		for _, line := range strings.Split(string(data), "\n") {
			if rest, ok := strings.CutPrefix(line, "btime "); ok {
				if n, err := strconv.ParseInt(strings.TrimSpace(rest), 10, 64); err == nil {
					btime, btimeOK = time.Unix(n, 0), true
				}
			}
		}
	})
	return btime, btimeOK
}

// clockTicks is clock ticks a second, as /proc counts them (USER_HZ: 100 on Linux, whatever the
// kernel's HZ).
const clockTicks = 100

// procStat is a process's start and state from /proc/<pid>/stat (clock ticks after boot) and
// /proc/stat's btime.
func procStat(pid int) *procInfo {
	boot, ok := procBtime()
	fields := procFields(strconv.Itoa(pid))
	if !ok || len(fields) < 20 {
		return nil
	}
	// starttime is field 22; fields[0] here is field 3 (state).
	ticks, err := strconv.ParseInt(fields[19], 10, 64)
	if err != nil {
		return nil
	}
	// A tick at a time (10ms), so a host that has been up for years doesn't overflow it.
	start := boot.Add(time.Duration(ticks) * (time.Second / clockTicks))
	return &procInfo{start: start, zombie: fields[0] == "Z" || fields[0] == "X", source: "proc"}
}

// groupSessions is the session ids of the processes in process group pgid, if they can be told.
func groupSessions(pgid int) ([]int, bool) {
	if runtime.GOOS == "linux" {
		if entries, err := os.ReadDir("/proc"); err == nil {
			var sids []int
			for _, e := range entries {
				name := e.Name()
				if name == "" || name[0] < '0' || name[0] > '9' {
					continue
				}
				// pgrp is field 5 and session field 6.
				f := procFields(name)
				if len(f) < 4 {
					continue
				}
				if g, _ := strconv.Atoi(f[2]); g == pgid {
					sid, _ := strconv.Atoi(f[3])
					sids = append(sids, sid)
				}
			}
			return sids, true
		}
	}
	out, err := runPS("-e", "-o", "pgid=", "-o", "sid=")
	if err != nil {
		return nil, false
	}
	var sids []int
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) != 2 {
			continue
		}
		g, err1 := strconv.Atoi(f[0])
		sid, err2 := strconv.Atoi(f[1])
		if err1 == nil && err2 == nil && g == pgid {
			sids = append(sids, sid)
		}
	}
	return sids, true
}

// liveGroup is the run's process group (the program's pid), if it's still the run's and anything in
// it is running: never a group whose id the system has since given to another process. When that
// can't be told, it's none (0).
func liveGroup(dir string) int {
	pid := readPid(dir, "pid")
	written, ok := writtenThisBoot(dir, "pid")
	// Written before the machine restarted: the pid means nothing now.
	if pid == 0 || !ok {
		return 0
	}
	if alive(pid) {
		leader := processInfo(pid)
		if leader == nil {
			return 0 // Can't tell whose it is.
		}
		if !leader.zombie {
			// The program, if it started before its pid was written; not a new process given the same pid.
			if !leader.start.After(written.Add(time.Second)) {
				return pid
			}
			return 0
		}
	}
	// The program's gone. What's left in a group with its id is the run's only if it's in the run's
	// session, which the shim leads (its pid is the session's id): the id may have gone to another
	// group since, whose leader has gone too.
	shim := readPid(dir, "shim.pid")
	if _, ok := writtenThisBoot(dir, "shim.pid"); shim == 0 || !ok {
		return 0
	}
	sids, ok := groupSessions(pid)
	if !ok || len(sids) == 0 {
		return 0
	}
	for _, sid := range sids {
		if sid != shim {
			return 0
		}
	}
	return pid
}
