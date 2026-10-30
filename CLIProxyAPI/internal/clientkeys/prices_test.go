package clientkeys

import (
	"math"
	"reflect"
	"testing"

	coreusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

// litellmFixture is a tiny model_prices_and_context_window.json.
const litellmFixture = `{
  "sample_spec": {"input_cost_per_token": 0.0, "output_cost_per_token": 0.0, "litellm_provider": "x"},
  "claude-opus-5-5": {
    "input_cost_per_token": 4e-06, "output_cost_per_token": 2e-05,
    "cache_read_input_token_cost": 2e-07, "cache_creation_input_token_cost": 5e-06,
    "cache_creation_input_token_cost_above_1hr": 8e-06,
    "search_context_cost_per_query": {"search_context_size_low": 0.01},
    "litellm_provider": "anthropic", "max_tokens": 128000
  },
  "gpt-6.1-sol": {
    "input_cost_per_token": 2e-06, "output_cost_per_token": 1e-05, "cache_read_input_token_cost": 2e-07,
    "input_cost_per_token_priority": 4e-06, "output_cost_per_token_priority": 2e-05,
    "cache_read_input_token_cost_priority": 4e-07,
    "input_cost_per_token_above_272k_tokens": 4e-06,
    "input_cost_per_token_above_272k_tokens_priority": 8e-06,
    "input_cost_per_token_batches": 1e-06
  },
  "gemini/gemini-3-pro": {
    "input_cost_per_token": 2e-06, "output_cost_per_token": 1.2e-05, "cache_read_input_token_cost": 2e-07,
    "input_cost_per_token_above_200k_tokens": 4e-06, "output_cost_per_token_above_200k_tokens": 1.8e-05,
    "cache_read_input_token_cost_above_200k_tokens": 4e-07
  },
  "chatgpt/gpt-6.1-sol": {"input_cost_per_token": 0.0, "output_cost_per_token": 0.0},
  "dall-e-3": {"input_cost_per_image": 0.04},
  "Mixed/Case-Model": {"input_cost_per_token": 1e-06, "output_cost_per_token": 2e-06},
  "xai/grok-4.20": {"input_cost_per_token": 9e-06, "output_cost_per_token": 9e-06},
  "xai/grok-4.20-0309-reasoning": {"input_cost_per_token": 1.25e-06, "output_cost_per_token": 2.5e-06},
  "not-an-object": 42
}`

func fixtureBook(t *testing.T) priceBook {
	t.Helper()
	models, errParse := parseLiteLLM([]byte(litellmFixture))
	if errParse != nil {
		t.Fatalf("parseLiteLLM() error = %v", errParse)
	}
	imported := make(map[string]rates, len(models))
	for id, fields := range models {
		imported[id] = ratesFromFields(fields)
	}
	return priceBook{imported: imported, overrides: map[string]rates{}}
}

func TestParseLiteLLM(t *testing.T) {
	models, errParse := parseLiteLLM([]byte(litellmFixture))
	if errParse != nil {
		t.Fatalf("parseLiteLLM() error = %v", errParse)
	}
	var ids []string
	for id := range models {
		ids = append(ids, id)
	}
	want := map[string]bool{"claude-opus-5-5": true, "gpt-6.1-sol": true, "gemini/gemini-3-pro": true, "mixed/case-model": true, "xai/grok-4.20": true, "xai/grok-4.20-0309-reasoning": true}
	if len(models) != len(want) {
		t.Fatalf("parsed ids = %v, want %v", ids, want)
	}
	for id := range want {
		if models[id] == nil {
			t.Fatalf("parsed ids = %v, missing %q", ids, id)
		}
	}
	wantClaude := map[string]float64{
		"input_cost_per_token":            4e-06,
		"output_cost_per_token":           2e-05,
		"cache_read_input_token_cost":     2e-07,
		"cache_creation_input_token_cost": 5e-06,
	}
	if !reflect.DeepEqual(models["claude-opus-5-5"], wantClaude) {
		t.Fatalf("claude fields = %v, want only the priced token fields %v", models["claude-opus-5-5"], wantClaude)
	}
	if _, kept := models["gpt-6.1-sol"]["input_cost_per_token_batches"]; kept {
		t.Fatal("kept a batch price")
	}
	if got := len(models["gpt-6.1-sol"]); got != 8 {
		t.Fatalf("gpt fields = %v, want base, priority and tier prices", models["gpt-6.1-sol"])
	}
	if _, errEmpty := parseLiteLLM([]byte(`{"sample_spec": {"input_cost_per_token": 0}}`)); errEmpty == nil {
		t.Fatal("parseLiteLLM() accepted a list with no prices")
	}
	if _, errBad := parseLiteLLM([]byte(`<html>`)); errBad == nil {
		t.Fatal("parseLiteLLM() accepted a non-JSON body")
	}
}

func TestLookupImportedMapsIDs(t *testing.T) {
	book := fixtureBook(t)
	tests := []struct {
		name, model, provider, want string
	}{
		{"exact", "claude-opus-5-5", "claude", "claude-opus-5-5"},
		{"provider prefix", "gemini-3-pro", "gemini-cli", "gemini/gemini-3-pro"},
		{"aistudio prefix", "gemini-3-pro", "aistudio", "gemini/gemini-3-pro"},
		{"vendor prefix dropped", "anthropic/claude-opus-5-5", "openai-compatibility", "claude-opus-5-5"},
		{"compact date dropped", "claude-opus-5-5-20261001", "claude", "claude-opus-5-5"},
		{"dashed date dropped", "claude-opus-5-5-2026-10-01", "claude", "claude-opus-5-5"},
		{"@default dropped", "claude-opus-5-5@default", "vertex", "claude-opus-5-5"},
		{"antigravity effort dropped", "claude-opus-5-5-thinking", "antigravity", "claude-opus-5-5"},
		{"effort kept for other providers", "claude-opus-5-5-thinking", "claude", ""},
		{"xai prefix with 0309", "grok-4.20-0309-reasoning", "xai", "xai/grok-4.20-0309-reasoning"},
		{"0309 never stripped", "grok-4.20-0309", "xai", ""},
		{"case folded", "mixed/case-model", "openai-compatibility", "mixed/case-model"},
		{"chatgpt entries skipped", "chatgpt/gpt-6.1-sol", "codex", "gpt-6.1-sol"},
		{"unknown", "made-up", "claude", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := book.lookupImported([]string{tt.model}, tt.provider)
			if tt.want == "" {
				if ok {
					t.Fatalf("lookupImported(%q) = %v, want no price", tt.model, got)
				}
				return
			}
			if !ok || !reflect.DeepEqual(got, book.imported[tt.want]) {
				t.Fatalf("lookupImported(%q) = %v, want %s's rates", tt.model, got, tt.want)
			}
		})
	}
}

