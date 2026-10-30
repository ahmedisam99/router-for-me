package clientkeys

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/thinking"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/util"
	coreusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
	sdkconfig "github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	log "github.com/sirupsen/logrus"
	"gopkg.in/yaml.v3"
)

const (
	priceSourceName = "LiteLLM"
	priceSourceURL  = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
	pricesFileName  = "litellm-prices.yaml"
	priceMaxAge     = 7 * 24 * time.Hour
	fetchTimeout    = 60 * time.Second
	maxPriceList    = 64 << 20
)

// priceField matches the LiteLLM fields cost uses: a base price, optionally above an input
// token threshold, optionally for a service tier.
var priceField = regexp.MustCompile(`^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)(?:_above_(\d+)k_tokens)?(?:_(priority|flex))?$`)

var priceFieldNames = map[string]string{
	"input_cost_per_token":            "input",
	"output_cost_per_token":           "output",
	"cache_read_input_token_cost":     "cache_read",
	"cache_creation_input_token_cost": "cache_write",
}

var (
	dateSuffix              = regexp.MustCompile(`(-\d{8}|-\d{4}-\d{2}-\d{2}|@default)$`)
	antigravityEffortSuffix = regexp.MustCompile(`-(high|medium|low|thinking)$`)
)

// providerPrefixes maps a record's provider to the prefix LiteLLM files its models under.
var providerPrefixes = map[string]string{
	"gemini":      "gemini/",
	"aistudio":    "gemini/",
	"gemini-cli":  "gemini/",
	"vertex":      "vertex_ai/",
	"antigravity": "vertex_ai/",
	"xai":         "xai/",
	"kimi":        "moonshot/",
	"meta":        "meta/",
}

// importedPrices is the trimmed LiteLLM list as cached on disk: USD per token under
// LiteLLM's own field names, only the fields cost uses.
type importedPrices struct {
	URL       string                        `yaml:"url"`
	FetchedAt time.Time                     `yaml:"fetched_at"`
	Models    map[string]map[string]float64 `yaml:"models"`
}

type rateKey struct {
	field  string // input, output, cache_read or cache_write
	aboveK int64  // applies above this many thousand input tokens; 0 for the base price
	tier   string // service tier: "", "priority" or "flex"
}

// rates are a model's USD prices per token.
type rates map[rateKey]float64

// parseLiteLLM trims LiteLLM's model_prices_and_context_window.json to the models with a
// token price, ids lowercased. chatgpt/* entries are skipped: LiteLLM prices them at 0.
func parseLiteLLM(data []byte) (map[string]map[string]float64, error) {
	var raw map[string]json.RawMessage
	if errParse := json.Unmarshal(data, &raw); errParse != nil {
		return nil, fmt.Errorf("parse price list: %w", errParse)
	}
	models := make(map[string]map[string]float64, len(raw))
	for rawID, entry := range raw {
		id := strings.ToLower(strings.TrimSpace(rawID))
		if id == "sample_spec" || strings.HasPrefix(id, "chatgpt/") {
			continue
		}
		var fields map[string]json.RawMessage
		if json.Unmarshal(entry, &fields) != nil {
			continue
		}
		kept := make(map[string]float64)
		for name, value := range fields {
			var price float64
			if priceField.MatchString(name) && json.Unmarshal(value, &price) == nil {
				kept[name] = price
			}
		}
		_, hasInput := kept["input_cost_per_token"]
		_, hasOutput := kept["output_cost_per_token"]
		if !hasInput && !hasOutput {
			continue
		}
		// Ids differing only in case collapse; the one already lowercase wins.
		if _, exists := models[id]; exists && rawID != id {
			continue
		}
		models[id] = kept
	}
	if len(models) == 0 {
		return nil, errors.New("price list has no token prices")
	}
	return models, nil
}

func ratesFromFields(fields map[string]float64) rates {
	out := make(rates, len(fields))
	for name, price := range fields {
		match := priceField.FindStringSubmatch(name)
		if match == nil {
			continue
		}
		aboveK, _ := strconv.ParseInt(match[2], 10, 64)
		out[rateKey{field: priceFieldNames[match[1]], aboveK: aboveK, tier: match[3]}] = price
	}
	return out
}

func ratesFromPrice(p Price) rates {
	return rates{
		{field: "input"}:       p.Input / 1e6,
		{field: "output"}:      p.Output / 1e6,
		{field: "cache_read"}:  p.CacheRead / 1e6,
		{field: "cache_write"}: p.CacheWrite / 1e6,
	}
}

// basePrice is the standard price per 1M tokens, without token or service tiers.
func (r rates) basePrice() *Price {
	return &Price{
		Input:      per1M(r[rateKey{field: "input"}]),
		Output:     per1M(r[rateKey{field: "output"}]),
		CacheRead:  per1M(r[rateKey{field: "cache_read"}]),
		CacheWrite: per1M(r[rateKey{field: "cache_write"}]),
	}
}

// per1M converts a per-token price, trimming float noise from the conversion.
func per1M(perToken float64) float64 {
	rounded, _ := strconv.ParseFloat(strconv.FormatFloat(perToken*1e6, 'g', 10, 64), 64)
	return rounded
}

