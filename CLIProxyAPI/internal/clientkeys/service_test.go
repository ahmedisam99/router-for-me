package clientkeys

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	coreusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

var testKeys = []string{"sk-sib", "sk-owner"}

var siblingsProfile = Profile{Name: "Siblings", Rules: []Rule{
	{Models: []string{"claude-fable-5", "claude-fable-5-1"}, Action: ActionBlock},
	{Models: []string{"claude-opus-5-5"}, Efforts: []string{"xhigh", "max"}, Action: ActionRedirect, RedirectEffort: "high"},
	{Models: []string{"old-model"}, Action: ActionRedirect, RedirectModel: "new-model"},
}}

type testService struct {
	*Service
	clock   *fakeClock
	fetches atomic.Int32
	fetch   func() ([]byte, error)
}

func openTestService(t *testing.T, dir string) *testService {
	t.Helper()
	ts := &testService{clock: newFakeClock()}
	ts.fetch = func() ([]byte, error) { return nil, errors.New("offline") }
	s, errOpen := Open(dir, Options{Now: ts.clock.Now, Fetch: func(context.Context, string) ([]byte, error) {
		ts.fetches.Add(1)
		return ts.fetch()
	}})
	if errOpen != nil {
		t.Fatalf("Open() error = %v", errOpen)
	}
	t.Cleanup(s.Close)
	ts.Service = s
	return ts
}

// useAsDefault makes s the process-wide service for the test.
func useAsDefault(t *testing.T, s *Service) {
	t.Helper()
	SetDefault(s)
	t.Cleanup(func() { SetDefault(nil) })
}

func strPtr(s string) *string { return &s }
func boolPtr(b bool) *bool    { return &b }

func setUpSiblings(t *testing.T, s *Service) {
	t.Helper()
	if _, errProfiles := s.ReplaceProfiles([]Profile{siblingsProfile}); errProfiles != nil {
		t.Fatalf("ReplaceProfiles() error = %v", errProfiles)
	}
	if _, errUpdate := s.UpdateKey(testKeys, KeyID("sk-sib"), KeyUpdate{Profile: strPtr("siblings")}); errUpdate != nil {
		t.Fatalf("UpdateKey() error = %v", errUpdate)
	}
}