func TestLookupPricesEachNameInOrder(t *testing.T) {
	book := fixtureBook(t)
	override := ratesFromPrice(Price{Input: 1, Output: 1})
	// A redirected request ran on claude-opus-5-5; its alias is the client's original model.
	book.overrides["claude-fable-5"] = override
	got, _ := book.lookup([]string{"claude-opus-5-5", "claude-fable-5"}, "claude")
	if !reflect.DeepEqual(got, book.imported["claude-opus-5-5"]) {
		t.Fatalf("lookup() = %v, want the model the request ran on", got)
	}
	book.overrides["claude-opus-5-5"] = override
	if got, _ = book.lookup([]string{"claude-opus-5-5", "claude-fable-5"}, "claude"); !reflect.DeepEqual(got, override) {
		t.Fatalf("lookup() = %v, want a name's override before its imported price", got)
	}
	if got, _ = book.lookup([]string{"unpriced-upstream", "claude-fable-5"}, "claude"); !reflect.DeepEqual(got, override) {
		t.Fatalf("lookup() = %v, want the alias's override when the upstream has no price", got)
	}
	delete(book.overrides, "claude-opus-5-5")
	delete(book.overrides, "claude-fable-5")
	// The upstream model's fuzzy match beats the client's alias, which may name another model.
	got, _ = book.lookup([]string{"gpt-6.1-sol-20260901", "claude-opus-5-5"}, "codex")
	if !reflect.DeepEqual(got, book.imported["gpt-6.1-sol"]) {
		t.Fatalf("lookup() = %v, want the upstream model's rates", got)
	}
}

