package main

import (
	"bufio"
	"cmp"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

const (
	hourSeconds     int64 = 3600
	failureRingSize       = 1000
	maxFailures           = 100
	maxMessageRunes       = 300
	dayLayout             = "2006-01-02"
	// Never ".json": the backend loads every *.json under its auth dir as a credential.
	fileSuffix = ".jsonl"
)

// entry is one persisted upstream attempt, one JSONL line.
type entry struct {
	Time      int64  `json:"t"` // unix milliseconds, when the request was received
	Model     string `json:"model"`
	Upstream  string `json:"upstream,omitempty"`
	Provider  string `json:"provider,omitempty"`
	AuthIndex string `json:"auth_index,omitempty"`
	AuthID    string `json:"auth_id,omitempty"`
	APIKey    string `json:"api_key,omitempty"`
	Failed    bool   `json:"failed,omitempty"`
	Status    int    `json:"status,omitempty"`
	Message   string `json:"message,omitempty"`
	Input     int64  `json:"in,omitempty"`
	Output    int64  `json:"out,omitempty"`
	Reasoning int64  `json:"reasoning,omitempty"`
	Cached    int64  `json:"cached,omitempty"`
	Total     int64  `json:"total,omitempty"`
	LatencyMs int64  `json:"latency_ms,omitempty"`
	TTFTMs    int64  `json:"ttft_ms,omitempty"` // zero means the attempt had no first-token time
}

type rowKey struct {
	Hour                                         int64
	Model, Upstream, Provider, AuthIndex, APIKey string
}

// row is one hourly rollup bucket served by the stats route.
type row struct {
	Hour            int64  `json:"hour"`
	Model           string `json:"model"`
	UpstreamModel   string `json:"upstream_model"`
	Provider        string `json:"provider"`
	AuthIndex       string `json:"auth_index"`
	AuthID          string `json:"auth_id"`
	APIKey          string `json:"api_key"`
	Requests        int64  `json:"requests"`
	Failed          int64  `json:"failed"`
	InputTokens     int64  `json:"input_tokens"`
	OutputTokens    int64  `json:"output_tokens"`
	ReasoningTokens int64  `json:"reasoning_tokens"`
	CachedTokens    int64  `json:"cached_tokens"`
	TotalTokens     int64  `json:"total_tokens"`
	LatencyMs       int64  `json:"latency_ms"`
	TTFTMs          int64  `json:"ttft_ms"`
	TTFTCount       int64  `json:"ttft_count"`
}

type failure struct {
	Time          string `json:"time"`
	Model         string `json:"model"`
	UpstreamModel string `json:"upstream_model"`
	Provider      string `json:"provider"`
	AuthIndex     string `json:"auth_index"`
	AuthID        string `json:"auth_id"`
	APIKey        string `json:"api_key"`
	Status        int    `json:"status"`
	Message       string `json:"message"`
}

type stats struct {
	Rows     []row     `json:"rows"`
	Failures []failure `json:"failures"`
}

// store keeps every entry on disk, one JSONL file per UTC day, and an hourly rollup
// plus the most recent failures in memory.
type store struct {
	mu            sync.Mutex
	dir           string
	retentionDays int
	now           func() time.Time
	rows          map[rowKey]*row
	failures      []entry // oldest first, at most failureRingSize
	file          *os.File
	fileDay       string
}

// openStore loads the retained files in dir and deletes the expired ones.
func openStore(dir string, retentionDays int, now func() time.Time) (*store, error) {
	if errMkdir := os.MkdirAll(dir, 0o700); errMkdir != nil {
		return nil, fmt.Errorf("create data dir: %w", errMkdir)
	}
	s := &store{dir: dir, retentionDays: retentionDays, now: now, rows: make(map[rowKey]*row)}
	days, errDays := s.days()
	if errDays != nil {
		return nil, errDays
	}
	cutoff := s.cutoffDay()
	for _, day := range days {
		path := filepath.Join(dir, day+fileSuffix)
		if day < cutoff {
			if errRemove := os.Remove(path); errRemove != nil {
				logf("remove expired %s: %v", path, errRemove)
			}
			continue
		}
		if errLoad := s.load(path); errLoad != nil {
			return nil, errLoad
		}
	}
	return s, nil
}

// days lists the day of every data file in the store's dir, oldest first.
func (s *store) days() ([]string, error) {
	items, errRead := os.ReadDir(s.dir)
	if errRead != nil {
		return nil, fmt.Errorf("read data dir: %w", errRead)
	}
	days := make([]string, 0, len(items))
	for _, item := range items {
		day, ok := strings.CutSuffix(item.Name(), fileSuffix)
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

func (s *store) cutoffDay() string {
	return s.now().UTC().AddDate(0, 0, -s.retentionDays).Format(dayLayout)
}

func (s *store) load(path string) error {
	f, errOpen := os.Open(path)
	if errOpen != nil {
		return fmt.Errorf("open %s: %w", path, errOpen)
	}
	defer func() {
		if errClose := f.Close(); errClose != nil {
			logf("close %s: %v", path, errClose)
		}
	}()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		var e entry
		// A crash can leave a torn last line; skip anything unreadable.
		if json.Unmarshal(scanner.Bytes(), &e) == nil {
			s.apply(e)
		}
	}
	if errScan := scanner.Err(); errScan != nil {
		return fmt.Errorf("read %s: %w", path, errScan)
	}
	return nil
}

// add records e in memory and appends it to today's file.
func (s *store) add(e entry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.apply(e)
	if errWrite := s.write(e); errWrite != nil {
		logf("write entry: %v", errWrite)
	}
}

func (s *store) apply(e entry) {
	hour := floorHour(e.Time / 1000)
	key := rowKey{Hour: hour, Model: e.Model, Upstream: e.Upstream, Provider: e.Provider, AuthIndex: e.AuthIndex, APIKey: e.APIKey}
	r := s.rows[key]
	if r == nil {
		r = &row{Hour: hour, Model: e.Model, UpstreamModel: e.Upstream, Provider: e.Provider, AuthIndex: e.AuthIndex, APIKey: e.APIKey}
		s.rows[key] = r
	}
	if e.AuthID != "" {
		r.AuthID = e.AuthID
	}
	r.Requests++
	r.InputTokens += e.Input
	r.OutputTokens += e.Output
	r.ReasoningTokens += e.Reasoning
	r.CachedTokens += e.Cached
	r.TotalTokens += e.Total
	r.LatencyMs += e.LatencyMs
	if e.TTFTMs > 0 {
		r.TTFTMs += e.TTFTMs
		r.TTFTCount++
	}
	if e.Failed {
		r.Failed++
		s.failures = append(s.failures, e)
		if len(s.failures) > failureRingSize {
			s.failures = s.failures[len(s.failures)-failureRingSize:]
		}
	}
}

func (s *store) write(e entry) error {
	line, errMarshal := json.Marshal(e)
	if errMarshal != nil {
		return errMarshal
	}
	day := s.now().UTC().Format(dayLayout)
	if s.file == nil || s.fileDay != day {
		s.closeFile()
		f, errOpen := os.OpenFile(filepath.Join(s.dir, day+fileSuffix), os.O_CREATE|os.O_APPEND|os.O_RDWR, 0o600)
		if errOpen != nil {
			return errOpen
		}
		s.file, s.fileDay = f, day
		s.prune()
		if endsTorn(f) {
			line = append([]byte{'\n'}, line...)
		}
	}
	_, errWrite := s.file.Write(append(line, '\n'))
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

// prune drops expired files and rollup rows; called once per day, when the file rolls over.
func (s *store) prune() {
	cutoff := s.cutoffDay()
	days, errDays := s.days()
	if errDays != nil {
		logf("prune: %v", errDays)
	}
	for _, day := range days {
		if day < cutoff {
			if errRemove := os.Remove(filepath.Join(s.dir, day+fileSuffix)); errRemove != nil {
				logf("remove expired %s: %v", day, errRemove)
			}
		}
	}
	cutoffTime, _ := time.Parse(dayLayout, cutoff)
	for key := range s.rows {
		if key.Hour < cutoffTime.Unix() {
			delete(s.rows, key)
		}
	}
}

func (s *store) closeFile() {
	if s.file == nil {
		return
	}
	if errClose := s.file.Close(); errClose != nil {
		logf("close %s: %v", s.fileDay, errClose)
	}
	s.file, s.fileDay = nil, ""
}

func (s *store) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closeFile()
}

// query returns the rollup rows whose hour starts in [floorHour(from), to) and the
// newest failures received in [from, to), all times in unix seconds.
func (s *store) query(from, to int64) stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := stats{Rows: make([]row, 0), Failures: make([]failure, 0)}
	fromHour := floorHour(from)
	for _, r := range s.rows {
		if r.Hour >= fromHour && r.Hour < to {
			out.Rows = append(out.Rows, *r)
		}
	}
	slices.SortFunc(out.Rows, func(a, b row) int {
		return cmp.Or(
			cmp.Compare(a.Hour, b.Hour),
			strings.Compare(a.Model, b.Model),
			strings.Compare(a.UpstreamModel, b.UpstreamModel),
			strings.Compare(a.Provider, b.Provider),
			strings.Compare(a.AuthIndex, b.AuthIndex),
			strings.Compare(a.APIKey, b.APIKey),
		)
	})
	matched := make([]entry, 0)
	for _, e := range s.failures {
		if e.Time >= from*1000 && e.Time < to*1000 {
			matched = append(matched, e)
		}
	}
	slices.SortStableFunc(matched, func(a, b entry) int { return cmp.Compare(b.Time, a.Time) })
	if len(matched) > maxFailures {
		matched = matched[:maxFailures]
	}
	for _, e := range matched {
		out.Failures = append(out.Failures, failure{
			Time:          time.UnixMilli(e.Time).UTC().Format(time.RFC3339),
			Model:         e.Model,
			UpstreamModel: e.Upstream,
			Provider:      e.Provider,
			AuthIndex:     e.AuthIndex,
			AuthID:        e.AuthID,
			APIKey:        e.APIKey,
			Status:        e.Status,
			Message:       e.Message,
		})
	}
	return out
}

// entryFromRecord compacts a usage record; the client key is reduced to a hint.
func entryFromRecord(r pluginapi.UsageRecord, now time.Time) entry {
	at := r.RequestedAt
	if at.IsZero() {
		at = now
	}
	upstream := strings.TrimSpace(r.Model)
	model := strings.TrimSpace(r.Alias)
	if model == "" {
		model = upstream
	}
	// Cache reads are what "cached" means everywhere; providers that don't split them out only fill CachedTokens.
	cached := r.Detail.CacheReadTokens
	if cached == 0 && r.Detail.CacheCreationTokens == 0 {
		cached = r.Detail.CachedTokens
	}
	e := entry{
		Time:      at.UnixMilli(),
		Model:     model,
		Upstream:  upstream,
		Provider:  strings.TrimSpace(r.Provider),
		AuthIndex: strings.TrimSpace(r.AuthIndex),
		AuthID:    strings.TrimSpace(r.AuthID),
		APIKey:    keyHint(r.APIKey),
		Input:     r.Detail.InputTokens,
		Output:    r.Detail.OutputTokens,
		Reasoning: r.Detail.ReasoningTokens,
		Cached:    cached,
		Total:     r.Detail.TotalTokens,
		LatencyMs: r.Latency.Milliseconds(),
	}
	// The host also times the first byte of non-streamed responses; that is latency, not TTFT.
	if r.Stream && r.TTFT > 0 {
		e.TTFTMs = max(r.TTFT.Milliseconds(), 1)
	}
	if r.Failed {
		e.Failed = true
		e.Status = r.Failure.StatusCode
		e.Message = truncateRunes(strings.TrimSpace(r.Failure.Body), maxMessageRunes)
	}
	return e
}

// keyHint keeps the first and last four characters of a client key, or one of each
// for keys too short to hide anything that way.
func keyHint(key string) string {
	runes := []rune(strings.TrimSpace(key))
	switch {
	case len(runes) == 0:
		return ""
	case len(runes) <= 8:
		return string(runes[:1]) + "…" + string(runes[len(runes)-1:])
	default:
		return string(runes[:4]) + "…" + string(runes[len(runes)-4:])
	}
}

func truncateRunes(s string, limit int) string {
	runes := []rune(s)
	if len(runes) <= limit {
		return s
	}
	return string(runes[:limit])
}

func floorHour(unix int64) int64 {
	return unix - ((unix%hourSeconds)+hourSeconds)%hourSeconds
}

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "usage-stats: "+format+"\n", args...)
}
