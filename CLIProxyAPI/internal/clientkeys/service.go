// Package clientkeys enforces per client API key policies: on/off, profiles of model rules,
// and spend budgets over rolling windows, with spend costed at paid-API prices.
package clientkeys

import (
	"bytes"
	"context"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/thinking"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/util"
	sdkaccess "github.com/router-for-me/CLIProxyAPI/v8/sdk/access"
	coreusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
	log "github.com/sirupsen/logrus"
	"github.com/tidwall/gjson"
)

// Service holds the policies, price list and spend ledger of the client keys.
type Service struct {
	dir   string
	now   func() time.Time
	fetch func(context.Context, string) ([]byte, error)

	mu        sync.RWMutex
	policy    policy
	book      priceBook
	fetchedAt time.Time // zero while the imported list never loaded
	priceErr  string

	refreshMu sync.Mutex
	ledger    *ledger
}

// Options configure Open; zero values use the wall clock and download over HTTP.
type Options struct {
	Now   func() time.Time
	Fetch func(ctx context.Context, url string) ([]byte, error)
}

// Rejection is a refusal a client sees: an HTTP status and a message.
type Rejection struct {
	Status  int
	Message string
}

// KeyView is a client key as the management API shows it.
type KeyView struct {
	ID         string             `json:"id"`
	Key        string             `json:"key"`
	Enabled    bool               `json:"enabled"`
	Profile    string             `json:"profile"`
	Budgets    map[string]float64 `json:"budgets"`
	OverBudget string             `json:"over_budget"`
	Spend      map[string]float64 `json:"spend"`
	Exceeded   []string           `json:"exceeded"`
	LastUsed   *time.Time         `json:"last_used"`
}

// Overview lists the client keys and the profiles.
type Overview struct {
	Windows  []string  `json:"windows"`
	Keys     []KeyView `json:"keys"`
	Profiles []Profile `json:"profiles"`
}

// PriceRow is the imported and override price of one model, per 1M tokens.
type PriceRow struct {
	Model    string `json:"model"`
	Imported *Price `json:"imported"`
	Override *Price `json:"override"`
}

// PriceSource describes the imported price list.
type PriceSource struct {
	Name      string     `json:"name"`
	URL       string     `json:"url"`
	FetchedAt *time.Time `json:"fetched_at"`
	Error     string     `json:"error"`
}

// PricesView lists the prices of the served and overridden models.
type PricesView struct {
	Source   PriceSource `json:"source"`
	Prices   []PriceRow  `json:"prices"`
	Unpriced []string    `json:"unpriced"`
}

var (
	defaultMu      sync.RWMutex
	defaultService *Service
	defaultErr     error // existing data failed to load: every request is refused
	startOnce      sync.Once
)

// Current returns the process-wide service, nil when it is not running, or the error that
// stopped existing data from loading.
func Current() (*Service, error) {
	defaultMu.RLock()
	defer defaultMu.RUnlock()
	return defaultService, defaultErr
}

// Enforced reports whether client key policies apply to requests, refusing them included.
func Enforced() bool {
	s, errUnavailable := Current()
	return s != nil || errUnavailable != nil
}

// SetDefault replaces the process-wide service; Load sets it and tests swap it.
func SetDefault(s *Service) {
	defaultMu.Lock()
	defaultService, defaultErr = s, nil
	defaultMu.Unlock()
}

// Start loads the client key data in <auth-dir>/client-keys, subscribes it to usage records
// and keeps the imported price list fresh. Later calls do nothing.
func Start(ctx context.Context, cfg *config.Config) {
	startOnce.Do(func() {
		if cfg == nil {
			return
		}
		authDir, errResolve := util.ResolveAuthDir(cfg.AuthDir)
		if errResolve != nil {
			log.Errorf("client keys: disabled: %v", errResolve)
			return
		}
		if s := Load(filepath.Join(authDir, "client-keys"), Options{Fetch: httpFetcher(cfg.ProxyURL)}); s != nil {
			coreusage.RegisterNamedPlugin("client-keys", s)
			go s.keepPricesFresh(ctx)
		}
	})
}