func TestRecordNames(t *testing.T) {
	got := recordNames(coreusage.Record{Model: "GPT-6.1-Sol(high)", ResponseModel: "gpt-6.1-sol", Alias: "claude-opus-5-5(xhigh)"})
	want := []string{"gpt-6.1-sol", "claude-opus-5-5"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("recordNames() = %v, want %v", got, want)
	}
}

func TestCost(t *testing.T) {
	book := fixtureBook(t)
	claude, gpt, gemini := book.imported["claude-opus-5-5"], book.imported["gpt-6.1-sol"], book.imported["gemini/gemini-3-pro"]
	tests := []struct {
		name      string
		rates     rates
		breakdown coreusage.TokenBreakdown
		tier      string
		want      float64
	}{
		{
			name:      "claude independent buckets",
			rates:     claude,
			breakdown: coreusage.NewIndependentTokenBreakdown(1000, 2000, 3000, 400, 100, 0),
			want:      1000*4e-6 + 2000*2e-7 + 3000*5e-6 + 500*2e-5,
		},
		{
			name:      "openai subset, cache writes at the input price",
			rates:     gpt,
			breakdown: coreusage.NewSubsetTokenBreakdown(10000, 4000, 1000, 2000, 500, 0),
			want:      5000*2e-6 + 4000*2e-7 + 1000*2e-6 + 2000*1e-5,
		},
		{
			name:      "priority service tier",
			rates:     gpt,
			breakdown: coreusage.NewSubsetTokenBreakdown(10000, 4000, 1000, 2000, 500, 0),
			tier:      "priority",
			want:      5000*4e-6 + 4000*4e-7 + 1000*4e-6 + 2000*2e-5,
		},
		{
			name:      "unknown service tier is standard",
			rates:     gpt,
			breakdown: coreusage.NewSubsetTokenBreakdown(10000, 0, 0, 2000, 0, 0),
			tier:      "default",
			want:      10000*2e-6 + 2000*1e-5,
		},
		{
			name:      "token tier above 272k, output falls back to base",
			rates:     gpt,
			breakdown: coreusage.NewSubsetTokenBreakdown(300000, 0, 0, 1000, 0, 0),
			want:      300000*4e-6 + 1000*1e-5,
		},
		{
			name:      "token tier with service tier",
			rates:     gpt,
			breakdown: coreusage.NewSubsetTokenBreakdown(300000, 0, 0, 1000, 0, 0),
			tier:      "priority",
			want:      300000*8e-6 + 1000*2e-5,
		},
		{
			name:      "gemini separate reasoning above 200k",
			rates:     gemini,
			breakdown: coreusage.NewSeparateReasoningTokenBreakdown(250000, 50000, 0, 1000, 3000, 0),
			want:      200000*4e-6 + 50000*4e-7 + 4000*1.8e-5,
		},
		{
			name:      "exactly at the threshold stays on the base tier",
			rates:     gemini,
			breakdown: coreusage.NewSeparateReasoningTokenBreakdown(200000, 0, 0, 1000, 0, 0),
			want:      200000*2e-6 + 1000*1.2e-5,
		},
		{
			name:      "unclassified tokens at the input price",
			rates:     claude,
			breakdown: coreusage.NewUnclassifiedTokenBreakdown(1000),
			want:      1000 * 4e-6,
		},
		{
			name:      "override per 1M, no cache write price",
			rates:     ratesFromPrice(Price{Input: 3, Output: 15, CacheRead: 0.3}),
			breakdown: coreusage.NewIndependentTokenBreakdown(1_000_000, 1_000_000, 1_000_000, 1_000_000, 0, 0),
			want:      3 + 0.3 + 3 + 15,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.rates.cost(tt.breakdown, tt.tier); math.Abs(got-tt.want) > 1e-12 {
				t.Fatalf("cost() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestBasePricePerMillion(t *testing.T) {
	got := fixtureBook(t).imported["gpt-6.1-sol"].basePrice()
	want := &Price{Input: 2, Output: 10, CacheRead: 0.2, CacheWrite: 0}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("basePrice() = %+v, want %+v", got, want)
	}
}