func TestRouteAppliesProfileRules(t *testing.T) {
	ts := openTestService(t, t.TempDir())
	setUpSiblings(t, ts.Service)
	useAsDefault(t, ts.Service)
	upstreams := func(model string) []string {
		if model == "fable-alias" {
			return []string{"claude-fable-5"}
		}
		return nil
	}
	tests := []struct {
		name, key, model, body string
		format                 string
		want                   string
		wantStatus             int
		wantMessage            string
	}{
		{name: "blocked model", key: "sk-sib", model: "claude-fable-5", wantStatus: http.StatusForbidden, wantMessage: "Model claude-fable-5 is not allowed for this API key"},
		{name: "blocked model with suffix", key: "sk-sib", model: "claude-fable-5-1(high)", wantStatus: http.StatusForbidden, wantMessage: "Model claude-fable-5-1 is not allowed for this API key"},
		{name: "blocked through upstream", key: "sk-sib", model: "fable-alias", wantStatus: http.StatusForbidden, wantMessage: "Model fable-alias is not allowed for this API key"},
		{name: "body effort redirected", key: "sk-sib", model: "claude-opus-5-5", body: `{"reasoning_effort":"xhigh"}`, want: "claude-opus-5-5(high)"},
		{name: "suffix effort redirected", key: "sk-sib", model: "claude-opus-5-5(max)", want: "claude-opus-5-5(high)"},
		{name: "suffix with a leading space", key: "sk-sib", model: "claude-opus-5-5( max)", want: "claude-opus-5-5(high)"},
		{name: "suffix with a trailing space", key: "sk-sib", model: "claude-opus-5-5(MAX )", want: "claude-opus-5-5(high)"},
		{name: "blocked advisor model", key: "sk-sib", model: "claude-opus-5-5", format: "claude",
			body:       `{"tools":[{"type":"web_search_20250305","name":"web_search"},{"type":"advisor_20260301","name":"advisor","model":"claude-fable-5"}]}`,
			wantStatus: http.StatusForbidden, wantMessage: "Model claude-fable-5 is not allowed for this API key"},
		{name: "blocked fallback through upstream", key: "sk-sib", model: "claude-opus-5-5", format: "claude",
			body:       `{"fallbacks":[{"model":"claude-opus-4-8"},{"model":"fable-alias(high)"}]}`,
			wantStatus: http.StatusForbidden, wantMessage: "Model fable-alias is not allowed for this API key"},
		{name: "nested block wins over a redirect", key: "sk-sib", model: "claude-opus-5-5(max)", format: "claude",
			body:       `{"fallbacks":[{"model":"claude-fable-5-1"}]}`,
			wantStatus: http.StatusForbidden, wantMessage: "Model claude-fable-5-1 is not allowed for this API key"},
		{name: "nested models are not redirected", key: "sk-sib", model: "claude-sonnet-5", format: "claude",
			body: `{"output_config":{"effort":"max"},"tools":[{"type":"advisor_20260301","model":"claude-opus-5-5"}]}`, want: "claude-sonnet-5"},
		{name: "nested models only in claude bodies", key: "sk-sib", model: "claude-opus-5-5",
			body: `{"tools":[{"model":"claude-fable-5"}]}`, want: "claude-opus-5-5"},
		{name: "allowed effort passes", key: "sk-sib", model: "claude-opus-5-5", body: `{"reasoning_effort":"medium"}`, want: "claude-opus-5-5"},
		{name: "unstated effort passes", key: "sk-sib", model: "claude-opus-5-5", want: "claude-opus-5-5"},
		{name: "model redirect keeps suffix", key: "sk-sib", model: "old-model(low)", want: "new-model(low)"},
		{name: "key without profile", key: "sk-owner", model: "claude-fable-5", want: "claude-fable-5"},
		{name: "no key", key: "", model: "claude-fable-5", want: "claude-fable-5"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			format := tt.format
			if format == "" {
				format = "openai"
			}
			got, _, rejection := Route(tt.key, tt.model, format, []byte(tt.body), upstreams)
			if tt.wantStatus != 0 {
				if rejection == nil || rejection.Status != tt.wantStatus || rejection.Message != tt.wantMessage {
					t.Fatalf("Route() rejection = %+v, want %d %q", rejection, tt.wantStatus, tt.wantMessage)
				}
				return
			}
			if rejection != nil || got != tt.want {
				t.Fatalf("Route() = %q, %+v; want %q", got, rejection, tt.want)
			}
		})
	}

	SetDefault(nil)
	if got, _, rejection := Route("sk-sib", "claude-fable-5", "openai", nil, nil); rejection != nil || got != "claude-fable-5" {
		t.Fatalf("Route() without a service = %q, %+v; want a pass", got, rejection)
	}
	if Admit("sk-sib") != nil {
		t.Fatal("Admit() without a service rejected")
	}
}

func TestEffortRedirectStripsConfigurationUpdates(t *testing.T) {
	ts := openTestService(t, t.TempDir())
	setUpSiblings(t, ts.Service)
	useAsDefault(t, ts.Service)
	body := `{"model":"claude-opus-5-5","input":[{"type":"configuration_update","reasoning":{"effort":"xhigh"}},{"type":"message","role":"user","content":"hi"}]}`
	model, routed, rejection := Route("sk-sib", "claude-opus-5-5", "openai-response", []byte(body), nil)
	if rejection != nil || model != "claude-opus-5-5(high)" {
		t.Fatalf("Route() = %q, %+v; want claude-opus-5-5(high)", model, rejection)
	}
	if want := `{"model":"claude-opus-5-5","input":[{"type":"message","role":"user","content":"hi"}]}`; string(routed) != want {
		t.Fatalf("routed body = %s, want %s", routed, want)
	}
	modelOnly := `{"input":[{"type":"configuration_update","reasoning":{"effort":"low"}}]}`
	if _, routed, _ := Route("sk-sib", "old-model", "openai-response", []byte(modelOnly), nil); string(routed) != modelOnly {
		t.Fatalf("model-only redirect changed the body to %s", routed)
	}
}

