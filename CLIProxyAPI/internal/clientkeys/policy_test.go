package clientkeys

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestNormalizeProfilesDerivesIDs(t *testing.T) {
	block := []Rule{{Models: []string{"x"}, Action: "block"}}
	got, errNormalize := normalizeProfiles([]Profile{
		{Name: " Siblings ", Rules: block},
		{ID: "siblings-2", Name: "Explicit", Rules: block},
		{Name: "Siblings", Rules: block},
		{Name: "Siblings!", Rules: block},
		{Name: "¡¡¡", Rules: block},
		{ID: "kept", Name: "Kids & Teens 2", Rules: block},
		{Name: "Kids & Teens 2"},
	})
	if errNormalize != nil {
		t.Fatalf("normalizeProfiles() error = %v", errNormalize)
	}
	var ids []string
	for _, profile := range got {
		ids = append(ids, profile.ID)
	}
	want := []string{"siblings", "siblings-2", "siblings-3", "siblings-4", "profile", "kept", "kids-teens-2"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("ids = %v, want %v", ids, want)
	}
	if got[0].Name != "Siblings" {
		t.Fatalf("name = %q, want it trimmed", got[0].Name)
	}
}

func TestNormalizeProfilesRejectsInvalidInput(t *testing.T) {
	ok := Rule{Models: []string{"m"}, Action: ActionBlock}
	tests := []struct {
		name     string
		profiles []Profile
		want     string
	}{
		{"empty name", []Profile{{Name: "A", Rules: []Rule{ok}}, {Name: "  "}}, "profile 2: name is required"},
		{"duplicate id", []Profile{{ID: "a", Name: "A"}, {ID: "a", Name: "B"}}, `profile "B": id "a" is already used`},
		{"rule with no models", []Profile{{Name: "Kids", Rules: []Rule{ok, {Models: []string{" "}, Action: ActionBlock}}}}, `profile "Kids", rule 2: no models`},
		{"unknown effort", []Profile{{Name: "Kids", Rules: []Rule{{Models: []string{"m"}, Efforts: []string{"ultra"}, Action: ActionBlock}}}}, `profile "Kids", rule 1: unknown effort "ultra"`},
		{"unknown action", []Profile{{Name: "Kids", Rules: []Rule{{Models: []string{"m"}, Action: "allow"}}}}, `profile "Kids", rule 1: unknown action "allow"`},
		{"redirect to nothing", []Profile{{Name: "Kids", Rules: []Rule{{Models: []string{"m"}, Action: ActionRedirect}}}}, `profile "Kids", rule 1: redirect needs a model or an effort`},
		{"unknown redirect effort", []Profile{{Name: "Kids", Rules: []Rule{{Models: []string{"m"}, Action: ActionRedirect, RedirectEffort: "huge"}}}}, `profile "Kids", rule 1: unknown effort "huge"`},
		{"redirect model with suffix", []Profile{{Name: "Kids", Rules: []Rule{{Models: []string{"m"}, Action: ActionRedirect, RedirectModel: "m2(high)"}}}}, `profile "Kids", rule 1: redirect model "m2(high)" has an effort suffix`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, errNormalize := normalizeProfiles(tt.profiles)
			var invalid *InvalidError
			if !errors.As(errNormalize, &invalid) {
				t.Fatalf("error = %v, want an InvalidError", errNormalize)
			}
			if !strings.HasPrefix(errNormalize.Error(), tt.want) {
				t.Fatalf("error = %q, want %q", errNormalize.Error(), tt.want)
			}
		})
	}
}

func TestNormalizeRuleCleansFields(t *testing.T) {
	got, errRule := normalizeRule(Rule{
		Models:         []string{" claude-fable-5 ", "", "claude-fable-5"},
		Efforts:        []string{"XHigh", "max", "xhigh"},
		Action:         " Block ",
		RedirectModel:  "ignored",
		RedirectEffort: "ignored",
	})
	if errRule != nil {
		t.Fatalf("normalizeRule() error = %v", errRule)
	}
	want := Rule{Models: []string{"claude-fable-5"}, Efforts: []string{"xhigh", "max"}, Action: ActionBlock}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("normalizeRule() = %+v, want %+v", got, want)
	}
}