// Load opens dir as the process-wide service. If dir exists but its data cannot be loaded,
// every request is refused until it is fixed and the proxy restarts; if dir never existed
// and cannot be created, there are no policies to enforce and requests pass.
func Load(dir string, opts Options) *Service {
	_, errStat := os.Stat(dir)
	s, errOpen := Open(dir, opts)
	if errOpen == nil {
		SetDefault(s)
		return s
	}
	if errStat != nil {
		log.Errorf("client keys: disabled: %v", errOpen)
		return nil
	}
	errUnavailable := fmt.Errorf("client key policies failed to load: %w", errOpen)
	log.Errorf("client keys: refusing every request: %v", errUnavailable)
	defaultMu.Lock()
	defaultService, defaultErr = nil, errUnavailable
	defaultMu.Unlock()
	return nil
}

// Open loads the client key data in dir, creating the dir when missing.
func Open(dir string, opts Options) (*Service, error) {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Fetch == nil {
		opts.Fetch = httpFetcher("")
	}
	if errMkdir := os.MkdirAll(dir, 0o700); errMkdir != nil {
		return nil, fmt.Errorf("create %s: %w", dir, errMkdir)
	}
	pol, errPolicy := loadPolicy(filepath.Join(dir, policyFileName))
	if errPolicy != nil {
		return nil, errPolicy
	}
	led, errLedger := openLedger(filepath.Join(dir, "spend"), opts.Now)
	if errLedger != nil {
		return nil, errLedger
	}
	s := &Service{dir: dir, now: opts.Now, fetch: opts.Fetch, policy: pol, ledger: led}
	s.book.overrides = overrideRates(pol.Prices)
	list, errPrices := loadImportedPrices(filepath.Join(dir, pricesFileName))
	if errPrices != nil {
		log.Warnf("client keys: %v", errPrices)
	} else if list != nil {
		s.setImported(list)
	}
	return s, nil
}

// Close releases the open spend file.
func (s *Service) Close() {
	s.ledger.close()
}

// Admit checks an authenticated client key before its route runs and records its use.
// It returns the rejection for a switched-off key, a blocking budget or policies that failed
// to load, and nil otherwise or when the service is not running.
func Admit(key string) *sdkaccess.AuthError {
	s, errUnavailable := Current()
	if errUnavailable != nil {
		return &sdkaccess.AuthError{Code: sdkaccess.AuthErrorCodeInternal, Message: errUnavailable.Error(), StatusCode: http.StatusServiceUnavailable}
	}
	if s == nil || strings.TrimSpace(key) == "" {
		return nil
	}
	id := KeyID(key)
	settings, _ := s.keyPolicy(id)
	if rejection := s.admit(id, settings); rejection != nil {
		return sdkaccess.NewDeniedError(rejection.Message, rejection.Status)
	}
	return nil
}

// Route applies a client key's policy to a model request before routing: the key checks,
// then the first profile rule matching the model and its requested effort, read from body
// in format. It returns the model and body to execute, rewritten by a redirect, or the
// rejection. upstreams resolves a model to the upstream models it reaches. Everything
// passes when the service is not running.
func Route(key, model, format string, body []byte, upstreams func(string) []string) (string, []byte, *Rejection) {
	s, errUnavailable := Current()
	if errUnavailable != nil {
		return model, body, unavailable(errUnavailable)
	}
	if s == nil || strings.TrimSpace(key) == "" {
		return model, body, nil
	}
	d, rejection := s.route(key, model, format, body, upstreams)
	return d.model, d.body, rejection
}

