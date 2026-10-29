package main

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

func fixedClock(t time.Time) func() time.Time {
	return func() time.Time { return t }
}

func TestRollupGroupsByHourAndDimensions(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 30, 0, 0, time.UTC)
	s, errOpen := openStore(t.TempDir(), 90, fixedClock(now))
	if errOpen != nil {
		t.Fatal(errOpen)
	}
	base := entry{Model: "m", Upstream: "u", Provider: "p", AuthIndex: "a1", AuthID: "id1", APIKey: "k"}
	first := base
	first.Time, first.Input, first.LatencyMs, first.TTFTMs = now.UnixMilli(), 10, 100, 40
	second := base
	second.Time, second.Input, second.LatencyMs, second.Failed, second.Status = now.Add(10*time.Minute).UnixMilli(), 5, 50, true, 429
	otherHour := base
	otherHour.Time = now.Add(-time.Hour).UnixMilli()
	otherAuth := base
	otherAuth.Time, otherAuth.AuthIndex = now.UnixMilli(), "a2"
	for _, e := range []entry{first, second, otherHour, otherAuth} {
		s.add(e)
	}

	got := s.query(now.Add(-2*time.Hour).Unix(), now.Add(time.Hour).Unix())
	if len(got.Rows) != 3 {
		t.Fatalf("rows = %d, want 3: %+v", len(got.Rows), got.Rows)
	}
	var merged row
	for _, r := range got.Rows {
		if r.AuthIndex == "a1" && r.Hour == floorHour(now.Unix()) {
			merged = r
		}
	}
	if merged.Requests != 2 || merged.Failed != 1 || merged.InputTokens != 15 || merged.LatencyMs != 150 ||
		merged.TTFTMs != 40 || merged.TTFTCount != 1 || merged.AuthID != "id1" {
		t.Fatalf("merged row = %+v", merged)
	}
	if got.Rows[0].Hour > got.Rows[len(got.Rows)-1].Hour {
		t.Fatalf("rows not sorted by hour: %+v", got.Rows)
	}
	if len(got.Failures) != 1 || got.Failures[0].Status != 429 || got.Failures[0].Time != "2026-10-20T12:40:00Z" {
		t.Fatalf("failures = %+v", got.Failures)
	}
}

func TestQueryRangeIncludesTheHourContainingFrom(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 30, 0, 0, time.UTC)
	s, _ := openStore(t.TempDir(), 90, fixedClock(now))
	s.add(entry{Time: now.UnixMilli(), Model: "m"})
	if rows := s.query(now.Add(10*time.Minute).Unix(), now.Add(time.Hour).Unix()).Rows; len(rows) != 1 {
		t.Fatalf("rows = %+v, want the 12:00 bucket", rows)
	}
	if rows := s.query(now.Add(time.Hour).Unix(), now.Add(2*time.Hour).Unix()).Rows; len(rows) != 0 {
		t.Fatalf("rows = %+v, want none", rows)
	}
	if fails := s.query(now.Add(-time.Hour).Unix(), now.Add(time.Hour).Unix()).Failures; fails == nil {
		t.Fatal("failures must encode as [], not null")
	}
}

func TestFailuresNewestFirstAndCapped(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	s, _ := openStore(t.TempDir(), 90, fixedClock(now))
	for i := range failureRingSize + 5 {
		s.add(entry{Time: now.Add(time.Duration(i) * time.Second).UnixMilli(), Model: "m", Failed: true, Status: 500})
	}
	if len(s.failures) != failureRingSize {
		t.Fatalf("ring = %d, want %d", len(s.failures), failureRingSize)
	}
	got := s.query(now.Unix(), now.Add(time.Hour).Unix()).Failures
	if len(got) != maxFailures {
		t.Fatalf("failures = %d, want %d", len(got), maxFailures)
	}
	if got[0].Time <= got[1].Time {
		t.Fatalf("failures not newest first: %s then %s", got[0].Time, got[1].Time)
	}
}

func TestReopenRestoresRollupAndDropsExpiredFiles(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	s, _ := openStore(dir, 7, fixedClock(now))
	s.add(entry{Time: now.UnixMilli(), Model: "m", Input: 3})
	s.close()

	expired := filepath.Join(dir, "2026-09-01"+fileSuffix)
	if errWrite := os.WriteFile(expired, []byte(`{"t":1,"model":"old"}`+"\n"), 0o600); errWrite != nil {
		t.Fatal(errWrite)
	}
	torn := filepath.Join(dir, "2026-10-19"+fileSuffix)
	line := `{"t":` + strconv.FormatInt(now.Add(-24*time.Hour).UnixMilli(), 10) + `,"model":"m","in":2}` + "\n" + `{"t":17`
	if errWrite := os.WriteFile(torn, []byte(line), 0o600); errWrite != nil {
		t.Fatal(errWrite)
	}

	reopened, errOpen := openStore(dir, 7, fixedClock(now))
	if errOpen != nil {
		t.Fatal(errOpen)
	}
	if _, errStat := os.Stat(expired); !os.IsNotExist(errStat) {
		t.Fatalf("expired file still present: %v", errStat)
	}
	rows := reopened.query(now.Add(-48*time.Hour).Unix(), now.Add(time.Hour).Unix()).Rows
	var input int64
	for _, r := range rows {
		input += r.InputTokens
	}
	if len(rows) != 2 || input != 5 {
		t.Fatalf("rows after reopen = %+v", rows)
	}
}

