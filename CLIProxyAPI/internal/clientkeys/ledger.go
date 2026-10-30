package clientkeys

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	log "github.com/sirupsen/logrus"
)

const (
	bucketSeconds = 300
	retentionDays = 31
	dayLayout     = "2006-01-02"
	// Never ".json": the backend loads every *.json under its auth dir as a credential.
	spendSuffix = ".jsonl"
)

// spendEntry is one costed usage record, one JSONL line.
type spendEntry struct {
	Time  int64   `json:"t"` // unix milliseconds, when the request was received
	Key   string  `json:"key"`
	Model string  `json:"model"`
	USD   float64 `json:"usd"`
}

// ledger keeps every spend entry on disk, one JSONL file per UTC day, and per key
// 5-minute spend buckets plus the last use in memory.
type ledger struct {
	mu       sync.Mutex
	dir      string
	now      func() time.Time
	buckets  map[string]map[int64]float64 // key id -> bucket index -> USD
	lastUsed map[string]time.Time
	file     *os.File
	fileDay  string
}

// openLedger loads the retained day files in dir and deletes the expired ones.
func openLedger(dir string, now func() time.Time) (*ledger, error) {
	if errMkdir := os.MkdirAll(dir, 0o700); errMkdir != nil {
		return nil, fmt.Errorf("create spend dir: %w", errMkdir)
	}
	l := &ledger{dir: dir, now: now, buckets: make(map[string]map[int64]float64), lastUsed: make(map[string]time.Time)}
	days, errDays := l.days()
	if errDays != nil {
		return nil, errDays
	}
	cutoff := l.cutoffDay()
	for _, day := range days {
		path := filepath.Join(dir, day+spendSuffix)
		if day < cutoff {
			if errRemove := os.Remove(path); errRemove != nil {
				log.Warnf("client keys: remove expired %s: %v", path, errRemove)
			}
			continue
		}
		if errLoad := l.load(path); errLoad != nil {
			return nil, errLoad
		}
	}
	return l, nil
}

// days lists the day of every spend file, oldest first.
func (l *ledger) days() ([]string, error) {
	items, errRead := os.ReadDir(l.dir)
	if errRead != nil {
		return nil, fmt.Errorf("read spend dir: %w", errRead)
	}
	days := make([]string, 0, len(items))
	for _, item := range items {
		day, ok := strings.CutSuffix(item.Name(), spendSuffix)
		if !ok || item.IsDir() {
			continue
		}
		if _, errParse := time.Parse(dayLayout, day); errParse != nil {
			continue
		}
		days = append(days, day)
	}
	slices.Sort(days)
	return days, nil
}

func (l *ledger) cutoffDay() string {
	return l.now().UTC().AddDate(0, 0, -retentionDays).Format(dayLayout)
}

func (l *ledger) load(path string) error {
	f, errOpen := os.Open(path)
	if errOpen != nil {
		return fmt.Errorf("open %s: %w", path, errOpen)
	}
	defer func() {
		if errClose := f.Close(); errClose != nil {
			log.Warnf("client keys: close %s: %v", path, errClose)
		}
	}()
	reader := bufio.NewReader(f)
	for lineNumber := 1; ; lineNumber++ {
		line, errRead := reader.ReadBytes('\n')
		if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
			var e spendEntry
			// A crash can leave a torn last line; skip anything unreadable.
			if errParse := json.Unmarshal(trimmed, &e); errParse != nil || e.Key == "" {
				log.Warnf("client keys: skipping unreadable line %d of %s", lineNumber, path)
			} else {
				l.apply(e)
			}
		}
		if errors.Is(errRead, io.EOF) {
			return nil
		}
		if errRead != nil {
			return fmt.Errorf("read %s: %w", path, errRead)
		}
	}
}

// add books e in memory and appends it to today's file.
func (l *ledger) add(e spendEntry) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.apply(e)
	if errWrite := l.write(e); errWrite != nil {
		log.Warnf("client keys: write spend entry: %v", errWrite)
	}
}

func (l *ledger) apply(e spendEntry) {
	buckets := l.buckets[e.Key]
	if buckets == nil {
		buckets = make(map[int64]float64)
		l.buckets[e.Key] = buckets
	}
	buckets[e.Time/1000/bucketSeconds] += e.USD
	l.markUsed(e.Key, time.UnixMilli(e.Time))
}

// touch records a use of the key that may not produce a usage record.
func (l *ledger) touch(id string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.markUsed(id, l.now())
}

func (l *ledger) markUsed(id string, at time.Time) {
	if at.After(l.lastUsed[id]) {
		l.lastUsed[id] = at
	}
}

// spend returns the key's spend in every window, counting each 5-minute bucket the window overlaps.
func (l *ledger) spend(id string) map[string]float64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	out := make(map[string]float64, len(Windows))
	for _, window := range Windows {
		out[window] = 0
	}
	for bucket, usd := range l.buckets[id] {
		end := time.Unix((bucket+1)*bucketSeconds, 0)
		for _, window := range Windows {
			if end.After(now.Add(-windowSpans[window])) {
				out[window] += usd
			}
		}
	}
	return out
}

func (l *ledger) lastUse(id string) (time.Time, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	at, ok := l.lastUsed[id]
	return at, ok
}

func (l *ledger) write(e spendEntry) error {
	line, errMarshal := json.Marshal(e)
	if errMarshal != nil {
		return errMarshal
	}
	day := l.now().UTC().Format(dayLayout)
	if l.file == nil || l.fileDay != day {
		l.closeFile()
		f, errOpen := os.OpenFile(filepath.Join(l.dir, day+spendSuffix), os.O_CREATE|os.O_APPEND|os.O_RDWR, 0o600)
		if errOpen != nil {
			return errOpen
		}
		l.file, l.fileDay = f, day
		l.prune()
		if endsTorn(f) {
			line = append([]byte{'\n'}, line...)
		}
	}
	_, errWrite := l.file.Write(append(line, '\n'))
	return errWrite
}

// endsTorn reports whether f ends mid-line, as a crash during a write leaves it.
func endsTorn(f *os.File) bool {
	info, errStat := f.Stat()
	if errStat != nil || info.Size() == 0 {
		return false
	}
	last := make([]byte, 1)
	_, errRead := f.ReadAt(last, info.Size()-1)
	return errRead == nil && last[0] != '\n'
}

// prune drops expired files and buckets; called once per day, when the file rolls over.
func (l *ledger) prune() {
	cutoff := l.cutoffDay()
	days, errDays := l.days()
	if errDays != nil {
		log.Warnf("client keys: prune: %v", errDays)
	}
	for _, day := range days {
		if day < cutoff {
			if errRemove := os.Remove(filepath.Join(l.dir, day+spendSuffix)); errRemove != nil {
				log.Warnf("client keys: remove expired %s: %v", day, errRemove)
			}
		}
	}
	oldest := l.now().Add(-retentionDays*24*time.Hour).Unix() / bucketSeconds
	for id, buckets := range l.buckets {
		for bucket := range buckets {
			if bucket < oldest {
				delete(buckets, bucket)
			}
		}
		if len(buckets) == 0 {
			delete(l.buckets, id)
		}
	}
}

func (l *ledger) closeFile() {
	if l.file == nil {
		return
	}
	if errClose := l.file.Close(); errClose != nil {
		log.Warnf("client keys: close %s: %v", l.fileDay, errClose)
	}
	l.file, l.fileDay = nil, ""
}

func (l *ledger) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closeFile()
}
