package handlers

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/clientkeys"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/interfaces"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	coreexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	coreusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
	sdkconfig "github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)

// clientKeyCaptureExecutor also captures token counts.
type clientKeyCaptureExecutor struct {
	*modelExecutionCaptureExecutor
}

func (e clientKeyCaptureExecutor) CountTokens(_ context.Context, _ *coreauth.Auth, req coreexecutor.Request, opts coreexecutor.Options) (coreexecutor.Response, error) {
	e.capture(req, opts)
	return coreexecutor.Response{Payload: []byte(`{"input_tokens":0}`)}, nil
}

// newClientKeyHandler serves models, by default claude-opus-5-5, claude-fable-5 and
// new-model, with sk-sib on a profile that blocks Fable, runs Opus at high effort instead of
// xhigh or max and sends old-model to new-model. sk-off is switched off.
func newClientKeyHandler(t *testing.T, models ...string) (*BaseAPIHandler, clientKeyCaptureExecutor) {
	t.Helper()
	if len(models) == 0 {
		models = []string{"claude-opus-5-5", "claude-fable-5", "new-model"}
	}
	svc, errOpen := clientkeys.Open(t.TempDir(), clientkeys.Options{Fetch: func(context.Context, string) ([]byte, error) {
		return nil, errors.New("offline")
	}})
	if errOpen != nil {
		t.Fatalf("clientkeys.Open() error = %v", errOpen)
	}
	t.Cleanup(svc.Close)
	keys := []string{"sk-sib", "sk-off"}
	if _, errProfiles := svc.ReplaceProfiles([]clientkeys.Profile{{ID: "siblings", Name: "Siblings", Rules: []clientkeys.Rule{
		{Models: []string{"claude-fable-*"}, Action: clientkeys.ActionBlock},
		{Models: []string{"claude-opus-5-5"}, Efforts: []string{"xhigh", "max"}, Action: clientkeys.ActionRedirect, RedirectEffort: "high"},
		{Models: []string{"old-model"}, Action: clientkeys.ActionRedirect, RedirectModel: "new-model"},
	}}}); errProfiles != nil {
		t.Fatalf("ReplaceProfiles() error = %v", errProfiles)
	}
	profile, off := "siblings", false
	if _, errUpdate := svc.UpdateKey(keys, clientkeys.KeyID("sk-sib"), clientkeys.KeyUpdate{Profile: &profile}); errUpdate != nil {
		t.Fatalf("UpdateKey() error = %v", errUpdate)
	}
	if _, errUpdate := svc.UpdateKey(keys, clientkeys.KeyID("sk-off"), clientkeys.KeyUpdate{Enabled: &off}); errUpdate != nil {
		t.Fatalf("UpdateKey() error = %v", errUpdate)
	}
	clientkeys.SetDefault(svc)
	t.Cleanup(func() { clientkeys.SetDefault(nil) })

	executor := clientKeyCaptureExecutor{&modelExecutionCaptureExecutor{
		stream: func(context.Context, *coreauth.Auth, coreexecutor.Request, coreexecutor.Options) (*coreexecutor.StreamResult, error) {
			chunks := make(chan coreexecutor.StreamChunk, 1)
			chunks <- coreexecutor.StreamChunk{Payload: []byte("stream-one")}
			close(chunks)
			return &coreexecutor.StreamResult{Chunks: chunks}, nil
		},
	}}
	manager := coreauth.NewManager(nil, nil, nil)
	manager.RegisterExecutor(executor)
	auth := &coreauth.Auth{ID: "client-keys-auth", Provider: executor.Identifier(), Status: coreauth.StatusActive}
	if _, errRegister := manager.Register(context.Background(), auth); errRegister != nil {
		t.Fatalf("manager.Register(): %v", errRegister)
	}
	infos := make([]*registry.ModelInfo, 0, len(models))
	for _, model := range models {
		infos = append(infos, &registry.ModelInfo{ID: model})
	}
	registry.GetGlobalRegistry().RegisterClient(auth.ID, auth.Provider, infos)
	t.Cleanup(func() { registry.GetGlobalRegistry().UnregisterClient(auth.ID) })
	return NewBaseAPIHandlers(&sdkconfig.SDKConfig{}, manager), executor
}