func TestRejectTurn(t *testing.T) {
	ts := openTestService(t, t.TempDir())
	setUpSiblings(t, ts.Service)
	useAsDefault(t, ts.Service)
	const format = "openai-response"
	redirected := []byte(`{"model":"claude-opus-5-5","reasoning":{"effort":"xhigh"}}`)
	medium := []byte(`{"model":"claude-opus-5-5","reasoning":{"effort":"medium"}}`)
	tests := []struct {
		name                string
		sessionBody, turn   string
		turnModel           string
		wantStatus          int
		wantMessageContains string
	}{
		{name: "same redirect as the session", sessionBody: string(redirected), turn: `{"reasoning":{"effort":"max"}}`},
		{name: "turn needing no redirect", sessionBody: string(medium), turn: `{"reasoning":{"effort":"low"}}`},
		{name: "redirect the session lacks", sessionBody: string(medium), turn: `{"reasoning":{"effort":"xhigh"}}`,
			wantStatus: http.StatusForbidden, wantMessageContains: "start a new request"},
		{name: "configuration update could override the session", sessionBody: string(redirected),
			turn:       `{"input":[{"type":"configuration_update","reasoning":{"effort":"xhigh"}}]}`,
			wantStatus: http.StatusForbidden, wantMessageContains: "start a new request"},
		{name: "blocked model", sessionBody: string(medium), turnModel: "claude-fable-5", turn: `{}`,
			wantStatus: http.StatusForbidden, wantMessageContains: "claude-fable-5 is not allowed"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			turnModel := tt.turnModel
			if turnModel == "" {
				turnModel = "claude-opus-5-5"
			}
			rejection := RejectTurn("sk-sib", format, "claude-opus-5-5", []byte(tt.sessionBody), turnModel, []byte(tt.turn), nil)
			if tt.wantStatus == 0 {
				if rejection != nil {
					t.Fatalf("RejectTurn() = %+v, want a pass", rejection)
				}
				return
			}
			if rejection == nil || rejection.Status != tt.wantStatus || !strings.Contains(rejection.Message, tt.wantMessageContains) {
				t.Fatalf("RejectTurn() = %+v, want %d containing %q", rejection, tt.wantStatus, tt.wantMessageContains)
			}
		})
	}
}

func TestLoadFailsClosedOnUnreadablePolicy(t *testing.T) {
	t.Cleanup(func() { SetDefault(nil) })
	dir := t.TempDir()
	path := dir + "/" + policyFileName
	if errWrite := os.WriteFile(path, []byte("profiles: [unclosed\n"), 0o600); errWrite != nil {
		t.Fatalf("write policy: %v", errWrite)
	}
	if s := Load(dir, Options{}); s != nil {
		t.Fatal("Load() opened an unreadable policy")
	}
	if !Enforced() {
		t.Fatal("Enforced() = false with a policy that failed to load")
	}
	authErr := Admit("sk-any")
	if authErr == nil || authErr.HTTPStatusCode() != http.StatusServiceUnavailable || !strings.Contains(authErr.Message, path) {
		t.Fatalf("Admit() = %+v, want 503 naming %s", authErr, path)
	}
	if _, _, rejection := Route("sk-any", "m", "openai", nil, nil); rejection == nil || rejection.Status != http.StatusServiceUnavailable {
		t.Fatalf("Route() = %+v, want 503", rejection)
	}
	if rejection := RejectTurn("sk-any", "openai-response", "m", nil, "m", nil, nil); rejection == nil || rejection.Status != http.StatusServiceUnavailable {
		t.Fatalf("RejectTurn() = %+v, want 503", rejection)
	}
	if _, errUnavailable := Current(); errUnavailable == nil || !strings.Contains(errUnavailable.Error(), "parse") {
		t.Fatalf("Current() error = %v, want the parse error", errUnavailable)
	}

	fresh := t.TempDir() + "/client-keys"
	s := Load(fresh, Options{})
	if s == nil {
		t.Fatal("Load() of a new dir failed")
	}
	defer s.Close()
	if current, errUnavailable := Current(); current != s || errUnavailable != nil {
		t.Fatalf("Current() = %p, %v; want the loaded service", current, errUnavailable)
	}
	if Admit("sk-any") != nil {
		t.Fatal("Admit() rejected with a freshly loaded service")
	}
}