// RejectTurn checks a websocket follow-up turn that goes upstream without routing, on a
// session that ran sessionBody for sessionModel. A turn cannot be rewritten, so one a
// redirect would change is refused unless the session already runs on the redirect's
// target and the turn carries no configuration_update items that could override it.
func RejectTurn(key, format, sessionModel string, sessionBody []byte, turnModel string, turn []byte, upstreams func(string) []string) *Rejection {
	s, errUnavailable := Current()
	if errUnavailable != nil {
		return unavailable(errUnavailable)
	}
	if s == nil || strings.TrimSpace(key) == "" {
		return nil
	}
	d, rejection := s.route(key, turnModel, format, turn, upstreams)
	if rejection != nil || !d.redirected {
		return rejection
	}
	session, _ := s.route(key, sessionModel, format, sessionBody, upstreams)
	if session.model == d.model && bytes.Equal(thinking.StripConfigurationUpdates(turn), turn) {
		return nil
	}
	return &Rejection{Status: http.StatusForbidden, Message: "This API key's rules change the model or effort of this turn; start a new request"}
}

func unavailable(err error) *Rejection {
	return &Rejection{Status: http.StatusServiceUnavailable, Message: err.Error()}
}

// decision is a request as a key's policy lets it run.
type decision struct {
	model      string
	body       []byte
	redirected bool
}

func (s *Service) route(key, model, format string, body []byte, upstreams func(string) []string) (decision, *Rejection) {
	d := decision{model: model, body: body}
	id := KeyID(key)
	settings, rules := s.keyPolicy(id)
	if rejection := s.admit(id, settings); rejection != nil {
		return d, rejection
	}
	if len(rules) == 0 {
		return d, nil
	}
	base := strings.TrimSpace(thinking.ParseSuffix(model).ModelName)
	effort := sync.OnceValue(func() string { return requestedEffort(body, format, model) })
	rule := matchRule(rules, base, effort, upstreams)
	if rule != nil && rule.Action == ActionBlock {
		return d, blocked(base)
	}
	// Nested models are checked for blocks only; they don't get redirects.
	for _, nested := range nestedModels(format, body) {
		nestedBase := strings.TrimSpace(thinking.ParseSuffix(nested).ModelName)
		if nestedRule := matchRule(rules, nestedBase, effort, upstreams); nestedRule != nil && nestedRule.Action == ActionBlock {
			return d, blocked(nestedBase)
		}
	}
	if rule != nil {
		d.model, d.redirected = redirectTarget(rule, model), true
		if rule.RedirectEffort != "" {
			// Responses configuration_update items would override the effort suffix upstream.
			d.body = thinking.StripConfigurationUpdates(body)
		}
	}
	return d, nil
}

func blocked(model string) *Rejection {
	return &Rejection{Status: http.StatusForbidden, Message: fmt.Sprintf("Model %s is not allowed for this API key", model)}
}

// requestedEffort is the effort a request asks for, "" when it states none. A suffix with
// spaces counts: the extractor ignores it, but execution trims it and applies it.
func requestedEffort(body []byte, format, model string) string {
	if effort := thinking.ExtractReasoningEffort(body, format, model); effort != "" {
		return effort
	}
	if parsed := thinking.ParseSuffix(model); parsed.HasSuffix {
		return strings.ToLower(strings.TrimSpace(parsed.RawSuffix))
	}
	return ""
}

// nestedModels lists the other models a Claude request runs: server tools' models (the
// advisor) and fallbacks.
func nestedModels(format string, body []byte) []string {
	if format != "claude" {
		return nil
	}
	var models []string
	for _, path := range []string{"tools.#.model", "fallbacks.#.model"} {
		for _, model := range gjson.GetBytes(body, path).Array() {
			if name := strings.TrimSpace(model.String()); name != "" {
				models = append(models, name)
			}
		}
	}
	return models
}

// keyPolicy returns the key's settings and its profile's rules. The rules are shared:
// saves replace them, never edit them.
func (s *Service) keyPolicy(id string) (KeySettings, []Rule) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	settings := s.settingsLocked(id)
	if profile := findProfile(s.policy.Profiles, settings.Profile); profile != nil {
		return settings, profile.Rules
	}
	return settings, nil
}

// settingsLocked returns the stored settings or the defaults, a missing profile as none.
func (s *Service) settingsLocked(id string) KeySettings {
	settings, ok := s.policy.Keys[id]
	if !ok {
		return defaultKeySettings()
	}
	if settings.OverBudget == "" {
		settings.OverBudget = OverBudgetBlock
	}
	if settings.Profile != "" && findProfile(s.policy.Profiles, settings.Profile) == nil {
		settings.Profile = ""
	}
	return settings
}