// cost prices a token breakdown. The highest token tier whose threshold the input total
// exceeds applies to every bucket; a service tier price wins over a token tier one when
// LiteLLM has no price for both. Unclassified tokens cost the input price, as do cache
// writes without a price of their own.
func (r rates) cost(b coreusage.TokenBreakdown, serviceTier string) float64 {
	var aboveK int64
	for key := range r {
		if key.aboveK > aboveK && b.Input.TotalTokens > key.aboveK*1000 {
			aboveK = key.aboveK
		}
	}
	tier := strings.ToLower(strings.TrimSpace(serviceTier))
	if tier != "priority" && tier != "flex" {
		tier = ""
	}
	rate := func(field string) float64 {
		for _, key := range []rateKey{{field, aboveK, tier}, {field, 0, tier}, {field, aboveK, ""}, {field, 0, ""}} {
			if price, ok := r[key]; ok {
				return price
			}
		}
		return 0
	}
	input, output, cacheRead, cacheWrite := rate("input"), rate("output"), rate("cache_read"), rate("cache_write")
	if cacheWrite == 0 {
		cacheWrite = input
	}
	return float64(b.Input.UncachedTokens+b.UnclassifiedTokens)*input +
		float64(b.Input.CacheReadTokens)*cacheRead +
		float64(b.Input.CacheWriteTokens)*cacheWrite +
		float64(b.Output.NonReasoningTokens+b.Output.ReasoningTokens)*output
}

// priceBook resolves model names to rates: overrides by exact id, then the imported list.
type priceBook struct {
	overrides map[string]rates
	imported  map[string]rates
}

// lookup prices the first of names, in preference order, that has an override or an
// imported price, its override first.
func (b priceBook) lookup(names []string, provider string) (rates, bool) {
	for _, name := range names {
		if r, ok := b.overrides[name]; ok {
			return r, true
		}
		if r, ok := b.lookupImported([]string{name}, provider); ok {
			return r, true
		}
	}
	return nil, false
}

func (b priceBook) lookupImported(names []string, provider string) (rates, bool) {
	for _, name := range names {
		for _, id := range importedIDs(name, provider) {
			if r, ok := b.imported[id]; ok {
				return r, true
			}
		}
	}
	return nil, false
}

// importedIDs lists the LiteLLM ids name may be filed under, best first: as is, under the
// provider's prefix, then without a vendor/ prefix, a date suffix, and antigravity's effort
// suffix, each also under the provider's prefix. xAI's -0309 style suffixes are kept.
func importedIDs(name, provider string) []string {
	provider = strings.ToLower(strings.TrimSpace(provider))
	prefix := providerPrefixes[provider]
	var ids []string
	add := func(id string) {
		ids = append(ids, id)
		if prefix != "" && !strings.HasPrefix(id, prefix) {
			ids = append(ids, prefix+id)
		}
	}
	add(name)
	stripped := name
	if slash := strings.Index(stripped, "/"); slash >= 0 {
		stripped = stripped[slash+1:]
		add(stripped)
	}
	if undated := dateSuffix.ReplaceAllString(stripped, ""); undated != stripped {
		stripped = undated
		add(stripped)
	}
	if provider == "antigravity" {
		if base := antigravityEffortSuffix.ReplaceAllString(stripped, ""); base != stripped {
			add(base)
		}
	}
	return ids
}

// recordNames lists the names a usage record can be priced under, best first: the upstream
// model, the model the upstream reported, then the model the client asked for.
func recordNames(r coreusage.Record) []string {
	return priceNames(r.Model, r.ResponseModel, r.Alias)
}

func priceNames(models ...string) []string {
	out := make([]string, 0, len(models))
	for _, model := range models {
		name := strings.ToLower(strings.TrimSpace(thinking.ParseSuffix(strings.TrimSpace(model)).ModelName))
		if name != "" && !slices.Contains(out, name) {
			out = append(out, name)
		}
	}
	return out
}

func loadImportedPrices(path string) (*importedPrices, error) {
	data, errRead := os.ReadFile(path)
	if errors.Is(errRead, os.ErrNotExist) {
		return nil, nil
	}
	if errRead != nil {
		return nil, fmt.Errorf("read %s: %w", path, errRead)
	}
	var list importedPrices
	if errParse := yaml.Unmarshal(data, &list); errParse != nil {
		return nil, fmt.Errorf("parse %s: %w", path, errParse)
	}
	return &list, nil
}

func saveImportedPrices(path string, list *importedPrices) error {
	data, errMarshal := yaml.Marshal(list)
	if errMarshal != nil {
		return fmt.Errorf("encode prices: %w", errMarshal)
	}
	return writeFileAtomic(path, data)
}

// httpFetcher downloads the price list. Its timeout is fine here: this is not model traffic.
func httpFetcher(proxyURL string) func(context.Context, string) ([]byte, error) {
	client := &http.Client{Timeout: fetchTimeout}
	util.SetProxy(&sdkconfig.SDKConfig{ProxyURL: strings.TrimSpace(proxyURL)}, client)
	return func(ctx context.Context, url string) ([]byte, error) {
		req, errReq := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if errReq != nil {
			return nil, errReq
		}
		resp, errDo := client.Do(req)
		if errDo != nil {
			return nil, errDo
		}
		defer func() {
			if errClose := resp.Body.Close(); errClose != nil {
				log.Warnf("client keys: close price list response: %v", errClose)
			}
		}()
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("download %s: %s", url, resp.Status)
		}
		return io.ReadAll(io.LimitReader(resp.Body, maxPriceList))
	}
}