func TestClientKeyPolicyRewritesModelBeforeRouting(t *testing.T) {
	handler, executor := newClientKeyHandler(t)
	ctx := coreusage.WithAPIKey(context.Background(), "sk-sib")
	tests := []struct {
		name, model, body, want string
	}{
		{"body effort", "claude-opus-5-5", `{"model":"claude-opus-5-5","reasoning_effort":"xhigh"}`, "claude-opus-5-5(high)"},
		{"suffix effort", "claude-opus-5-5(max)", `{"model":"claude-opus-5-5(max)"}`, "claude-opus-5-5(high)"},
		{"allowed effort", "claude-opus-5-5", `{"model":"claude-opus-5-5","reasoning_effort":"low"}`, "claude-opus-5-5"},
		{"model redirect to a served model", "old-model(low)", `{"model":"old-model(low)"}`, "new-model(low)"},
	}
	run := map[string]func(model, body string) error{
		"execute": func(model, body string) error {
			_, _, errMsg := handler.ExecuteWithAuthManager(ctx, "openai", model, []byte(body), "")
			return errorOf(errMsg)
		},
		"stream": func(model, body string) error {
			data, _, errs := handler.ExecuteStreamWithAuthManager(ctx, "openai", model, []byte(body), "")
			if data == nil {
				return errorOf(<-errs)
			}
			for range data {
			}
			for errMsg := range errs {
				return errorOf(errMsg)
			}
			return nil
		},
		"count": func(model, body string) error {
			_, _, errMsg := handler.ExecuteCountWithAuthManager(ctx, "openai", model, []byte(body), "")
			return errorOf(errMsg)
		},
	}
	for path, execute := range run {
		for _, tt := range tests {
			t.Run(path+"/"+tt.name, func(t *testing.T) {
				if errExecute := execute(tt.model, tt.body); errExecute != nil {
					t.Fatalf("execution error = %v", errExecute)
				}
				req, opts := executor.captured()
				if req.Model != tt.want {
					t.Fatalf("executor model = %q, want %q", req.Model, tt.want)
				}
				if path != "count" && opts.Metadata[coreexecutor.RequestedModelMetadataKey] != tt.model {
					t.Fatalf("requested model = %v, want the client's %q", opts.Metadata[coreexecutor.RequestedModelMetadataKey], tt.model)
				}
			})
		}
	}
}

func TestClientKeyPolicyRejectsBeforeRouting(t *testing.T) {
	handler, executor := newClientKeyHandler(t)
	tests := []struct {
		name, key, model string
		wantStatus       int
		wantMessage      string
	}{
		{"blocked model", "sk-sib", "claude-fable-5", http.StatusForbidden, "Model claude-fable-5 is not allowed for this API key"},
		// No credential serves it: a 403 rather than an unknown-model error shows the check runs first.
		{"blocked unserved model", "sk-sib", "claude-fable-5-1(high)", http.StatusForbidden, "Model claude-fable-5-1 is not allowed for this API key"},
		{"switched-off key", "sk-off", "claude-opus-5-5", http.StatusForbidden, "This API key is switched off"},
	}
	for _, tt := range tests {
		ctx := coreusage.WithAPIKey(context.Background(), tt.key)
		body := []byte(`{"model":"` + tt.model + `"}`)
		_, _, errExecute := handler.ExecuteWithAuthManager(ctx, "openai", tt.model, body, "")
		data, _, errs := handler.ExecuteStreamWithAuthManager(ctx, "openai", tt.model, body, "")
		if data != nil {
			t.Fatalf("%s: stream returned a data channel", tt.name)
		}
		errStream := <-errs
		_, _, errCount := handler.ExecuteCountWithAuthManager(ctx, "openai", tt.model, body, "")
		for path, errMsg := range map[string]*interfaces.ErrorMessage{"execute": errExecute, "stream": errStream, "count": errCount} {
			if errMsg == nil || errMsg.StatusCode != tt.wantStatus || errMsg.Error == nil || errMsg.Error.Error() != tt.wantMessage {
				t.Fatalf("%s/%s: error = %+v, want %d %q", tt.name, path, errMsg, tt.wantStatus, tt.wantMessage)
			}
		}
	}
	if req, _ := executor.captured(); req.Model != "" {
		t.Fatalf("executor ran %q for a rejected request", req.Model)
	}
}

func TestClientKeyPolicySkipsInternalExecutions(t *testing.T) {
	handler, executor := newClientKeyHandler(t)
	ctx := coreusage.WithAPIKey(context.Background(), "sk-sib")
	_, errMsg := handler.ExecuteModel(ctx, ModelExecutionRequest{
		EntryProtocol: "openai",
		ExitProtocol:  "openai",
		Model:         "claude-fable-5",
		Body:          []byte(`{"model":"claude-fable-5"}`),
	})
	if errMsg != nil {
		t.Fatalf("ExecuteModel() error = %+v, want plugin callbacks exempt", errMsg)
	}
	if req, _ := executor.captured(); req.Model != "claude-fable-5" {
		t.Fatalf("executor model = %q, want claude-fable-5", req.Model)
	}
}