func (s *Service) admit(id string, settings KeySettings) *Rejection {
	if !settings.Enabled {
		return &Rejection{Status: http.StatusForbidden, Message: "This API key is switched off"}
	}
	if settings.OverBudget == OverBudgetBlock && len(settings.Budgets) > 0 {
		spend := s.ledger.spend(id)
		if exceeded := exceededWindows(settings.Budgets, spend); len(exceeded) > 0 {
			window := exceeded[0]
			return &Rejection{
				Status: http.StatusTooManyRequests,
				Message: fmt.Sprintf("This API key's budget is used up: $%.2f of $%.2f in the last %s",
					spend[window], settings.Budgets[window], windowLabels[window]),
			}
		}
	}
	s.ledger.touch(id)
	return nil
}

// exceededWindows lists the budgeted windows whose spend reached the budget, smallest first.
func exceededWindows(budgets, spend map[string]float64) []string {
	exceeded := make([]string, 0)
	for _, window := range Windows {
		if budget, ok := budgets[window]; ok && spend[window] >= budget {
			exceeded = append(exceeded, window)
		}
	}
	return exceeded
}

// HandleUsage costs a usage record and books it to its client key; it makes Service a
// usage plugin. Failed attempts count: their tokens were billed.
func (s *Service) HandleUsage(_ context.Context, record coreusage.Record) {
	key := strings.TrimSpace(record.APIKey)
	if key == "" {
		return
	}
	s.mu.RLock()
	book := s.book
	s.mu.RUnlock()
	names := recordNames(record)
	usd := 0.0
	if r, ok := book.lookup(names, record.Provider); ok {
		detail := coreusage.EnsureTokenBreakdownForProvider(record.Detail, record.Provider, record.ExecutorType)
		tier := record.ResponseServiceTier
		if tier == "" {
			tier = record.Detail.ResponseServiceTier
		}
		usd = r.cost(detail.TokenBreakdown, tier)
	}
	at := record.RequestedAt
	if at.IsZero() {
		at = s.now()
	}
	model := ""
	if len(names) > 0 {
		model = names[0]
	}
	s.ledger.add(spendEntry{Time: at.UnixMilli(), Key: KeyID(key), Model: model, USD: usd})
}

// Overview lists keys, the client keys in config order, with the profiles.
func (s *Service) Overview(keys []string) Overview {
	keys = configKeys(keys)
	views := make([]KeyView, 0, len(keys))
	s.mu.RLock()
	settings := make([]KeySettings, len(keys))
	for i, key := range keys {
		settings[i] = s.settingsLocked(KeyID(key))
	}
	profiles := profilesView(s.policy.Profiles)
	s.mu.RUnlock()
	for i, key := range keys {
		views = append(views, s.keyView(key, settings[i]))
	}
	return Overview{Windows: slices.Clone(Windows), Keys: views, Profiles: profiles}
}

func (s *Service) keyView(key string, settings KeySettings) KeyView {
	id := KeyID(key)
	spend := s.ledger.spend(id)
	exceeded := exceededWindows(settings.Budgets, spend)
	for window, usd := range spend {
		spend[window] = math.Round(usd*1e6) / 1e6
	}
	budgets := make(map[string]float64, len(settings.Budgets))
	for window, budget := range settings.Budgets {
		budgets[window] = budget
	}
	view := KeyView{
		ID:         id,
		Key:        key,
		Enabled:    settings.Enabled,
		Profile:    settings.Profile,
		Budgets:    budgets,
		OverBudget: settings.OverBudget,
		Spend:      spend,
		Exceeded:   exceeded,
	}
	if at, ok := s.ledger.lastUse(id); ok {
		utc := at.UTC()
		view.LastUsed = &utc
	}
	return view
}

