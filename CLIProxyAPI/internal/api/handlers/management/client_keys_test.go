package management

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/clientkeys"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

const clientKeysPriceList = `{
  "claude-opus-5-5": {"input_cost_per_token": 4e-06, "output_cost_per_token": 2e-05, "cache_read_input_token_cost": 2e-07, "cache_creation_input_token_cost": 5e-06}
}`

// newClientKeysRouter serves the client key routes for config keys sk-a and sk-b, with
// claude-opus-5-5 and unpriced-model served. fetch answers price list downloads.
func newClientKeysRouter(t *testing.T, fetch func() ([]byte, error)) *gin.Engine {
	t.Helper()
	t.Setenv("MANAGEMENT_PASSWORD", "")
	svc, errOpen := clientkeys.Open(t.TempDir(), clientkeys.Options{Fetch: func(context.Context, string) ([]byte, error) { return fetch() }})
	if errOpen != nil {
		t.Fatalf("clientkeys.Open() error = %v", errOpen)
	}
	t.Cleanup(svc.Close)
	clientkeys.SetDefault(svc)
	t.Cleanup(func() { clientkeys.SetDefault(nil) })

	manager := coreauth.NewManager(nil, nil, nil)
	auth := &coreauth.Auth{ID: "client-keys-claude", Provider: "claude", Status: coreauth.StatusActive}
	if _, errRegister := manager.Register(context.Background(), auth); errRegister != nil {
		t.Fatalf("Register() error = %v", errRegister)
	}
	registry.GetGlobalRegistry().RegisterClient(auth.ID, auth.Provider, []*registry.ModelInfo{{ID: "claude-opus-5-5"}, {ID: "unpriced-model"}})
	t.Cleanup(func() { registry.GetGlobalRegistry().UnregisterClient(auth.ID) })

	cfg := &config.Config{AuthDir: t.TempDir()}
	cfg.APIKeys = []string{"sk-a", "sk-b"}
	h := NewHandlerWithoutConfigFilePath(cfg, manager)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/client-keys", h.GetClientKeys)
	router.PUT("/client-keys/keys/:id", h.PutClientKey)
	router.PUT("/client-keys/profiles", h.PutClientKeyProfiles)
	router.GET("/client-keys/prices", h.GetClientKeyPrices)
	router.PUT("/client-keys/prices", h.PutClientKeyPrice)
	router.POST("/client-keys/prices/refresh", h.RefreshClientKeyPrices)
	return router
}

func serveClientKeys(t *testing.T, router *gin.Engine, method, path, body string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
	var decoded map[string]any
	if errDecode := json.Unmarshal(rec.Body.Bytes(), &decoded); errDecode != nil {
		t.Fatalf("%s %s: decode %q: %v", method, path, rec.Body.String(), errDecode)
	}
	return rec.Code, decoded
}

func TestClientKeysListAndUpdateKeys(t *testing.T) {
	router := newClientKeysRouter(t, func() ([]byte, error) { return nil, errors.New("offline") })

	status, body := serveClientKeys(t, router, http.MethodGet, "/client-keys", "")
	keys, _ := body["keys"].([]any)
	if status != http.StatusOK || len(keys) != 2 || keys[0].(map[string]any)["key"] != "sk-a" {
		t.Fatalf("GET = %d %v, want sk-a and sk-b", status, body)
	}

	status, body = serveClientKeys(t, router, http.MethodPut, "/client-keys/profiles",
		`{"profiles":[{"name":"Siblings","rules":[{"models":["claude-fable-5"],"efforts":[],"action":"block"}]}]}`)
	profiles, _ := body["profiles"].([]any)
	if status != http.StatusOK || len(profiles) != 1 || profiles[0].(map[string]any)["id"] != "siblings" {
		t.Fatalf("PUT profiles = %d %v, want the profile with id siblings", status, body)
	}

	path := "/client-keys/keys/" + clientkeys.KeyID("sk-b")
	status, body = serveClientKeys(t, router, http.MethodPut, path,
		`{"enabled":false,"profile":"siblings","budgets":{"5h":5,"week":30},"over_budget":"warn"}`)
	if status != http.StatusOK || body["enabled"] != false || body["profile"] != "siblings" || body["over_budget"] != "warn" ||
		body["budgets"].(map[string]any)["week"] != 30.0 || body["id"] != clientkeys.KeyID("sk-b") {
		t.Fatalf("PUT key = %d %v, want the updated entry", status, body)
	}
	_, body = serveClientKeys(t, router, http.MethodGet, "/client-keys", "")
	if second := body["keys"].([]any)[1].(map[string]any); second["profile"] != "siblings" || second["enabled"] != false {
		t.Fatalf("GET after PUT = %v, want sk-b updated", second)
	}

	for name, tc := range map[string]struct {
		path, body string
		want       int
	}{
		"unknown id":          {"/client-keys/keys/" + clientkeys.KeyID("sk-gone"), `{"enabled":true}`, http.StatusNotFound},
		"invalid body":        {path, `{`, http.StatusBadRequest},
		"unknown profile":     {path, `{"profile":"nope"}`, http.StatusBadRequest},
		"unknown window":      {path, `{"budgets":{"year":1}}`, http.StatusBadRequest},
		"negative budget":     {path, `{"budgets":{"day":-1}}`, http.StatusBadRequest},
		"unknown over_budget": {path, `{"over_budget":"ignore"}`, http.StatusBadRequest},
	} {
		if status, body := serveClientKeys(t, router, http.MethodPut, tc.path, tc.body); status != tc.want || body["error"] == "" {
			t.Errorf("%s: PUT key = %d %v, want %d with an error", name, status, body, tc.want)
		}
	}
}

