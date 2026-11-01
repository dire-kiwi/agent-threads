# The run directory

A backend can run a harness process (a run) under `agent-threads-shim` ([../shim/](../shim/)) instead
of as a child process, so that the run outlives the backend: it keeps going while the backend
restarts, and the restarted backend picks it up again. The shim and the backend never talk
directly. Everything between them goes through files in the run's directory, as this document
says, so that a backend in any language can start a run, follow it, and re-attach to one that
another backend (an older build, or a backend in another language) started.

This is format **1**. It's Unix-only: on Windows, backends run harnesses as child processes.

## Starting a run

```
agent-threads-shim <rundir> -- <program> [args...]
```

The backend makes a new, empty directory for the run (named after the run's id, inside a
directory of runs that's one store's alone, readable by the user only: the runs in it that the
store doesn't follow are stopped and removed, so two stores mustn't share one), writes `run.json` and
`input.jsonl` there (and `prompt`, if it has one), and runs the shim with the program's working
directory and environment, and stdin, stdout and stderr at `/dev/null`. It gives the shim the
directory's absolute path, since the shim starts in the program's working directory. The shim forks and the
process the backend started exits straight away, with 0 once the fork has happened. A non-zero
exit means the run didn't start: 2 for bad arguments (the directory doesn't exist, say), 1 if it
couldn't fork. Then the fork:

1. calls `setsid`, leaving the backend's session and process group, so nothing that happens to the
   backend reaches it;
2. writes `shim.pid`;
3. starts the program in a process group of its own, with stdout appended to `out.jsonl`, stderr
   appended to `err.log`, and stdin a pipe;
4. writes `pid`, the program's pid, which is also its process group's id;
5. relays the program's input (below) while it runs;
6. once the program exits, writes `exit`, and exits itself.

If the program can't be started, the shim writes `exit` with an `error` and exits.

## The files

| File | Written by | What |
| --- | --- | --- |
| `run.json` | backend, before starting the shim | `{"format": 1, ...}`: the format the run was started with, and anything else the backend wants to record (the Node backend writes `run_id`, `thread_id`, `command` and `started_at`). Readers ignore fields they don't know. A run without one is format 1. |
| `prompt` | backend, before starting the shim (optional) | What the program reads first on stdin. |
| `input.jsonl` | backend: created empty before starting the shim; then appended to | What the program reads on stdin after `prompt`, as it's appended. |
| `input.closed` | backend | Ends the program's input. Its content doesn't matter. |
| `shim.pid` | shim | The shim's pid (decimal). |
| `pid` | shim | The program's pid and process group id (decimal). |
| `out.jsonl` | the program (its stdout) | Its output, appended. A harness writes one JSON message a line. |
| `err.log` | the program (its stderr) | Its stderr, appended. |
| `exit` | shim; or a backend that finds the shim gone | How the run ended: `{"code": 0, "signal": null}`. `code` is the exit code or `null`, `signal` the number of the signal that killed it or `null`, and `error` (optional) why it didn't start or why its end is unknown. |
| `stopping` | backend | The run is being stopped: `{"kill_at": ...}`, when its group gets SIGKILL (see [Stopping a run](#stopping-a-run)). |
| `.<name>.tmp` | shim, backend | A file being written, which is renamed over `<name>`: ignore it. |

`shim.pid`, `pid` and `exit` are written whole and then renamed into place, so a reader never sees
half of one: it can poll for them.

## Input

The program's stdin is a pipe. The shim writes `prompt` to it, if there is one; then, if the
directory had an `input.jsonl` when the shim started, everything appended to `input.jsonl`, as
it's appended (the shim polls for more every 20ms or so); and closes it once `input.closed`
exists and everything written to `input.jsonl` before `input.closed` appeared has been passed on.
Without `input.jsonl`, it closes stdin after `prompt`.

A backend appends each line to `input.jsonl` with **one write** (`O_APPEND`, line and newline
together), so a line is never relayed in pieces, and only appends whole lines. Once it has written
`input.closed`, it writes nothing more.

## Following the output

A backend reads `out.jsonl` from an **offset**, the number of bytes it has taken in so far, and only
ever takes in **whole lines**: it reads what's after the offset, takes the lines up to the last
newline, and leaves a partial last line until its newline arrives. Then the offset is always at the
start of a line, and reading again from a saved offset gives exactly the lines after it. The one
exception is a run that's over (it has `exit`): a last line with no newline is complete as it is
(the program was killed while writing it, say), and is taken in whole.

To be sure of seeing all the output, a backend looks for `exit` first, then reads `out.jsonl`: if
`exit` was there, everything the program wrote is in what it read, and once it has taken that in,
the run is over. (Something the program started may still write to `out.jsonl` after the program
exits; a backend may ignore that.)

`err.log` is read the same way, for showing the user what went wrong; its offset isn't saved.

### Saving the offset

The backend saves the offset in its store **with the events it made from the output up to it, in
the same atomic write** (`appendEvents` with the run, in
[conformance/store.md](conformance/store.md)), along with anything else it needs to carry on
reading (what a driver keeps between lines: which requests are open, which messages it streamed).
So whatever it is killed in the middle of, the store has the events for exactly the output before
the saved offset, and re-reading from there makes the rest: no event is lost, and none is made
twice. Output that makes no events needn't be saved straight away: reading it again from an older
offset (with the state saved with that offset) makes nothing new.

### Input written after the offset

Reading the output again can make the backend write input again: what it wrote in answer to
output it had read, but hadn't saved yet when it stopped (a message it sends once the harness has
answered `initialize`, an answer to a request a policy allowed). `input.jsonl` is the record of
what was written, so the backend saves with the offset how much of `input.jsonl` it had written
(the Node backend's `input`, in bytes). After a restart, the lines after that are written already:
until it has written each of them again, a line it would write that's the same as one of them
(byte for byte) is taken to be that one, and isn't written again. Whatever it's killed in the middle
of, nothing that's in `input.jsonl` is written to it twice.

## A run whose shim is gone

A shim killed with SIGKILL (or a machine that restarted) leaves a run with no `exit`. A backend that
follows a run checks now and then (every second or so) that its shim is still there; if it isn't,
and there's still no `exit`, it writes `exit` itself, atomically and only if there isn't one, with
`code` and `signal` `null` and an `error` saying the shim went away, and treats the run as over.

The shim is there if the process in `shim.pid` is, and is the shim:

- `shim.pid` was written since the machine last started (its modification time is after the boot);
- the process is running (`kill(pid, 0)` succeeds or fails with `EPERM`) and isn't a zombie (one
  that has exited and isn't reaped, whose state in `/proc/<pid>/stat`, or `ps -o stat=`, starts
  with `Z` or `X`);
- it started no later than `shim.pid` was written: the first time a backend checks, the process's
  start (from `/proc/<pid>/stat`'s `starttime` and `/proc/stat`'s `btime` on Linux, which is
  cheap; elsewhere `ps -o lstart= -p <pid>`, to the second) must be before the file's modification
  time (with a second to spare). The backend remembers that identity (the pid, the start, and where
  it was read) and checks it each time after: a process with the pid that started at another time
  is another process, given the pid since, and the shim is gone.

When the start can't be told (no `/proc`, and `ps` isn't there, fails or times out), or it's read
another way than the identity was (from `ps` when it was from `/proc`, or the other way round,
which don't agree to the millisecond), the backend doesn't take the shim for gone: a running process with the pid (written this boot) counts as the
shim, the identity isn't changed, and it tries again the next time. Nor does it signal anything on the
strength of a start it couldn't tell (see below).

A run with no `shim.pid` some seconds after the shim was started never started.

With its shim gone, nothing would stop the program, which may well still be running: the backend
stops what's left of the run's process group, as below.

## Stopping a run

To stop a run, a backend first asks the harness, in the harness's own protocol over `input.jsonl`
(Claude's `interrupt` control request, Codex's `turn/interrupt`); then, if the turn doesn't end, writes
`input.closed`, which a harness takes as the end of its input; then, if the run hasn't ended after a
grace period, sends SIGTERM to the program's process group (`kill(-pid, SIGTERM)`, `pid` from
`pid`), and SIGKILL if it still hasn't. (The Node backend's graces are its drivers'
`stopGraceMs` and `closeGraceMs`.) A run nothing will follow any more is stopped from the second
step. Signalling the group stops whatever the program started too, and the SIGKILL goes to
whatever is left of the group after the grace even if the program itself has exited (it may have
left children that ignore SIGTERM). A backend never signals the shim: it writes `exit` once the
program has gone.

