package agentthreads

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/dire-kiwi/agent-threads/go/protocol"
)

// FileStore keeps threads in a directory, with one JSONL file per thread. Each line is a change:
// the thread as created or updated, a batch of events, a snapshot or a run. The files are read into
// memory when the store opens, and each change is appended and synced before the operation
// returns, so it survives the process being killed. A write that fails is cut off the file again,
// so a failed operation leaves nothing behind; a half-written last line (from a crash mid-write) is
// dropped. The files are the same as the Node backend's FileStore's, so either can open them.
type FileStore struct {
	dir   string
	mu    sync.Mutex
	mem   *MemoryStore
	files map[string]*storeFile
	// A run's lines carry a revision, counted across the store, since a run moved to another thread
	// is in two files: the latest of its lines says where it is (or, if it's run_moved, that it's
	// gone).
	rev int64
	// Why a failed write couldn't be undone, after which nothing more is written until a reopen.
	broken error
}

type storeFile struct {
	f    *os.File
	size int64
}

type fileLine struct {
	Thread   *protocol.Thread       `json:"thread,omitempty"`
	Events   []protocol.ThreadEvent `json:"events,omitempty"`
	Runs     []revRun               `json:"runs,omitempty"`
	Snapshot *protocol.Snapshot     `json:"snapshot,omitempty"`
	Run      *RunRecord             `json:"run,omitempty"`
	RunMoved string                 `json:"run_moved,omitempty"`
	Rev      *int64                 `json:"rev,omitempty"`
}

type revRun struct {
	Run RunRecord `json:"run"`
	Rev int64     `json:"rev"`
}

const fileSuffix = ".jsonl"

// NewFileStore opens (or makes) the store in dir.
func NewFileStore(dir string) (*FileStore, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &FileStore{dir: dir, files: map[string]*storeFile{}}
	state, err := s.load()
	if err != nil {
		return nil, err
	}
	s.mem = NewMemoryStoreOn(state)
	return s, nil
}

// Dir is the store's directory.
func (s *FileStore) Dir() string { return s.dir }

func (s *FileStore) path(id string) string {
	return filepath.Join(s.dir, encodeURIComponent(id)+fileSuffix)
}

type runAt struct {
	run *RunRecord
	rev int64
}

func (s *FileStore) load() (*MemoryState, error) {
	state := NewMemoryState()
	runs := map[string]runAt{} // each run's latest line
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, fileSuffix) {
			continue
		}
		path := filepath.Join(s.dir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		if end := bytes.LastIndexByte(data, '\n') + 1; end < len(data) {
			// The last write didn't finish: it never returned, so it didn't happen.
			if err := os.Truncate(path, int64(end)); err != nil {
				return nil, err
			}
			data = data[:end]
		}
		id := ""
		mine := map[string]runAt{} // this file's, as its lines leave them
		for _, raw := range bytes.Split(data, []byte("\n")) {
			if len(raw) == 0 {
				continue
			}
			var line fileLine
			if err := json.Unmarshal(raw, &line); err != nil {
				return nil, fmt.Errorf("%s: %w", path, err)
			}
			rev := int64(0)
			if line.Rev != nil {
				rev = *line.Rev
			}
			switch {
			case line.Thread != nil:
				id = line.Thread.ID
				state.threads[id] = *line.Thread
				if _, ok := state.events[id]; !ok {
					state.events[id] = nil
				}
			case id == "":
				return nil, fmt.Errorf("%s doesn't start with its thread", path)
			case line.Events != nil || line.Runs != nil:
				log := state.events[id]
				for _, e := range line.Events {
					if e.Seq() > lastOf(log) {
						log = append(log, e)
					}
				}
				state.events[id] = log
				for _, r := range line.Runs {
					run := r.Run
					mine[run.ID] = runAt{&run, r.Rev}
				}
			case line.Snapshot != nil:
				state.snapshots[id] = *line.Snapshot
			case line.Run != nil:
				mine[line.Run.ID] = runAt{line.Run, rev}
			case line.RunMoved != "":
				mine[line.RunMoved] = runAt{nil, rev}
			}
		}
		for rid, r := range mine {
			s.rev = max(s.rev, r.rev)
			if was, ok := runs[rid]; !ok || r.rev >= was.rev {
				runs[rid] = r
			}
		}
	}
	for rid, r := range runs {
		if r.run != nil {
			state.runs[rid] = *r.run
		}
	}
	return state, nil
}

func (s *FileStore) file(id string) (*storeFile, error) {
	if f, ok := s.files[id]; ok {
		return f, nil
	}
	f, err := os.OpenFile(s.path(id), os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	sf := &storeFile{f: f, size: st.Size()}
	s.files[id] = sf
	return sf, nil
}

// pendingLine is a line to write to thread id's file: a map, so only its own fields are written,
// as the Node backend writes them.
type pendingLine struct {
	id   string
	line map[string]any
}

// appendLines appends lines (to one thread's file or several), all or none: each is written in full
// and synced, and if one fails, what was written is cut off again.
func (s *FileStore) appendLines(lines ...pendingLine) error {
	if s.broken != nil {
		return fmt.Errorf("the store can't be written to until it's opened again: a failed write couldn't be undone (%w)", s.broken)
	}
	type written struct {
		f    *storeFile
		size int64
	}
	var done []written
	undo := func() {
		for i := len(done) - 1; i >= 0; i-- {
			w := done[i]
			if err := w.f.f.Truncate(w.size); err != nil {
				s.broken = err
				continue
			}
			if err := w.f.f.Sync(); err != nil {
				s.broken = err
				continue
			}
			w.f.size = w.size
		}
	}
	for _, l := range lines {
		f, err := s.file(l.id)
		if err != nil {
			undo()
			return err
		}
		done = append(done, written{f, f.size})
		data, err := json.Marshal(l.line)
		if err != nil {
			undo()
			return err
		}
		data = append(data, '\n')
		if _, err := f.f.Write(data); err != nil {
			undo()
			return err
		}
		if err := f.f.Sync(); err != nil {
			undo()
			return err
		}
		f.size += int64(len(data))
	}
	return nil
}

func (s *FileStore) known(id string) error {
	s.mem.state.mu.Lock()
	defer s.mem.state.mu.Unlock()
	if _, ok := s.mem.state.threads[id]; !ok {
		return notFound(id)
	}
	return nil
}

func (s *FileStore) CreateThread(ctx context.Context, thread protocol.Thread) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t, _ := s.mem.GetThread(ctx, thread.ID); t != nil {
		return NewStoreError(StoreErrExists, "thread %s exists", thread.ID)
	}
	if err := s.appendLines(pendingLine{thread.ID, map[string]any{"thread": thread}}); err != nil {
		return err
	}
	return s.mem.CreateThread(ctx, thread)
}