func TestSwitchedOffKey(t *testing.T) {
	ts := openTestService(t, t.TempDir())
	useAsDefault(t, ts.Service)
	if _, errUpdate := ts.UpdateKey(testKeys, KeyID("sk-sib"), KeyUpdate{Enabled: boolPtr(false)}); errUpdate != nil {
		t.Fatalf("UpdateKey() error = %v", errUpdate)
	}
	authErr := Admit("sk-sib")
	if authErr == nil || authErr.HTTPStatusCode() != http.StatusForbidden || authErr.Message != "This API key is switched off" {
		t.Fatalf("Admit() = %+v, want 403 switched off", authErr)
	}
	if _, _, rejection := Route("sk-sib", "any", "openai", nil, nil); rejection == nil || rejection.Status != http.StatusForbidden {
		t.Fatalf("Route() rejection = %+v, want 403", rejection)
	}
	if Admit("sk-owner") != nil {
		t.Fatal("Admit() rejected a key with no policy")
	}
	if _, used := ts.ledger.lastUse(KeyID("sk-sib")); used {
		t.Fatal("a rejected request counted as a use")
	}
	if _, used := ts.ledger.lastUse(KeyID("sk-owner")); !used {
		t.Fatal("an admitted request did not count as a use")
	}
}

// priceRecord books $usd to key through a $1 per 1M input token override.
func priceRecord(key string, usd float64, at time.Time) coreusage.Record {
	return coreusage.Record{
		APIKey:      key,
		Provider:    "claude",
		Model:       "test-model",
		RequestedAt: at,
		Detail:      coreusage.Detail{TokenBreakdown: coreusage.NewIndependentTokenBreakdown(int64(usd*1e6), 0, 0, 0, 0, 0)},
	}
}

func TestBudgets(t *testing.T) {
	ts := openTestService(t, t.TempDir())
	useAsDefault(t, ts.Service)
	if errOverride := ts.SetPriceOverride("test-model", &Price{Input: 1}); errOverride != nil {
		t.Fatalf("SetPriceOverride() error = %v", errOverride)
	}
	id := KeyID("sk-sib")
	if _, errUpdate := ts.UpdateKey(testKeys, id, KeyUpdate{Budgets: map[string]float64{"5h": 5, "day": 5, "week": 30}}); errUpdate != nil {
		t.Fatalf("UpdateKey() error = %v", errUpdate)
	}
	ts.HandleUsage(context.Background(), priceRecord("sk-sib", 4, ts.clock.now.Add(-time.Hour)))
	if authErr := Admit("sk-sib"); authErr != nil {
		t.Fatalf("Admit() under budget = %+v", authErr)
	}
	failed := priceRecord("sk-sib", 1, ts.clock.now)
	failed.Failed = true
	ts.HandleUsage(context.Background(), failed)

	authErr := Admit("sk-sib")
	wantMessage := "This API key's budget is used up: $5.00 of $5.00 in the last 5 hours"
	if authErr == nil || authErr.HTTPStatusCode() != http.StatusTooManyRequests || authErr.Message != wantMessage {
		t.Fatalf("Admit() = %+v, want 429 %q", authErr, wantMessage)
	}
	if _, _, rejection := Route("sk-sib", "m", "openai", nil, nil); rejection == nil || rejection.Message != wantMessage {
		t.Fatalf("Route() rejection = %+v, want the budget rejection", rejection)
	}

	view := ts.Overview(testKeys).Keys[0]
	if !reflect.DeepEqual(view.Exceeded, []string{"5h", "day"}) {
		t.Fatalf("exceeded = %v, want [5h day]", view.Exceeded)
	}

	if _, errUpdate := ts.UpdateKey(testKeys, id, KeyUpdate{OverBudget: strPtr(OverBudgetWarn)}); errUpdate != nil {
		t.Fatalf("UpdateKey() error = %v", errUpdate)
	}
	if authErr := Admit("sk-sib"); authErr != nil {
		t.Fatalf("Admit() with warn = %+v, want a pass", authErr)
	}
	if got := ts.Overview(testKeys).Keys[0].Exceeded; len(got) != 2 {
		t.Fatalf("exceeded with warn = %v, want the key still flagged", got)
	}

	if _, errUpdate := ts.UpdateKey(testKeys, id, KeyUpdate{OverBudget: strPtr(OverBudgetBlock)}); errUpdate != nil {
		t.Fatalf("UpdateKey() error = %v", errUpdate)
	}
	ts.clock.now = ts.clock.now.Add(25 * time.Hour)
	if authErr := Admit("sk-sib"); authErr != nil {
		t.Fatalf("Admit() once the windows rolled = %+v, want a pass", authErr)
	}
}

