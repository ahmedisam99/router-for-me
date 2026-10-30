package clientkeys

import "testing"

func TestGlobMatch(t *testing.T) {
	tests := []struct {
		pattern, name string
		want          bool
	}{
		{"claude-fable-5", "claude-fable-5", true},
		{"claude-fable-5", "claude-fable-5-1", false},
		{"claude-fable-*", "claude-fable-5-1", true},
		{"CLAUDE-*", "claude-opus-5-5", true},
		{"claude-?pus-5-5", "claude-opus-5-5", true},
		{"*", "anything/with/slashes", true},
		{"anthropic/*", "anthropic/claude-x", true},
		{"*opus*", "claude-opus-5-5", true},
		{"gpt-[56]", "gpt-5", false},
		{"gpt-[56]", "gpt-[56]", true},
		{"a*b*c", "aXXbYYc", true},
		{"a*b*c", "aXXbYY", false},
	}
	for _, tt := range tests {
		if got := globMatch(tt.pattern, tt.name); got != tt.want {
			t.Errorf("globMatch(%q, %q) = %v, want %v", tt.pattern, tt.name, got, tt.want)
		}
	}
}

func TestMatchRule(t *testing.T) {
	rules := []Rule{
		{Models: []string{"claude-fable-5", "claude-fable-5-1"}, Action: ActionBlock},
		{Models: []string{"claude-opus-5-5"}, Efforts: []string{"xhigh", "max"}, Action: ActionRedirect, RedirectEffort: "high"},
		{Models: []string{"gpt-6.1-*"}, Action: ActionBlock},
	}
	upstreams := map[string][]string{
		"fable-alias": {"claude-fable-5(high)"},
		"sol-alias":   {"gpt-6.1-sol"},
	}
	resolve := func(model string) []string { return upstreams[model] }
	tests := []struct {
		name   string
		model  string
		effort string
		want   int // rule index, -1 for none
	}{
		{"blocked by name", "claude-fable-5", "", 0},
		{"blocked at any effort", "claude-fable-5-1", "max", 0},
		{"blocked through its upstream name", "fable-alias", "", 0},
		{"glob through upstream name", "sol-alias", "low", 2},
		{"effort rule matches listed effort", "claude-opus-5-5", "xhigh", 1},
		{"effort rule skips other effort", "claude-opus-5-5", "high", -1},
		{"effort rule skips unstated effort", "claude-opus-5-5", "", -1},
		{"no match", "claude-sonnet-5", "max", -1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := matchRule(rules, tt.model, func() string { return tt.effort }, resolve)
			if tt.want < 0 {
				if got != nil {
					t.Fatalf("matchRule() = %+v, want none", *got)
				}
				return
			}
			if got != &rules[tt.want] {
				t.Fatalf("matchRule() = %+v, want rule %d", got, tt.want)
			}
		})
	}
}

func TestMatchRuleResolvesUpstreamsOnlyWhenNeeded(t *testing.T) {
	rules := []Rule{{Models: []string{"claude-fable-5"}, Action: ActionBlock}}
	calls := 0
	resolve := func(string) []string { calls++; return nil }
	matchRule(rules, "claude-fable-5", func() string { return "" }, resolve)
	if calls != 0 {
		t.Fatalf("resolved upstreams %d times for a direct match", calls)
	}
	twoRules := append(rules, Rule{Models: []string{"x"}, Action: ActionBlock})
	matchRule(twoRules, "other", func() string { return "" }, resolve)
	if calls != 1 {
		t.Fatalf("resolved upstreams %d times, want once per request", calls)
	}
}

func TestRedirectTarget(t *testing.T) {
	tests := []struct {
		name  string
		rule  Rule
		model string
		want  string
	}{
		{"effort only", Rule{RedirectEffort: "high"}, "claude-opus-5-5", "claude-opus-5-5(high)"},
		{"effort replaces suffix", Rule{RedirectEffort: "high"}, "claude-opus-5-5(max)", "claude-opus-5-5(high)"},
		{"model keeps suffix", Rule{RedirectModel: "claude-opus-5-5"}, "claude-fable-5(xhigh)", "claude-opus-5-5(xhigh)"},
		{"model without suffix", Rule{RedirectModel: "claude-opus-5-5"}, "claude-fable-5", "claude-opus-5-5"},
		{"model and effort", Rule{RedirectModel: "claude-opus-5-5", RedirectEffort: "low"}, "claude-fable-5(8192)", "claude-opus-5-5(low)"},
		{"prefixed model keeps prefix", Rule{RedirectEffort: "high"}, "tenant/claude-opus-5-5(max)", "tenant/claude-opus-5-5(high)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := redirectTarget(&tt.rule, tt.model); got != tt.want {
				t.Fatalf("redirectTarget() = %q, want %q", got, tt.want)
			}
		})
	}
}