func TestAppendAfterTornLineKeepsTheNewEntry(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	today := filepath.Join(dir, now.Format(dayLayout)+fileSuffix)
	if errWrite := os.WriteFile(today, []byte(`{"t":17`), 0o600); errWrite != nil {
		t.Fatal(errWrite)
	}
	s, _ := openStore(dir, 7, fixedClock(now))
	s.add(entry{Time: now.UnixMilli(), Model: "m", Input: 3})
	s.close()

	reopened, errOpen := openStore(dir, 7, fixedClock(now))
	if errOpen != nil {
		t.Fatal(errOpen)
	}
	rows := reopened.query(now.Unix(), now.Add(time.Hour).Unix()).Rows
	if len(rows) != 1 || rows[0].InputTokens != 3 {
		t.Fatalf("rows after a torn line = %+v", rows)
	}
}

func TestDayRolloverPrunesExpiredRows(t *testing.T) {
	dir := t.TempDir()
	clock := time.Date(2026, 10, 20, 23, 0, 0, 0, time.UTC)
	s, _ := openStore(dir, 1, func() time.Time { return clock })
	s.add(entry{Time: clock.Add(-48 * time.Hour).UnixMilli(), Model: "old"})
	clock = clock.Add(2 * time.Hour)
	s.add(entry{Time: clock.UnixMilli(), Model: "new"})
	rows := s.query(0, clock.Add(time.Hour).Unix()).Rows
	if len(rows) != 1 || rows[0].Model != "new" {
		t.Fatalf("rows = %+v, want only the new one", rows)
	}
	if _, errStat := os.Stat(filepath.Join(dir, "2026-10-20"+fileSuffix)); errStat != nil {
		t.Fatalf("yesterday's file within retention was removed: %v", errStat)
	}
}

func TestEntryFromRecordMapsModelsCacheAndKeyHint(t *testing.T) {
	at := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	e := entryFromRecord(pluginapi.UsageRecord{
		Model:       "gpt-6.1-sol",
		Alias:       "claude-opus-5-5",
		Provider:    "codex",
		APIKey:      "sk-abcdefghijwxyz",
		RequestedAt: at,
		Stream:      true,
		Latency:     1500 * time.Millisecond,
		TTFT:        300 * time.Microsecond,
		Failed:      true,
		Failure:     pluginapi.UsageFailure{StatusCode: 429, Body: string(make([]rune, 400))},
		Detail:      pluginapi.UsageDetail{CachedTokens: 7, CacheCreationTokens: 7},
	}, time.Time{})
	if e.Model != "claude-opus-5-5" || e.Upstream != "gpt-6.1-sol" {
		t.Fatalf("models = %q/%q", e.Model, e.Upstream)
	}
	if e.APIKey != "sk-a…wxyz" {
		t.Fatalf("key hint = %q", e.APIKey)
	}
	if e.Cached != 0 {
		t.Fatalf("cache creation counted as cached: %d", e.Cached)
	}
	if e.TTFTMs != 1 || e.LatencyMs != 1500 || e.Time != at.UnixMilli() {
		t.Fatalf("timing = %+v", e)
	}
	if len([]rune(e.Message)) != maxMessageRunes || e.Status != 429 {
		t.Fatalf("failure = %d runes, status %d", len([]rune(e.Message)), e.Status)
	}

	plain := entryFromRecord(pluginapi.UsageRecord{Model: "m", TTFT: time.Second, Detail: pluginapi.UsageDetail{CachedTokens: 4}}, at)
	if plain.Model != "m" || plain.Cached != 4 || plain.Time != at.UnixMilli() || plain.APIKey != "" || plain.TTFTMs != 0 {
		t.Fatalf("plain = %+v", plain)
	}
	if hint := keyHint("short"); hint != "s…t" {
		t.Fatalf("short key hint = %q", hint)
	}
}

func TestFloorHourHandlesNegativeTimes(t *testing.T) {
	if got := floorHour(-1); got != -3600 {
		t.Fatalf("floorHour(-1) = %d", got)
	}
	if got := floorHour(7201); got != 7200 {
		t.Fatalf("floorHour(7201) = %d", got)
	}
}