func TestHandleUsageBooksSpendAndLastUse(t *testing.T) {
	dir := t.TempDir()
	ts := openTestService(t, dir)
	if errOverride := ts.SetPriceOverride("claude-opus-5-5", &Price{Input: 4, Output: 20, CacheRead: 0.4, CacheWrite: 5}); errOverride != nil {
		t.Fatalf("SetPriceOverride() error = %v", errOverride)
	}
	usedAt := ts.clock.now.Add(-10 * time.Minute)
	// A legacy detail without a breakdown is classified by provider: Claude buckets are independent.
	ts.HandleUsage(context.Background(), coreusage.Record{
		APIKey: "sk-sib", Provider: "claude", Model: "claude-opus-5-5", Alias: "claude-opus-5-5(high)", RequestedAt: usedAt,
		Detail: coreusage.Detail{InputTokens: 1000, OutputTokens: 500, CacheReadTokens: 10000, CacheCreationTokens: 2000},
	})
	ts.HandleUsage(context.Background(), coreusage.Record{APIKey: "sk-owner", Provider: "claude", Model: "unpriced", RequestedAt: usedAt})
	ts.HandleUsage(context.Background(), coreusage.Record{Provider: "claude", Model: "claude-opus-5-5", Detail: coreusage.Detail{InputTokens: 1e6}})

	want := 1000*4e-6 + 500*20e-6 + 10000*0.4e-6 + 2000*5e-6
	overview := ts.Overview(testKeys)
	sib, owner := overview.Keys[0], overview.Keys[1]
	if diff := sib.Spend["5h"] - want; diff > 1e-9 || diff < -1e-9 {
		t.Fatalf("spend = %v, want %v in every window", sib.Spend, want)
	}
	if sib.LastUsed == nil || !sib.LastUsed.Equal(usedAt) {
		t.Fatalf("last used = %v, want %v", sib.LastUsed, usedAt)
	}
	if owner.Spend["month"] != 0 || owner.LastUsed == nil {
		t.Fatalf("unpriced use = %+v, want $0 and a last use", owner)
	}

	ts.Close()
	reopened := openTestService(t, dir)
	again := reopened.Overview(testKeys).Keys[0]
	if again.Spend["month"] != sib.Spend["month"] || again.LastUsed == nil || !again.LastUsed.Equal(usedAt) {
		t.Fatalf("after restart = %+v, want spend and last use restored", again)
	}
	assertNoJSONFiles(t, dir)
}

func TestOverviewDefaultsAndJSONShape(t *testing.T) {
	ts := openTestService(t, t.TempDir())
	setUpSiblings(t, ts.Service)
	overview := ts.Overview([]string{"sk-owner", " sk-new ", "", "sk-owner"})
	if len(overview.Keys) != 2 || overview.Keys[0].Key != "sk-owner" || overview.Keys[1].Key != "sk-new" {
		t.Fatalf("keys = %+v, want sk-owner then sk-new", overview.Keys)
	}
	data, errMarshal := json.Marshal(overview)
	if errMarshal != nil {
		t.Fatalf("marshal: %v", errMarshal)
	}
	var decoded map[string]any
	_ = json.Unmarshal(data, &decoded)
	key := decoded["keys"].([]any)[1].(map[string]any)
	wantKey := map[string]any{
		"id":          KeyID("sk-new"),
		"key":         "sk-new",
		"enabled":     true,
		"profile":     "",
		"budgets":     map[string]any{},
		"over_budget": "block",
		"spend":       map[string]any{"5h": 0.0, "day": 0.0, "week": 0.0, "month": 0.0},
		"exceeded":    []any{},
		"last_used":   nil,
	}
	if !reflect.DeepEqual(key, wantKey) {
		t.Fatalf("key JSON = %v, want %v", key, wantKey)
	}
	if !reflect.DeepEqual(decoded["windows"], []any{"5h", "day", "week", "month"}) {
		t.Fatalf("windows = %v", decoded["windows"])
	}
	rule := decoded["profiles"].([]any)[0].(map[string]any)["rules"].([]any)[0].(map[string]any)
	wantRule := map[string]any{"models": []any{"claude-fable-5", "claude-fable-5-1"}, "efforts": []any{}, "action": "block", "redirect_model": "", "redirect_effort": ""}
	if !reflect.DeepEqual(rule, wantRule) {
		t.Fatalf("rule JSON = %v, want %v", rule, wantRule)
	}
}

