package clientkeys

import (
	"slices"
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/thinking"
)

// matchRule returns the first rule matching a request for model (thinking suffix stripped)
// at effort, "" for none stated. Each rule's globs are tried against model and then
// against the upstream models it resolves to, which upstreams lists only when needed.
func matchRule(rules []Rule, model string, effort func() string, upstreams func(string) []string) *Rule {
	var resolved []string
	resolvedDone := false
	for i := range rules {
		rule := &rules[i]
		if len(rule.Efforts) > 0 && !slices.Contains(rule.Efforts, effort()) {
			continue
		}
		if matchesAny(rule.Models, model) {
			return rule
		}
		if !resolvedDone {
			resolvedDone = true
			if upstreams != nil {
				for _, upstream := range upstreams(model) {
					resolved = append(resolved, thinking.ParseSuffix(upstream).ModelName)
				}
			}
		}
		for _, upstream := range resolved {
			if matchesAny(rule.Models, upstream) {
				return rule
			}
		}
	}
	return nil
}

func matchesAny(patterns []string, name string) bool {
	for _, pattern := range patterns {
		if globMatch(pattern, name) {
			return true
		}
	}
	return false
}

// globMatch matches name against pattern case-insensitively: * is any run of characters,
// ? is one character, everything else is literal (including / and [).
func globMatch(pattern, name string) bool {
	p := []rune(strings.ToLower(pattern))
	n := []rune(strings.ToLower(strings.TrimSpace(name)))
	pi, ni := 0, 0
	star, mark := -1, 0
	for ni < len(n) {
		switch {
		case pi < len(p) && (p[pi] == '?' || p[pi] == n[ni]):
			pi++
			ni++
		case pi < len(p) && p[pi] == '*':
			star, mark = pi, ni
			pi++
		case star >= 0:
			pi = star + 1
			mark++
			ni = mark
		default:
			return false
		}
	}
	for pi < len(p) && p[pi] == '*' {
		pi++
	}
	return pi == len(p)
}

// redirectTarget is the model a redirect rule sends a request for model to: the rule's
// model or the requested base, with the rule's effort as a suffix, else the original suffix.
// Upstream lets a model suffix win over body effort on every executor path.
func redirectTarget(rule *Rule, model string) string {
	parsed := thinking.ParseSuffix(model)
	target := rule.RedirectModel
	if target == "" {
		target = parsed.ModelName
	}
	switch {
	case rule.RedirectEffort != "":
		return target + "(" + rule.RedirectEffort + ")"
	case parsed.HasSuffix:
		return target + "(" + parsed.RawSuffix + ")"
	default:
		return target
	}
}
