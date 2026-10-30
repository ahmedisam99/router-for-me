package api

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
	sdkaccess "github.com/router-for-me/CLIProxyAPI/v8/sdk/access"
)

// headerKeyProvider admits any key sent in X-Api-Key.
type headerKeyProvider struct{}

func (headerKeyProvider) Identifier() string { return "header-key" }

func (headerKeyProvider) Authenticate(_ context.Context, r *http.Request) (*sdkaccess.Result, *sdkaccess.AuthError) {
	return &sdkaccess.Result{Provider: "header-key", Principal: r.Header.Get("X-Api-Key")}, nil
}

func TestAccessAuthMiddlewareAppliesClientKeyPolicy(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc, errOpen := clientkeys.Open(t.TempDir(), clientkeys.Options{Fetch: func(context.Context, string) ([]byte, error) {
		return nil, errors.New("offline")
	}})
	if errOpen != nil {
		t.Fatalf("clientkeys.Open() error = %v", errOpen)
	}
	t.Cleanup(svc.Close)
	clientkeys.SetDefault(svc)
	t.Cleanup(func() { clientkeys.SetDefault(nil) })
	keys := []string{"sk-off", "sk-broke", "sk-ok"}
	off := false
	if _, errUpdate := svc.UpdateKey(keys, clientkeys.KeyID("sk-off"), clientkeys.KeyUpdate{Enabled: &off}); errUpdate != nil {
		t.Fatalf("UpdateKey() error = %v", errUpdate)
	}
	if _, errUpdate := svc.UpdateKey(keys, clientkeys.KeyID("sk-broke"), clientkeys.KeyUpdate{Budgets: map[string]float64{"day": 0}}); errUpdate != nil {
		t.Fatalf("UpdateKey() error = %v", errUpdate)
	}

	manager := sdkaccess.NewManager()
	manager.SetProviders([]sdkaccess.Provider{headerKeyProvider{}})
	tests := []struct {
		key         string
		realtime    bool
		wantStatus  int
		wantMessage string
	}{
		{"sk-ok", false, http.StatusOK, ""},
		{"sk-off", false, http.StatusForbidden, "This API key is switched off"},
		{"sk-off", true, http.StatusForbidden, "This API key is switched off"},
		{"sk-broke", false, http.StatusTooManyRequests, "This API key's budget is used up: $0.00 of $0.00 in the last 24 hours"},
	}
	for _, tt := range tests {
		router := gin.New()
		router.GET("/v1/models", accessAuthMiddleware(manager, tt.realtime), func(c *gin.Context) { c.Status(http.StatusOK) })
		req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
		req.Header.Set("X-Api-Key", tt.key)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != tt.wantStatus {
			t.Fatalf("%s realtime=%v: status = %d, want %d", tt.key, tt.realtime, rec.Code, tt.wantStatus)
		}
		if tt.wantMessage == "" {
			continue
		}
		var body struct {
			Error json.RawMessage `json:"error"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		var message string
		if tt.realtime {
			var nested struct {
				Message string `json:"message"`
			}
			_ = json.Unmarshal(body.Error, &nested)
			message = nested.Message
		} else {
			_ = json.Unmarshal(body.Error, &message)
		}
		if message != tt.wantMessage {
			t.Fatalf("%s realtime=%v: message = %q, want %q (body %s)", tt.key, tt.realtime, message, tt.wantMessage, rec.Body.String())
		}
	}
	if view := svc.Overview(keys).Keys[2]; view.LastUsed == nil {
		t.Fatal("an admitted key has no last use")
	}

	broken := t.TempDir()
	if errWrite := os.WriteFile(filepath.Join(broken, "policy.yaml"), []byte("keys: [unclosed\n"), 0o600); errWrite != nil {
		t.Fatalf("write policy: %v", errWrite)
	}
	clientkeys.Load(broken, clientkeys.Options{})
	router := gin.New()
	router.GET("/v1/models", accessAuthMiddleware(manager, false), func(c *gin.Context) { c.Status(http.StatusOK) })
	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	req.Header.Set("X-Api-Key", "sk-ok")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "policy.yaml") {
		t.Fatalf("policy that failed to load = %d %s, want 503 naming policy.yaml", rec.Code, rec.Body.String())
	}
}

func TestRealtimeClientSecretAppliesClientKeyPolicy(t *testing.T) {
	server := newTestServer(t)
	svc, errOpen := clientkeys.Open(t.TempDir(), clientkeys.Options{Fetch: func(context.Context, string) ([]byte, error) {
		return nil, errors.New("offline")
	}})
	if errOpen != nil {
		t.Fatalf("clientkeys.Open() error = %v", errOpen)
	}
	t.Cleanup(svc.Close)
	clientkeys.SetDefault(svc)
	t.Cleanup(func() { clientkeys.SetDefault(nil) })

	secretRequest := httptest.NewRequest(http.MethodPost, "/v1/realtime/client_secrets", strings.NewReader(`{"session":{"type":"realtime","model":"gpt-realtime"}}`))
	secretRequest.Header.Set("Authorization", "Bearer test-key")
	secretRecorder := httptest.NewRecorder()
	server.engine.ServeHTTP(secretRecorder, secretRequest)
	var secret struct {
		Value string `json:"value"`
	}
	if errUnmarshal := json.Unmarshal(secretRecorder.Body.Bytes(), &secret); errUnmarshal != nil || secret.Value == "" {
		t.Fatalf("client secret = %d %s", secretRecorder.Code, secretRecorder.Body.String())
	}
	off := false
	if _, errUpdate := svc.UpdateKey([]string{"test-key"}, clientkeys.KeyID("test-key"), clientkeys.KeyUpdate{Enabled: &off}); errUpdate != nil {
		t.Fatalf("UpdateKey() error = %v", errUpdate)
	}

	callRequest := httptest.NewRequest(http.MethodPost, "/v1/realtime/calls", strings.NewReader("v=0\r\n"))
	callRequest.Header.Set("Authorization", "Bearer "+secret.Value)
	callRequest.Header.Set("Content-Type", "application/sdp")
	callRecorder := httptest.NewRecorder()
	server.engine.ServeHTTP(callRecorder, callRequest)
	if callRecorder.Code != http.StatusForbidden || !strings.Contains(callRecorder.Body.String(), "This API key is switched off") {
		t.Fatalf("call with a switched-off key's secret = %d %s, want 403", callRecorder.Code, callRecorder.Body.String())
	}
}