func TestClientKeysProfileErrors(t *testing.T) {
	router := newClientKeysRouter(t, func() ([]byte, error) { return nil, errors.New("offline") })
	status, body := serveClientKeys(t, router, http.MethodPut, "/client-keys/profiles",
		`{"profiles":[{"name":"Kids","rules":[{"models":["a"],"action":"block"},{"models":["b"],"action":"redirect"}]}]}`)
	if status != http.StatusBadRequest || body["error"] != `profile "Kids", rule 2: redirect needs a model or an effort` {
		t.Fatalf("PUT profiles = %d %v, want 400 naming the profile and rule", status, body)
	}
	if status, _ := serveClientKeys(t, router, http.MethodPut, "/client-keys/profiles", `[]`); status != http.StatusBadRequest {
		t.Fatalf("PUT profiles with a bad body = %d, want 400", status)
	}
}

func TestClientKeysPrices(t *testing.T) {
	online := false
	router := newClientKeysRouter(t, func() ([]byte, error) {
		if !online {
			return nil, errors.New("offline")
		}
		return []byte(clientKeysPriceList), nil
	})

	status, body := serveClientKeys(t, router, http.MethodPost, "/client-keys/prices/refresh", "")
	if status != http.StatusBadGateway || !strings.Contains(body["error"].(string), "offline") {
		t.Fatalf("refresh offline = %d %v, want 502 with the error", status, body)
	}
	online = true
	status, body = serveClientKeys(t, router, http.MethodPost, "/client-keys/prices/refresh", "")
	if status != http.StatusOK || body["source"].(map[string]any)["fetched_at"] == nil {
		t.Fatalf("refresh = %d %v, want 200 with a fetch time", status, body)
	}
	prices := body["prices"].([]any)
	opus := prices[0].(map[string]any)
	wantImported := map[string]any{"input": 4.0, "output": 20.0, "cache_read": 0.2, "cache_write": 5.0}
	if len(prices) != 2 || opus["model"] != "claude-opus-5-5" || !mapsEqual(opus["imported"], wantImported) || opus["override"] != nil {
		t.Fatalf("prices = %v, want claude-opus-5-5 imported per 1M and unpriced-model", prices)
	}
	if unpriced := body["unpriced"].([]any); len(unpriced) != 1 || unpriced[0] != "unpriced-model" {
		t.Fatalf("unpriced = %v, want [unpriced-model]", unpriced)
	}

	status, body = serveClientKeys(t, router, http.MethodPut, "/client-keys/prices",
		`{"model":"unpriced-model","override":{"input":1,"output":2,"cache_read":0,"cache_write":0}}`)
	if status != http.StatusOK || len(body["unpriced"].([]any)) != 0 {
		t.Fatalf("PUT price = %d %v, want the model priced", status, body)
	}
	status, body = serveClientKeys(t, router, http.MethodPut, "/client-keys/prices", `{"model":"unpriced-model","override":null}`)
	if status != http.StatusOK || len(body["unpriced"].([]any)) != 1 {
		t.Fatalf("PUT null price = %d %v, want the override removed", status, body)
	}
	_, body = serveClientKeys(t, router, http.MethodGet, "/client-keys/prices", "")
	if len(body["prices"].([]any)) != 2 {
		t.Fatalf("GET prices = %v", body)
	}
	for name, payload := range map[string]string{
		"no model":       `{"override":{"input":1,"output":1,"cache_read":0,"cache_write":0}}`,
		"negative price": `{"model":"x","override":{"input":-1,"output":1,"cache_read":0,"cache_write":0}}`,
		"invalid body":   `{`,
	} {
		if status, _ := serveClientKeys(t, router, http.MethodPut, "/client-keys/prices", payload); status != http.StatusBadRequest {
			t.Errorf("%s: PUT price = %d, want 400", name, status)
		}
	}
}

func TestClientKeysUnavailable(t *testing.T) {
	router := newClientKeysRouter(t, func() ([]byte, error) { return nil, errors.New("offline") })
	clientkeys.SetDefault(nil)
	for _, route := range [][2]string{
		{http.MethodGet, "/client-keys"},
		{http.MethodPut, "/client-keys/keys/x"},
		{http.MethodPut, "/client-keys/profiles"},
		{http.MethodGet, "/client-keys/prices"},
		{http.MethodPut, "/client-keys/prices"},
		{http.MethodPost, "/client-keys/prices/refresh"},
	} {
		if status, _ := serveClientKeys(t, router, route[0], route[1], `{}`); status != http.StatusServiceUnavailable {
			t.Errorf("%s %s = %d, want 503", route[0], route[1], status)
		}
	}
}

func mapsEqual(got any, want map[string]any) bool {
	gotMap, ok := got.(map[string]any)
	if !ok || len(gotMap) != len(want) {
		return false
	}
	for key, value := range want {
		if gotMap[key] != value {
			return false
		}
	}
	return true
}

func TestClientKeysReportLoadError(t *testing.T) {
	router := newClientKeysRouter(t, func() ([]byte, error) { return nil, errors.New("offline") })
	dir := t.TempDir()
	if errWrite := os.WriteFile(filepath.Join(dir, "policy.yaml"), []byte("keys: [unclosed\n"), 0o600); errWrite != nil {
		t.Fatalf("write policy: %v", errWrite)
	}
	clientkeys.Load(dir, clientkeys.Options{})
	status, body := serveClientKeys(t, router, http.MethodGet, "/client-keys", "")
	if message, _ := body["error"].(string); status != http.StatusServiceUnavailable || !strings.Contains(message, "policy.yaml") {
		t.Fatalf("GET = %d %v, want 503 naming policy.yaml", status, body)
	}
}
