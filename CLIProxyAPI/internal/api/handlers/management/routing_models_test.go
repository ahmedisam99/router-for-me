package management

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type routingTestModel struct {
	ID       string   `json:"id"`
	Upstream []string `json:"upstream"`
}

type routingTestCredential struct {
	ID         string             `json:"id"`
	Models     []routingTestModel `json:"models"`
	LastModels []routingTestModel `json:"last_models"`
}

func getRoutingModels(t *testing.T, h *Handler) map[string]routingTestCredential {
	t.Helper()
	rec := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(rec)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/v8/management/routing/models", nil)
	h.GetRoutingModels(ctx)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET routing/models = %d %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Credentials []routingTestCredential `json:"credentials"`
	}
	if errDecode := json.Unmarshal(rec.Body.Bytes(), &body); errDecode != nil {
		t.Fatalf("decode: %v", errDecode)
	}
	byID := make(map[string]routingTestCredential, len(body.Credentials))
	for _, credential := range body.Credentials {
		byID[credential.ID] = credential
	}
	return byID
}

func TestRoutingModelsListDisabledCredentialsLastModels(t *testing.T) {
	lastModels = lastModelsStore{}
	t.Cleanup(func() { lastModels = lastModelsStore{} })
	authDir := t.TempDir()
	manager := coreauth.NewManager(nil, nil, nil)
	ctx := context.Background()
	codex := &coreauth.Auth{ID: "codex-a.json", FileName: "codex-a.json", Provider: "codex", Status: coreauth.StatusActive}
	claude := &coreauth.Auth{ID: "claude-b.json", FileName: "claude-b.json", Provider: "claude", Disabled: true}
	for _, auth := range []*coreauth.Auth{codex, claude} {
		if _, errRegister := manager.Register(ctx, auth); errRegister != nil {
			t.Fatalf("register %s: %v", auth.ID, errRegister)
		}
	}
	reg := registry.GetGlobalRegistry()
	reg.RegisterClient(codex.ID, "codex", []*registry.ModelInfo{{ID: "gpt-6.1-sol"}, {ID: "gpt-6-luna"}})
	t.Cleanup(func() { reg.UnregisterClient(codex.ID) })
	h := NewHandlerWithoutConfigFilePath(&config.Config{AuthDir: authDir}, manager)

	got := getRoutingModels(t, h)
	served := []routingTestModel{{ID: "gpt-6-luna", Upstream: []string{"gpt-6-luna"}}, {ID: "gpt-6.1-sol", Upstream: []string{"gpt-6.1-sol"}}}
	if !reflect.DeepEqual(got[codex.ID].Models, served) || got[codex.ID].LastModels != nil {
		t.Fatalf("enabled codex = %+v, want its models and no last_models", got[codex.ID])
	}
	if got[claude.ID].LastModels == nil || len(got[claude.ID].LastModels) != 0 {
		t.Fatalf("disabled claude = %+v, want an empty last_models: it was never seen enabled", got[claude.ID])
	}

	// Disabling drops the models from the registry; a restart reloads the memory from disk.
	codex.Disabled = true
	if _, errUpdate := manager.Update(ctx, codex); errUpdate != nil {
		t.Fatalf("disable codex: %v", errUpdate)
	}
	reg.UnregisterClient(codex.ID)
	lastModels = lastModelsStore{}
	got = getRoutingModels(t, h)
	if len(got[codex.ID].Models) != 0 || !reflect.DeepEqual(got[codex.ID].LastModels, served) {
		t.Fatalf("disabled codex = %+v, want no models and last_models %+v", got[codex.ID], served)
	}

	// An enabled credential serving nothing is forgotten.
	codex.Disabled = false
	if _, errUpdate := manager.Update(ctx, codex); errUpdate != nil {
		t.Fatalf("enable codex: %v", errUpdate)
	}
	getRoutingModels(t, h)
	codex.Disabled = true
	if _, errUpdate := manager.Update(ctx, codex); errUpdate != nil {
		t.Fatalf("disable codex again: %v", errUpdate)
	}
	if last := getRoutingModels(t, h)[codex.ID].LastModels; len(last) != 0 {
		t.Fatalf("last_models after serving nothing = %+v, want none", last)
	}

	if _, errStat := os.Stat(filepath.Join(authDir, "routing", "last-models.yaml")); errStat != nil {
		t.Fatalf("memory file: %v", errStat)
	}
	jsonFiles, _ := filepath.Glob(filepath.Join(authDir, "*", "*.json"))
	if len(jsonFiles) != 0 {
		t.Fatalf("wrote %v; the auth store would load them as credentials", jsonFiles)
	}
}