func (s *FileStore) GetThread(ctx context.Context, id string) (*protocol.Thread, error) {
	return s.mem.GetThread(ctx, id)
}

func (s *FileStore) ListThreads(ctx context.Context) ([]protocol.Thread, error) {
	return s.mem.ListThreads(ctx)
}

func (s *FileStore) UpdateThread(ctx context.Context, thread protocol.Thread) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.known(thread.ID); err != nil {
		return err
	}
	if err := s.appendLines(pendingLine{thread.ID, map[string]any{"thread": thread}}); err != nil {
		return err
	}
	return s.mem.UpdateThread(ctx, thread)
}

func (s *FileStore) DeleteThread(ctx context.Context, id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.known(id) != nil {
		return false, nil
	}
	if f, ok := s.files[id]; ok {
		f.f.Close()
		delete(s.files, id)
	}
	if err := os.Remove(s.path(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	return s.mem.DeleteThread(ctx, id)
}

func (s *FileStore) AppendEvents(ctx context.Context, id string, events []protocol.ThreadEvent, runs []RunRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	last, err := s.mem.LastSeq(ctx, id)
	if err != nil {
		return err
	}
	if err := CheckEvents(id, last, events, runs); err != nil {
		return err
	}
	if len(events) == 0 && len(runs) == 0 {
		return nil
	}
	rev := s.rev
	var lines []pendingLine
	var revs []revRun
	for _, run := range runs {
		if from := s.moved(run); from != "" {
			rev++
			lines = append(lines, pendingLine{from, map[string]any{"run_moved": run.ID, "rev": rev}})
		}
		rev++
		revs = append(revs, revRun{run, rev})
	}
	if events == nil {
		events = []protocol.ThreadEvent{}
	}
	line := map[string]any{"events": events}
	if len(revs) > 0 {
		line["runs"] = revs
	}
	lines = append(lines, pendingLine{id, line})
	if err := s.appendLines(lines...); err != nil {
		return err
	}
	s.rev = rev
	return s.mem.AppendEvents(ctx, id, events, runs)
}

// moved is the thread a run was in before, if putting it in another moves it out of that one's file.
func (s *FileStore) moved(run RunRecord) string {
	s.mem.state.mu.Lock()
	defer s.mem.state.mu.Unlock()
	before, ok := s.mem.state.runs[run.ID]
	if !ok || before.ThreadID == run.ThreadID {
		return ""
	}
	if _, ok := s.mem.state.threads[before.ThreadID]; !ok {
		return ""
	}
	return before.ThreadID
}

func (s *FileStore) ReadEvents(ctx context.Context, id string, after int64, limit int) ([]protocol.ThreadEvent, error) {
	return s.mem.ReadEvents(ctx, id, after, limit)
}

func (s *FileStore) LastSeq(ctx context.Context, id string) (int64, error) {
	return s.mem.LastSeq(ctx, id)
}

func (s *FileStore) SaveSnapshot(ctx context.Context, id string, snapshot protocol.Snapshot) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.known(id); err != nil {
		return err
	}
	if err := s.appendLines(pendingLine{id, map[string]any{"snapshot": snapshot}}); err != nil {
		return err
	}
	return s.mem.SaveSnapshot(ctx, id, snapshot)
}

func (s *FileStore) LoadSnapshot(ctx context.Context, id string) (*protocol.Snapshot, error) {
	return s.mem.LoadSnapshot(ctx, id)
}

func (s *FileStore) PutRun(ctx context.Context, run RunRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.known(run.ThreadID); err != nil {
		return err
	}
	var lines []pendingLine
	rev := s.rev
	if from := s.moved(run); from != "" {
		rev++
		lines = append(lines, pendingLine{from, map[string]any{"run_moved": run.ID, "rev": rev}})
	}
	rev++
	lines = append(lines, pendingLine{run.ThreadID, map[string]any{"run": run, "rev": rev}})
	if err := s.appendLines(lines...); err != nil {
		return err
	}
	s.rev = rev
	return s.mem.PutRun(ctx, run)
}

func (s *FileStore) GetRun(ctx context.Context, id string) (*RunRecord, error) {
	return s.mem.GetRun(ctx, id)
}

func (s *FileStore) ActiveRuns(ctx context.Context) ([]RunRecord, error) {
	return s.mem.ActiveRuns(ctx)
}

func (s *FileStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var errs []error
	for id, f := range s.files {
		errs = append(errs, f.f.Close())
		delete(s.files, id)
	}
	return errors.Join(errs...)
}

// encodeURIComponent escapes s as JavaScript's encodeURIComponent does, so the files' names are
// the Node backend's.
func encodeURIComponent(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}