// UpdateKey changes the settings of the key in keys with this id. Stored settings of keys
// absent from keys stay, so a key that comes back gets them back.
func (s *Service) UpdateKey(keys []string, id string, update KeyUpdate) (KeyView, error) {
	keys = configKeys(keys)
	key := ""
	for _, candidate := range keys {
		if KeyID(candidate) == id {
			key = candidate
			break
		}
	}
	if key == "" {
		return KeyView{}, ErrKeyNotFound
	}
	s.mu.Lock()
	next, errUpdate := applyKeyUpdate(s.settingsLocked(id), update, s.policy.Profiles)
	if errUpdate != nil {
		s.mu.Unlock()
		return KeyView{}, errUpdate
	}
	stored := keysWithProfiles(s.policy.Keys, s.policy.Profiles)
	stored[id] = next
	if errSave := s.saveLocked(policy{Profiles: s.policy.Profiles, Keys: stored, Prices: s.policy.Prices}); errSave != nil {
		s.mu.Unlock()
		return KeyView{}, errSave
	}
	s.mu.Unlock()
	return s.keyView(key, next), nil
}

// ReplaceProfiles validates and stores profiles, filling ids from names. Keys on a profile
// that is gone fall back to none.
func (s *Service) ReplaceProfiles(profiles []Profile) ([]Profile, error) {
	normalized, errProfiles := normalizeProfiles(profiles)
	if errProfiles != nil {
		return nil, errProfiles
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := policy{Profiles: normalized, Keys: keysWithProfiles(s.policy.Keys, normalized), Prices: s.policy.Prices}
	if errSave := s.saveLocked(next); errSave != nil {
		return nil, errSave
	}
	return profilesView(normalized), nil
}

// keysWithProfiles copies the stored settings of every key, a missing profile cleared.
func keysWithProfiles(stored map[string]KeySettings, profiles []Profile) map[string]KeySettings {
	out := make(map[string]KeySettings, len(stored)+1)
	for id, settings := range stored {
		if settings.Profile != "" && findProfile(profiles, settings.Profile) == nil {
			settings.Profile = ""
		}
		out[id] = settings
	}
	return out
}

func (s *Service) saveLocked(next policy) error {
	if errSave := savePolicy(filepath.Join(s.dir, policyFileName), next); errSave != nil {
		return errSave
	}
	s.policy = next
	s.book.overrides = overrideRates(next.Prices)
	return nil
}

// profilesView copies profiles with empty lists as [] rather than null.
func profilesView(profiles []Profile) []Profile {
	out := make([]Profile, len(profiles))
	for i, profile := range profiles {
		rules := make([]Rule, len(profile.Rules))
		for j, rule := range profile.Rules {
			rule.Models = append(make([]string, 0, len(rule.Models)), rule.Models...)
			rule.Efforts = append(make([]string, 0, len(rule.Efforts)), rule.Efforts...)
			rules[j] = rule
		}
		out[i] = Profile{ID: profile.ID, Name: profile.Name, Rules: rules}
	}
	return out
}

// Prices lists every served model, given with the providers serving it, and every model with
// an override, by lowercase id. Each row is the model's own price, whatever it is aliased to:
// a request is costed at the price of the model that ran it.
func (s *Service) Prices(served map[string][]string) PricesView {
	s.mu.RLock()
	defer s.mu.RUnlock()
	view := PricesView{
		Source:   PriceSource{Name: priceSourceName, URL: priceSourceURL, Error: s.priceErr},
		Prices:   make([]PriceRow, 0, len(served)+len(s.policy.Prices)),
		Unpriced: make([]string, 0),
	}
	if !s.fetchedAt.IsZero() {
		at := s.fetchedAt.UTC()
		view.Source.FetchedAt = &at
	} else if view.Source.Error == "" {
		view.Source.Error = "not downloaded yet"
	}
	rows := make(map[string]*PriceRow)
	servedIDs := make(map[string]bool)
	for model, providers := range served {
		names := priceNames(model)
		if len(names) == 0 {
			continue
		}
		id := names[0]
		servedIDs[id] = true
		if rows[id] == nil {
			rows[id] = &PriceRow{Model: id}
		}
		if rows[id].Imported == nil {
			if r, ok := s.ownImported(id, providers); ok {
				rows[id].Imported = r.basePrice()
			}
		}
	}
	for id, price := range s.policy.Prices {
		if rows[id] == nil {
			rows[id] = &PriceRow{Model: id}
		}
		override := price
		rows[id].Override = &override
	}
	for id, row := range rows {
		view.Prices = append(view.Prices, *row)
		if servedIDs[id] && row.Imported == nil && row.Override == nil {
			view.Unpriced = append(view.Unpriced, id)
		}
	}
	sort.Slice(view.Prices, func(i, j int) bool { return view.Prices[i].Model < view.Prices[j].Model })
	sort.Strings(view.Unpriced)
	return view
}

// ownImported looks up id in the imported list, also under each serving provider's prefix.
func (s *Service) ownImported(id string, providers []string) (rates, bool) {
	for _, provider := range providers {
		if r, ok := s.book.lookupImported([]string{id}, provider); ok {
			return r, true
		}
	}
	return s.book.lookupImported([]string{id}, "")
}

// SetPriceOverride sets the price per 1M tokens of model, or removes it when price is nil.
func (s *Service) SetPriceOverride(model string, price *Price) error {
	names := priceNames(model)
	if len(names) == 0 {
		return invalidf("model is required")
	}
	if price != nil && (price.Input < 0 || price.Output < 0 || price.CacheRead < 0 || price.CacheWrite < 0) {
		return invalidf("prices must not be negative")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	prices := make(map[string]Price, len(s.policy.Prices)+1)
	for id, existing := range s.policy.Prices {
		prices[id] = existing
	}
	if price == nil {
		delete(prices, names[0])
	} else {
		prices[names[0]] = *price
	}
	return s.saveLocked(policy{Profiles: s.policy.Profiles, Keys: s.policy.Keys, Prices: prices})
}

func overrideRates(prices map[string]Price) map[string]rates {
	out := make(map[string]rates, len(prices))
	for id, price := range prices {
		out[id] = ratesFromPrice(price)
	}
	return out
}

// RefreshPrices downloads the imported price list now. On failure the previous list stays
// and the error is reported with the list.
func (s *Service) RefreshPrices(ctx context.Context) error {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	errRefresh := s.refreshPrices(ctx)
	s.mu.Lock()
	s.priceErr = ""
	if errRefresh != nil {
		s.priceErr = errRefresh.Error()
	}
	s.mu.Unlock()
	return errRefresh
}

func (s *Service) refreshPrices(ctx context.Context) error {
	data, errFetch := s.fetch(ctx, priceSourceURL)
	if errFetch != nil {
		return fmt.Errorf("download price list: %w", errFetch)
	}
	models, errParse := parseLiteLLM(data)
	if errParse != nil {
		return errParse
	}
	list := &importedPrices{URL: priceSourceURL, FetchedAt: s.now().UTC(), Models: models}
	if errSave := saveImportedPrices(filepath.Join(s.dir, pricesFileName), list); errSave != nil {
		return errSave
	}
	s.setImported(list)
	return nil
}

func (s *Service) setImported(list *importedPrices) {
	imported := make(map[string]rates, len(list.Models))
	for id, fields := range list.Models {
		imported[id] = ratesFromFields(fields)
	}
	s.mu.Lock()
	s.book.imported = imported
	s.fetchedAt = list.FetchedAt
	s.mu.Unlock()
}

// keepPricesFresh downloads the price list when it is missing or older than 7 days, at
// start and then daily.
func (s *Service) keepPricesFresh(ctx context.Context) {
	refresh := func() {
		s.mu.RLock()
		stale := s.now().Sub(s.fetchedAt) > priceMaxAge
		s.mu.RUnlock()
		if !stale {
			return
		}
		if errRefresh := s.RefreshPrices(ctx); errRefresh != nil {
			log.Warnf("client keys: %v", errRefresh)
		}
	}
	refresh()
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			refresh()
		}
	}
}
