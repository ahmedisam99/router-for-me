package clientkeys

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/thinking"
	log "github.com/sirupsen/logrus"
	"gopkg.in/yaml.v3"
)

const (
	OverBudgetBlock = "block"
	OverBudgetWarn  = "warn"
	ActionBlock     = "block"
	ActionRedirect  = "redirect"

	policyFileName = "policy.yaml"
)

// Windows lists the rolling spend windows, smallest first.
var Windows = []string{"5h", "day", "week", "month"}

var windowSpans = map[string]time.Duration{
	"5h":    5 * time.Hour,
	"day":   24 * time.Hour,
	"week":  7 * 24 * time.Hour,
	"month": 30 * 24 * time.Hour,
}

var windowLabels = map[string]string{"5h": "5 hours", "day": "24 hours", "week": "7 days", "month": "30 days"}

// efforts are the canonical reasoning levels a rule can name.
var efforts = []string{"none", "auto", "minimal", "low", "medium", "high", "xhigh", "max"}

// Rule matches requests by model glob and effort, then blocks or redirects them.
type Rule struct {
	Models         []string `yaml:"models" json:"models"`
	Efforts        []string `yaml:"efforts,omitempty" json:"efforts"`
	Action         string   `yaml:"action" json:"action"`
	RedirectModel  string   `yaml:"redirect_model,omitempty" json:"redirect_model"`
	RedirectEffort string   `yaml:"redirect_effort,omitempty" json:"redirect_effort"`
}

// Profile is a named, ordered rule list shared by keys; the first matching rule wins.
type Profile struct {
	ID    string `yaml:"id" json:"id"`
	Name  string `yaml:"name" json:"name"`
	Rules []Rule `yaml:"rules" json:"rules"`
}

// KeySettings is the stored policy of one client key.
type KeySettings struct {
	Enabled    bool               `yaml:"enabled"`
	Profile    string             `yaml:"profile,omitempty"`
	Budgets    map[string]float64 `yaml:"budgets,omitempty"`
	OverBudget string             `yaml:"over_budget,omitempty"`
}

// KeyUpdate changes a key's settings; a nil field keeps the current value.
type KeyUpdate struct {
	Enabled    *bool              `json:"enabled"`
	Profile    *string            `json:"profile"`
	Budgets    map[string]float64 `json:"budgets"`
	OverBudget *string            `json:"over_budget"`
}

// Price is a USD price per 1M tokens. A zero cache write bills cache writes at the input price.
type Price struct {
	Input      float64 `yaml:"input" json:"input"`
	Output     float64 `yaml:"output" json:"output"`
	CacheRead  float64 `yaml:"cache_read" json:"cache_read"`
	CacheWrite float64 `yaml:"cache_write" json:"cache_write"`
}

// policy is everything stored in policy.yaml: keys by id, never by the raw key.
type policy struct {
	Profiles []Profile              `yaml:"profiles,omitempty"`
	Keys     map[string]KeySettings `yaml:"keys,omitempty"`
	Prices   map[string]Price       `yaml:"prices,omitempty"`
}

// InvalidError is a request the caller can fix; management routes answer it with 400.
type InvalidError struct{ msg string }

func (e *InvalidError) Error() string { return e.msg }

func invalidf(format string, args ...any) error {
	return &InvalidError{msg: fmt.Sprintf(format, args...)}
}

// ErrKeyNotFound reports a key id that matches no key in config.
var ErrKeyNotFound = errors.New("no client key in config has this id")

// KeyID is the lowercase hex SHA-256 of a client key, the id its policy is stored under.
func KeyID(key string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(key)))
	return hex.EncodeToString(sum[:])
}

func defaultKeySettings() KeySettings {
	return KeySettings{Enabled: true, OverBudget: OverBudgetBlock}
}

func loadPolicy(path string) (policy, error) {
	var p policy
	data, errRead := os.ReadFile(path)
	if errors.Is(errRead, os.ErrNotExist) {
		return p, nil
	}
	if errRead != nil {
		return p, fmt.Errorf("read %s: %w", path, errRead)
	}
	if errParse := yaml.Unmarshal(data, &p); errParse != nil {
		return p, fmt.Errorf("parse %s: %w", path, errParse)
	}
	return p, nil
}

func savePolicy(path string, p policy) error {
	data, errMarshal := yaml.Marshal(p)
	if errMarshal != nil {
		return fmt.Errorf("encode policy: %w", errMarshal)
	}
	return writeFileAtomic(path, data)
}

// writeFileAtomic replaces path through a synced temp file ending in ".tmp", never ".json":
// the backend loads every *.json under the auth dir as a credential.
func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, errCreate := os.CreateTemp(dir, filepath.Base(path)+".*.tmp")
	if errCreate != nil {
		return fmt.Errorf("create temp file: %w", errCreate)
	}
	tmpPath := tmp.Name()
	_, errWrite := tmp.Write(data)
	if errWrite == nil {
		errWrite = tmp.Sync()
	}
	errClose := tmp.Close()
	if errWrite == nil {
		errWrite = errClose
	}
	if errWrite == nil {
		errWrite = os.Chmod(tmpPath, 0o600)
	}
	if errWrite == nil {
		errWrite = os.Rename(tmpPath, path)
	}
	if errWrite != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("write %s: %w", path, errWrite)
	}
	syncDir(dir)
	return nil
}