func TestUpdateKeyErrors(t *testing.T) {
	ts := openTestService(t, t.TempDir())
	if _, errUpdate := ts.UpdateKey(testKeys, KeyID("sk-gone"), KeyUpdate{}); !errors.Is(errUpdate, ErrKeyNotFound) {
		t.Fatalf("UpdateKey(unknown id) error = %v, want ErrKeyNotFound", errUpdate)
	}
	for name, update := range map[string]KeyUpdate{
		"unknown profile":     {Profile: strPtr("nope")},
		"unknown window":      {Budgets: map[string]float64{"year": 1}},
		"negative budget":     {Budgets: map[string]float64{"day": -1}},
		"unknown over_budget": {OverBudget: strPtr("ignore")},
	} {
		var invalid *InvalidError
		if _, errUpdate := ts.UpdateKey(testKeys, KeyID("sk-sib"), update); !errors.As(errUpdate, &invalid) {
			t.Errorf("%s: error = %v, want InvalidError", name, errUpdate)
		}
	}
}

func TestSavesKeepSettingsOfKeysAbsentFromConfig(t *testing.T) {
	dir := t.TempDir()
	ts := openTestService(t, dir)
	setUpSiblings(t, ts.Service)
	if _, errUpdate := ts.UpdateKey(testKeys, KeyID("sk-owner"), KeyUpdate{Enabled: boolPtr(false)}); errUpdate != nil {
		t.Fatalf("UpdateKey() error = %v", errUpdate)
	}

	// sk-owner leaves config; a key save and a profile save both keep its settings.
	remaining := []string{"sk-sib"}
	if _, errUpdate := ts.UpdateKey(remaining, KeyID("sk-sib"), KeyUpdate{Budgets: map[string]float64{"day": 5}}); errUpdate != nil {
		t.Fatalf("UpdateKey() error = %v", errUpdate)
	}
	if _, errProfiles := ts.ReplaceProfiles([]Profile{{ID: "kids", Name: "Kids"}}); errProfiles != nil {
		t.Fatalf("ReplaceProfiles() error = %v", errProfiles)
	}
	if got := ts.Overview(remaining).Keys; len(got) != 1 || got[0].Key != "sk-sib" {
		t.Fatalf("overview keys = %+v, want only the keys in config", got)
	}
	stored, errLoad := loadPolicy(dir + "/" + policyFileName)
	if errLoad != nil {
		t.Fatalf("loadPolicy() error = %v", errLoad)
	}
	if got, ok := stored.Keys[KeyID("sk-owner")]; !ok || got.Enabled {
		t.Fatalf("stored sk-owner = %+v, %v; want its switched-off settings kept", got, ok)
	}
	if got := stored.Keys[KeyID("sk-sib")]; got.Profile != "" || got.Budgets["day"] != 5 {
		t.Fatalf("stored sk-sib = %+v, want its budget and no profile once siblings is gone", got)
	}

	// The same key back in config gets its settings back.
	if view := ts.Overview(testKeys).Keys[1]; view.Key != "sk-owner" || view.Enabled {
		t.Fatalf("returning key = %+v, want it still switched off", view)
	}
	assertNoJSONFiles(t, dir)
}

