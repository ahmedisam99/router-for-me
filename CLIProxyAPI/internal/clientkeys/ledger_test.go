package clientkeys

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

type fakeClock struct{ now time.Time }

func (c *fakeClock) Now() time.Time { return c.now }

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 10, 30, 12, 2, 30, 0, time.UTC)}
}

func TestLedgerWindows(t *testing.T) {
	clock := newFakeClock()
	l, errOpen := openLedger(t.TempDir(), clock.Now)
	if errOpen != nil {
		t.Fatalf("openLedger() error = %v", errOpen)
	}
	defer l.close()
	book := func(age time.Duration, usd float64) {
		l.add(spendEntry{Time: clock.now.Add(-age).UnixMilli(), Key: "k", Model: "m", USD: usd})
	}
	book(time.Minute, 1)      // every window
	book(4*time.Hour, 2)      // every window
	book(6*time.Hour, 4)      // day and up
	book(3*24*time.Hour, 8)   // week and up
	book(20*24*time.Hour, 16) // month
	book(40*24*time.Hour, 32) // none
	l.add(spendEntry{Time: clock.now.UnixMilli(), Key: "other", USD: 64})

	want := map[string]float64{"5h": 3, "day": 7, "week": 15, "month": 31}
	if got := l.spend("k"); !equalSpend(got, want) {
		t.Fatalf("spend() = %v, want %v", got, want)
	}

	clock.now = clock.now.Add(2 * time.Hour)
	want = map[string]float64{"5h": 1, "day": 7, "week": 15, "month": 31}
	if got := l.spend("k"); !equalSpend(got, want) {
		t.Fatalf("spend() two hours later = %v, want %v", got, want)
	}
	if got := l.spend("unknown"); !equalSpend(got, map[string]float64{"5h": 0, "day": 0, "week": 0, "month": 0}) {
		t.Fatalf("spend() of an unknown key = %v, want every window at 0", got)
	}
}

func TestLedgerReloadsRetainedDaysAndLastUse(t *testing.T) {
	clock := newFakeClock()
	dir := t.TempDir()
	expired := filepath.Join(dir, "2026-09-01"+spendSuffix)
	if errWrite := os.WriteFile(expired, []byte(`{"t":1,"key":"k","model":"m","usd":100}`+"\n"), 0o600); errWrite != nil {
		t.Fatalf("write expired file: %v", errWrite)
	}
	l, errOpen := openLedger(dir, clock.Now)
	if errOpen != nil {
		t.Fatalf("openLedger() error = %v", errOpen)
	}
	usedAt := clock.now.Add(-time.Hour)
	l.add(spendEntry{Time: usedAt.UnixMilli(), Key: "k", Model: "m", USD: 1.5})
	l.close()
	// A crash mid-write leaves a torn line; reloading skips it and the next write starts a new one.
	today := filepath.Join(dir, clock.now.Format(dayLayout)+spendSuffix)
	f, _ := os.OpenFile(today, os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = f.WriteString(`{"t":12`)
	_ = f.Close()

	reopened, errReopen := openLedger(dir, clock.Now)
	if errReopen != nil {
		t.Fatalf("openLedger() again error = %v", errReopen)
	}
	defer reopened.close()
	if _, errStat := os.Stat(expired); !os.IsNotExist(errStat) {
		t.Fatalf("expired day file kept: %v", errStat)
	}
	if got := reopened.spend("k")["month"]; got != 1.5 {
		t.Fatalf("reloaded month spend = %v, want 1.5", got)
	}
	if got, ok := reopened.lastUse("k"); !ok || !got.Equal(usedAt) {
		t.Fatalf("lastUse() = %v, %v; want %v", got, ok, usedAt)
	}
	reopened.add(spendEntry{Time: clock.now.UnixMilli(), Key: "k", Model: "m", USD: 1})
	reopened.close()
	again, _ := openLedger(dir, clock.Now)
	defer again.close()
	if got := again.spend("k")["month"]; got != 2.5 {
		t.Fatalf("month spend after the torn line = %v, want 2.5", got)
	}
}

func TestLedgerSkipsUnreadableLines(t *testing.T) {
	clock := newFakeClock()
	dir := t.TempDir()
	at := clock.now.Add(-time.Hour).UnixMilli()
	valid := func(usd string) string {
		return `{"t":` + strconv.FormatInt(at, 10) + `,"key":"k","model":"m","usd":` + usd + `}` + "\n"
	}
	huge := `{"t":1,"key":"k","model":"` + strings.Repeat("x", 200*1024) + `","usd":` + "\n"
	content := valid("1") + "not json\n" + huge + "\n" + `{"t":2}` + "\n" + valid("2")
	if errWrite := os.WriteFile(filepath.Join(dir, clock.now.Format(dayLayout)+spendSuffix), []byte(content), 0o600); errWrite != nil {
		t.Fatalf("write spend file: %v", errWrite)
	}
	l, errOpen := openLedger(dir, clock.Now)
	if errOpen != nil {
		t.Fatalf("openLedger() error = %v, want unreadable lines skipped", errOpen)
	}
	defer l.close()
	if got := l.spend("k")["5h"]; got != 3 {
		t.Fatalf("spend = %v, want 3 from the readable lines", got)
	}
}

func TestLedgerTouchRecordsUse(t *testing.T) {
	clock := newFakeClock()
	l, _ := openLedger(t.TempDir(), clock.Now)
	defer l.close()
	if _, ok := l.lastUse("k"); ok {
		t.Fatal("lastUse() reported a use before any")
	}
	l.touch("k")
	if got, ok := l.lastUse("k"); !ok || !got.Equal(clock.now) {
		t.Fatalf("lastUse() = %v, %v; want %v", got, ok, clock.now)
	}
}

func equalSpend(got, want map[string]float64) bool {
	if len(got) != len(want) {
		return false
	}
	for window, usd := range want {
		if diff := got[window] - usd; diff > 1e-9 || diff < -1e-9 {
			return false
		}
	}
	return true
}