A run with no `pid` yet is signalled as soon as `pid` appears (while the shim may still start the
program; not once its shim is gone).

A backend **only signals a group that is still the run's**. The pid in `pid` may since have been
given to another process: after the machine restarted, or once the program and everything in its
group has gone. So it signals `-pid` only if `pid` was written since the machine last started, and
either:

- the process `pid` is running and started no later than `pid` was written (its start told as
  for the shim, above; if it can't be told, nothing is sent); or
- that process has gone, and everything left in group `pid` is in the run's session: the shim
  leads a session of its own, whose id is its pid, so their session id is the one in `shim.pid`
  (written since the machine started too). The group's id alone says nothing here: it may have gone
  to another group whose leader has gone in turn. (On Linux from `/proc/<pid>/stat`'s `pgrp` and
  `session`; elsewhere `ps -e -o pgid= -o sid=`, where `ps` has it.)

If it can't tell (a `ps` that doesn't give session ids, say), it sends nothing.

Stopping takes a while, and the backend may stop or restart meanwhile, so it writes down that it's
stopping a run before it sends SIGTERM: a `stopping` file, `{"kill_at": <ms since the epoch>}`, when
the SIGKILL is due. Until the group has gone and the file is removed, a backend keeps the run's
directory, and one that starts carries on with it (whatever the store says about the run, and
whether or not it has `exit`): at `kill_at` it sends SIGKILL to whatever is left of the group (if
it's still the run's, as above), then removes `stopping`. A backend that shuts down meanwhile waits
for that first.

## Re-attaching

When a backend starts, it looks in its store for the runs it hadn't finished with (`activeRuns`).
For each it reads the directory from the saved offset, as above, with the state saved with it: a
run that's still going is followed as before, and one that ended while the backend was down is read
to its end, so its thread finishes as it would have. A backend that can't carry on with a run (its
driver can't re-attach, or the run is in a newer format than it knows) stops it, as above, and ends
the thread's turn.

A run is the store's once its record is saved. A run directory whose run isn't in the store, or is
there as finished, but whose shim is alive, is a run nothing follows (its backend died before
saving it, or was stopping it when it died): a backend stops it.

## Removing runs

A finished run's directory has all its output, which is useful for working out what went wrong
but isn't needed once the backend has taken it in. A backend removes the directories of runs it
finished with a while ago (the Node backend keeps them 14 days), and of finished runs that aren't
in its store, after an hour. It leaves the others: runs it follows, and runs still starting.

## Changing the format

Shims and the programs they run aren't upgraded while they run, so a newer backend must follow runs
an older one started. Changes are additive (new files, new fields in `run.json` and `exit`) where
they can be; a change that older readers can't handle gets a new format number in `run.json`,
and readers keep reading the formats before it. A backend doesn't follow a run in a format newer
than it knows: it stops it.