func TestClientKeyPolicyChecksNestedClaudeModels(t *testing.T) {
	handler, executor := newClientKeyHandler(t)
	ctx := coreusage.WithAPIKey(context.Background(), "sk-sib")
	body := `{"model":"claude-opus-5-5","tools":[{"type":"advisor_20260301","name":"advisor","model":"claude-fable-5"}]}`
	_, _, errMsg := handler.ExecuteWithAuthManager(ctx, "claude", "claude-opus-5-5", []byte(body), "")
	if errMsg == nil || errMsg.StatusCode != http.StatusForbidden || errMsg.Error.Error() != "Model claude-fable-5 is not allowed for this API key" {
		t.Fatalf("error = %+v, want 403 naming the advisor model", errMsg)
	}
	if req, _ := executor.captured(); req.Model != "" {
		t.Fatalf("executor ran %q for a request with a blocked advisor", req.Model)
	}
}

func TestClientKeyEffortRedirectStripsConfigurationUpdates(t *testing.T) {
	handler, executor := newClientKeyHandler(t)
	ctx := coreusage.WithAPIKey(context.Background(), "sk-sib")
	body := `{"model":"claude-opus-5-5","input":[{"type":"configuration_update","reasoning":{"effort":"max"}},{"type":"message","role":"user","content":"hi"}]}`
	if _, _, errMsg := handler.ExecuteWithAuthManager(ctx, "openai-response", "claude-opus-5-5", []byte(body), ""); errMsg != nil {
		t.Fatalf("ExecuteWithAuthManager() error = %+v", errMsg)
	}
	req, _ := executor.captured()
	if req.Model != "claude-opus-5-5(high)" || strings.Contains(string(req.Payload), "configuration_update") {
		t.Fatalf("executor got %q with %s, want claude-opus-5-5(high) without configuration updates", req.Model, req.Payload)
	}
}

func TestRejectClientKeyTurn(t *testing.T) {
	handler, _ := newClientKeyHandler(t)
	session := []byte(`{"model":"claude-opus-5-5","reasoning":{"effort":"xhigh"}}`)
	medium := []byte(`{"model":"claude-opus-5-5","reasoning":{"effort":"medium"}}`)
	turn := func(key string, sessionBody []byte, payload string) *interfaces.ErrorMessage {
		return handler.RejectClientKeyTurn(key, "openai-response", "claude-opus-5-5", sessionBody, []byte(payload))
	}
	if errMsg := turn("sk-sib", medium, `{"type":"response.create","model":"claude-fable-5"}`); errMsg == nil || errMsg.StatusCode != http.StatusForbidden {
		t.Fatalf("blocked model = %+v, want 403", errMsg)
	}
	if errMsg := turn("sk-off", medium, `{"model":"claude-opus-5-5"}`); errMsg == nil || errMsg.StatusCode != http.StatusForbidden {
		t.Fatalf("switched-off key = %+v, want 403", errMsg)
	}
	// The session already runs at high: the executor applies its suffix to the turn.
	if errMsg := turn("sk-sib", session, `{"model":"claude-opus-5-5","reasoning":{"effort":"xhigh"}}`); errMsg != nil {
		t.Fatalf("redirect the session carries = %+v, want a pass", errMsg)
	}
	if errMsg := turn("sk-sib", medium, `{"reasoning":{"effort":"max"}}`); errMsg == nil || errMsg.StatusCode != http.StatusForbidden {
		t.Fatalf("redirect the session lacks = %+v, want 403", errMsg)
	}
}

func TestClientKeyPolicyResolvesAuto(t *testing.T) {
	handler, executor := newClientKeyHandler(t, "claude-fable-5")
	ctx := coreusage.WithAPIKey(context.Background(), "sk-sib")
	_, _, errMsg := handler.ExecuteWithAuthManager(ctx, "openai", "auto(high)", []byte(`{"model":"auto(high)"}`), "")
	if errMsg == nil || errMsg.StatusCode != http.StatusForbidden || errMsg.Error.Error() != "Model claude-fable-5 is not allowed for this API key" {
		t.Fatalf("auto = %+v, want 403 for the model it resolves to", errMsg)
	}
	if req, _ := executor.captured(); req.Model != "" {
		t.Fatalf("executor ran %q", req.Model)
	}
	if errMsg := handler.RejectClientKeyTurn("sk-sib", "openai-response", "claude-opus-5-5", nil, []byte(`{"model":"auto"}`)); errMsg == nil || errMsg.StatusCode != http.StatusForbidden {
		t.Fatalf("auto turn = %+v, want 403", errMsg)
	}
}

func errorOf(errMsg *interfaces.ErrorMessage) error {
	if errMsg == nil {
		return nil
	}
	if errMsg.Error != nil {
		return errMsg.Error
	}
	return errors.New(http.StatusText(errMsg.StatusCode))
}