// syncDir makes a rename in dir durable; best effort, as some platforms cannot sync a dir.
func syncDir(dir string) {
	d, errOpen := os.Open(dir)
	if errOpen != nil {
		return
	}
	_ = d.Sync()
	if errClose := d.Close(); errClose != nil {
		log.Warnf("client keys: close %s: %v", dir, errClose)
	}
}

// normalizeProfiles validates profiles and fills missing ids from names.
func normalizeProfiles(in []Profile) ([]Profile, error) {
	out := make([]Profile, len(in))
	taken := make(map[string]bool, len(in))
	for i, profile := range in {
		name := strings.TrimSpace(profile.Name)
		if name == "" {
			return nil, invalidf("profile %d: name is required", i+1)
		}
		id := strings.TrimSpace(profile.ID)
		if id != "" {
			if taken[id] {
				return nil, invalidf("profile %q: id %q is already used", name, id)
			}
			taken[id] = true
		}
		rules := make([]Rule, len(profile.Rules))
		for j, rule := range profile.Rules {
			normalized, errRule := normalizeRule(rule)
			if errRule != nil {
				return nil, invalidf("profile %q, rule %d: %v", name, j+1, errRule)
			}
			rules[j] = normalized
		}
		out[i] = Profile{ID: id, Name: name, Rules: rules}
	}
	for i := range out {
		if out[i].ID == "" {
			out[i].ID = uniqueSlug(out[i].Name, taken)
			taken[out[i].ID] = true
		}
	}
	return out, nil
}

func normalizeRule(rule Rule) (Rule, error) {
	out := Rule{Models: cleanList(rule.Models, false), Efforts: cleanList(rule.Efforts, true)}
	if len(out.Models) == 0 {
		return out, errors.New("no models")
	}
	for _, effort := range out.Efforts {
		if !slices.Contains(efforts, effort) {
			return out, fmt.Errorf("unknown effort %q", effort)
		}
	}
	out.Action = strings.ToLower(strings.TrimSpace(rule.Action))
	switch out.Action {
	case ActionBlock:
		return out, nil
	case ActionRedirect:
		out.RedirectModel = strings.TrimSpace(rule.RedirectModel)
		out.RedirectEffort = strings.ToLower(strings.TrimSpace(rule.RedirectEffort))
		if out.RedirectModel == "" && out.RedirectEffort == "" {
			return out, errors.New("redirect needs a model or an effort")
		}
		if out.RedirectEffort != "" && !slices.Contains(efforts, out.RedirectEffort) {
			return out, fmt.Errorf("unknown effort %q", out.RedirectEffort)
		}
		if thinking.ParseSuffix(out.RedirectModel).HasSuffix {
			return out, fmt.Errorf("redirect model %q has an effort suffix; set the redirect effort instead", out.RedirectModel)
		}
		return out, nil
	default:
		return out, fmt.Errorf("unknown action %q", rule.Action)
	}
}

// cleanList trims entries and drops empty and repeated ones, keeping order.
func cleanList(in []string, lower bool) []string {
	out := make([]string, 0, len(in))
	for _, value := range in {
		value = strings.TrimSpace(value)
		if lower {
			value = strings.ToLower(value)
		}
		if value != "" && !slices.Contains(out, value) {
			out = append(out, value)
		}
	}
	return out
}

// uniqueSlug derives a profile id from name: lowercase letters and digits joined by dashes,
// numbered when taken.
func uniqueSlug(name string, taken map[string]bool) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(name) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			if dash && b.Len() > 0 {
				b.WriteByte('-')
			}
			b.WriteRune(r)
			dash = false
		} else {
			dash = true
		}
	}
	base := b.String()
	if base == "" {
		base = "profile"
	}
	slug := base
	for n := 2; taken[slug]; n++ {
		slug = fmt.Sprintf("%s-%d", base, n)
	}
	return slug
}

// applyKeyUpdate validates update against the profiles and applies it to current.
func applyKeyUpdate(current KeySettings, update KeyUpdate, profiles []Profile) (KeySettings, error) {
	next := current
	if update.Enabled != nil {
		next.Enabled = *update.Enabled
	}
	if update.Profile != nil {
		next.Profile = strings.TrimSpace(*update.Profile)
		if next.Profile != "" && findProfile(profiles, next.Profile) == nil {
			return current, invalidf("unknown profile %q", next.Profile)
		}
	}
	if update.Budgets != nil {
		next.Budgets = make(map[string]float64, len(update.Budgets))
		for window, budget := range update.Budgets {
			if _, ok := windowSpans[window]; !ok {
				return current, invalidf("unknown window %q", window)
			}
			if budget < 0 {
				return current, invalidf("budget for %s is negative", window)
			}
			next.Budgets[window] = budget
		}
	}
	if update.OverBudget != nil {
		switch over := strings.ToLower(strings.TrimSpace(*update.OverBudget)); over {
		case "", OverBudgetBlock:
			next.OverBudget = OverBudgetBlock
		case OverBudgetWarn:
			next.OverBudget = OverBudgetWarn
		default:
			return current, invalidf("unknown over_budget %q", *update.OverBudget)
		}
	}
	return next, nil
}

func findProfile(profiles []Profile, id string) *Profile {
	for i := range profiles {
		if profiles[i].ID == id {
			return &profiles[i]
		}
	}
	return nil
}

// configKeys returns the keys clients can authenticate with: trimmed, nonempty, first occurrence.
func configKeys(keys []string) []string {
	return cleanList(keys, false)
}