func TestApplyKeyUpdate(t *testing.T) {
	profiles := []Profile{{ID: "siblings", Name: "Siblings"}}
	current := defaultKeySettings()
	enabled, profile, warn := false, "siblings", "warn"
	got, errUpdate := applyKeyUpdate(current, KeyUpdate{
		Enabled:    &enabled,
		Profile:    &profile,
		Budgets:    map[string]float64{"5h": 5, "week": 0},
		OverBudget: &warn,
	}, profiles)
	if errUpdate != nil {
		t.Fatalf("applyKeyUpdate() error = %v", errUpdate)
	}
	want := KeySettings{Enabled: false, Profile: "siblings", Budgets: map[string]float64{"5h": 5, "week": 0}, OverBudget: OverBudgetWarn}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("applyKeyUpdate() = %+v, want %+v", got, want)
	}
	if kept, _ := applyKeyUpdate(got, KeyUpdate{}, profiles); !reflect.DeepEqual(kept, got) {
		t.Fatalf("empty update changed settings to %+v", kept)
	}

	unknownProfile, unknownOver := "nope", "ignore"
	for name, update := range map[string]KeyUpdate{
		"unknown profile":     {Profile: &unknownProfile},
		"unknown window":      {Budgets: map[string]float64{"year": 1}},
		"negative budget":     {Budgets: map[string]float64{"day": -1}},
		"unknown over budget": {OverBudget: &unknownOver},
	} {
		if _, errInvalid := applyKeyUpdate(current, update, profiles); errInvalid == nil {
			t.Errorf("%s: applyKeyUpdate() accepted %+v", name, update)
		}
	}
}

func TestPolicySaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, policyFileName)
	want := policy{
		Profiles: []Profile{{ID: "siblings", Name: "Siblings", Rules: []Rule{
			{Models: []string{"claude-fable-5"}, Action: ActionBlock},
			{Models: []string{"claude-opus-5-5"}, Efforts: []string{"xhigh", "max"}, Action: ActionRedirect, RedirectEffort: "high"},
		}}},
		Keys:   map[string]KeySettings{KeyID("sk-a"): {Enabled: false, Profile: "siblings", Budgets: map[string]float64{"5h": 5}, OverBudget: OverBudgetWarn}},
		Prices: map[string]Price{"gpt-6.1-sol": {Input: 1.25, Output: 10, CacheRead: 0.125}},
	}
	if errSave := savePolicy(path, want); errSave != nil {
		t.Fatalf("savePolicy() error = %v", errSave)
	}
	got, errLoad := loadPolicy(path)
	if errLoad != nil {
		t.Fatalf("loadPolicy() error = %v", errLoad)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("loadPolicy() = %+v, want %+v", got, want)
	}
	info, errStat := os.Stat(path)
	if errStat != nil {
		t.Fatalf("stat policy: %v", errStat)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("policy mode = %o, want 600", perm)
	}
	raw, _ := os.ReadFile(path)
	if strings.Contains(string(raw), "sk-a") {
		t.Fatalf("policy file stores the raw key:\n%s", raw)
	}
	assertNoJSONFiles(t, dir)
}

func TestLoadPolicyMissingFileIsEmpty(t *testing.T) {
	got, errLoad := loadPolicy(filepath.Join(t.TempDir(), policyFileName))
	if errLoad != nil || len(got.Profiles) != 0 || len(got.Keys) != 0 {
		t.Fatalf("loadPolicy() = %+v, %v; want empty", got, errLoad)
	}
}

func TestKeyID(t *testing.T) {
	const want = "2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b" // sha256("secret")
	if got := KeyID(" secret "); got != want {
		t.Fatalf("KeyID() = %q, want %q", got, want)
	}
}

// assertNoJSONFiles fails when anything under dir ends in .json: the backend would load it
// as a credential.
func assertNoJSONFiles(t *testing.T, dir string) {
	t.Helper()
	errWalk := filepath.WalkDir(dir, func(path string, entry os.DirEntry, errEntry error) error {
		if errEntry != nil {
			return errEntry
		}
		name := strings.ToLower(entry.Name())
		if strings.HasSuffix(name, ".json") {
			t.Errorf("wrote %s: *.json under the auth dir loads as a credential", path)
		}
		if strings.HasSuffix(name, ".tmp") {
			t.Errorf("left temp file %s behind", path)
		}
		return nil
	})
	if errWalk != nil {
		t.Fatalf("walk %s: %v", dir, errWalk)
	}
}