func TestPrices(t *testing.T) {
	dir := t.TempDir()
	ts := openTestService(t, dir)
	// claude-opus-5-5 stands for a Codex alias of gpt-6.1-sol: each row keeps its own price.
	served := map[string][]string{
		"claude-opus-5-5":  {"codex"},
		"gpt-6.1-sol":      {"codex"},
		"Mixed/Case-Model": {"openai-compatibility:x"},
		"gemini-3-pro":     {"gemini-cli"},
		"unknown-model":    {"claude"},
		"plain":            nil,
	}
	before := ts.Prices(served)
	if before.Source.FetchedAt != nil || before.Source.Error == "" || len(before.Unpriced) != 6 {
		t.Fatalf("prices before a download = %+v, want no fetch time, an error and every model unpriced", before)
	}

	ts.fetch = func() ([]byte, error) { return []byte(litellmFixture), nil }
	if errRefresh := ts.RefreshPrices(context.Background()); errRefresh != nil {
		t.Fatalf("RefreshPrices() error = %v", errRefresh)
	}
	if errOverride := ts.SetPriceOverride("Plain(high)", &Price{Input: 1, Output: 2}); errOverride != nil {
		t.Fatalf("SetPriceOverride() error = %v", errOverride)
	}
	if errOverride := ts.SetPriceOverride("only-override", &Price{Input: 3}); errOverride != nil {
		t.Fatalf("SetPriceOverride() error = %v", errOverride)
	}

	view := ts.Prices(served)
	if view.Source.FetchedAt == nil || !view.Source.FetchedAt.Equal(ts.clock.now) || view.Source.Error != "" || view.Source.Name != "LiteLLM" {
		t.Fatalf("source = %+v, want a fresh download", view.Source)
	}
	want := []PriceRow{
		{Model: "claude-opus-5-5", Imported: &Price{Input: 4, Output: 20, CacheRead: 0.2, CacheWrite: 5}},
		{Model: "gemini-3-pro", Imported: &Price{Input: 2, Output: 12, CacheRead: 0.2}},
		{Model: "gpt-6.1-sol", Imported: &Price{Input: 2, Output: 10, CacheRead: 0.2}},
		{Model: "mixed/case-model", Imported: &Price{Input: 1, Output: 2}},
		{Model: "only-override", Override: &Price{Input: 3}},
		{Model: "plain", Override: &Price{Input: 1, Output: 2}},
		{Model: "unknown-model"},
	}
	if !reflect.DeepEqual(view.Prices, want) {
		t.Fatalf("prices = %+v, want %+v", view.Prices, want)
	}
	if !reflect.DeepEqual(view.Unpriced, []string{"unknown-model"}) {
		t.Fatalf("unpriced = %v, want [unknown-model]", view.Unpriced)
	}

	if errRemove := ts.SetPriceOverride("plain", nil); errRemove != nil {
		t.Fatalf("SetPriceOverride(nil) error = %v", errRemove)
	}
	var invalid *InvalidError
	if errEmpty := ts.SetPriceOverride(" ", &Price{}); !errors.As(errEmpty, &invalid) {
		t.Fatalf("SetPriceOverride(empty) error = %v, want InvalidError", errEmpty)
	}
	if errNegative := ts.SetPriceOverride("x", &Price{Output: -1}); !errors.As(errNegative, &invalid) {
		t.Fatalf("SetPriceOverride(negative) error = %v, want InvalidError", errNegative)
	}

	ts.fetch = func() ([]byte, error) { return nil, errors.New("offline") }
	if errRefresh := ts.RefreshPrices(context.Background()); errRefresh == nil {
		t.Fatal("RefreshPrices() succeeded while offline")
	}
	failed := ts.Prices(served)
	if !strings.Contains(failed.Source.Error, "offline") || failed.Source.FetchedAt == nil || failed.Prices[0].Imported == nil {
		t.Fatalf("prices after a failed refresh = %+v, want the error and the previous list", failed)
	}
	if got := failed.Unpriced; !reflect.DeepEqual(got, []string{"plain", "unknown-model"}) {
		t.Fatalf("unpriced = %v, want plain back once its override is gone", got)
	}

	ts.Close()
	reopened := openTestService(t, dir)
	if got := reopened.Prices(served); got.Source.FetchedAt == nil || got.Prices[0].Imported == nil {
		t.Fatalf("prices after restart = %+v, want the cached list", got)
	}
	assertNoJSONFiles(t, dir)
}

func TestKeepPricesFreshDownloadsOnlyWhenStale(t *testing.T) {
	dir := t.TempDir()
	ts := openTestService(t, dir)
	ts.fetch = func() ([]byte, error) { return []byte(litellmFixture), nil }
	done, cancel := context.WithCancel(context.Background())
	cancel() // one staleness check, then return

	ts.keepPricesFresh(done)
	if got := ts.fetches.Load(); got != 1 {
		t.Fatalf("downloads with no list = %d, want 1", got)
	}
	ts.clock.now = ts.clock.now.Add(6 * 24 * time.Hour)
	ts.keepPricesFresh(done)
	if got := ts.fetches.Load(); got != 1 {
		t.Fatalf("downloads with a 6 day old list = %d, want still 1", got)
	}
	ts.clock.now = ts.clock.now.Add(2 * 24 * time.Hour)
	ts.keepPricesFresh(done)
	if got := ts.fetches.Load(); got != 2 {
		t.Fatalf("downloads with an 8 day old list = %d, want 2", got)
	}
}
