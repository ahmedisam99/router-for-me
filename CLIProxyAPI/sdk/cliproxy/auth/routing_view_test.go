package auth

import (
	"reflect"
	"testing"

	internalconfig "github.com/router-for-me/CLIProxyAPI/v8/internal/config"
)

// TestUpstreamModelsMatchesExecution walks every branch of
// executionModelCandidatesWithAlias, so a sync that changes it fails here.
func TestUpstreamModelsMatchesExecution(t *testing.T) {
	cfg := &internalconfig.Config{
		ClaudeKey: []internalconfig.ClaudeKey{{
			APIKey: "key-a",
			Prefix: "tenant",
			Models: []internalconfig.ClaudeModel{{Name: "real-upstream", Alias: "public"}},
		}},
		OpenAICompatibility: []internalconfig.OpenAICompatibility{{
			Name:    "compat",
			BaseURL: "https://example.com/v1",
			Models: []internalconfig.OpenAICompatibilityModel{
				{Name: "solo-upstream", Alias: "solo"},
				{Name: "first-upstream", Alias: "public"},
				{Name: "second-upstream", Alias: "public"},
				{Name: "third-upstream", Alias: "public"},
			},
		}},
	}
	oauthAliases := map[string][]internalconfig.OAuthModelAlias{"codex": {
		{Name: "gpt-6.1-sol", Alias: "claude-opus-5-5", Fork: true},
		{Name: "gpt-6.1-terra", Alias: "terra", ForceMapping: true},
	}}

	tests := []struct {
		name  string
		auth  *Auth
		route string
		want  []string
	}{
		{
			name:  "home upstream model wins over alias",
			auth:  codexOAuthTestAuth(map[string]string{homeUpstreamModelAttributeKey: "home-upstream"}),
			route: "claude-opus-5-5",
			want:  []string{"home-upstream"},
		},
		{
			name: "home force mapping skips OAuth alias",
			auth: codexOAuthTestAuth(map[string]string{
				homeForceMappingAttributeKey:  "true",
				homeOriginalAliasAttributeKey: "claude-opus-5-5",
			}),
			route: "claude-opus-5-5",
			want:  []string{"claude-opus-5-5"},
		},
		{
			name: "home force mapping for another model keeps OAuth alias",
			auth: codexOAuthTestAuth(map[string]string{
				homeForceMappingAttributeKey:  "true",
				homeOriginalAliasAttributeKey: "other-model",
			}),
			route: "claude-opus-5-5",
			want:  []string{"gpt-6.1-sol"},
		},
		{
			name:  "API-key alias behind prefix",
			auth:  configuredCapabilityTestAuth("auth-a", "key-a"),
			route: "tenant/public",
			want:  []string{"real-upstream"},
		},
		{
			name:  "API-key alias keeps thinking suffix",
			auth:  configuredCapabilityTestAuth("auth-a", "key-a"),
			route: "tenant/public(high)",
			want:  []string{"real-upstream(high)"},
		},
		{
			name:  "API-key unknown model passes through",
			auth:  configuredCapabilityTestAuth("auth-a", "key-a"),
			route: "tenant/other",
			want:  []string{"other"},
		},
		{
			name:  "OAuth alias",
			auth:  codexOAuthTestAuth(nil),
			route: "claude-opus-5-5",
			want:  []string{"gpt-6.1-sol"},
		},
		{
			name:  "OAuth unknown model keeps its spacing",
			auth:  codexOAuthTestAuth(nil),
			route: " other",
			want:  []string{" other"},
		},
		{
			name:  "OAuth upstream name",
			auth:  codexOAuthTestAuth(nil),
			route: "gpt-6.1-sol",
			want:  []string{"gpt-6.1-sol"},
		},
		{
			name:  "OAuth force-mapped alias",
			auth:  codexOAuthTestAuth(nil),
			route: "terra",
			want:  []string{"gpt-6.1-terra"},
		},
		{
			name: "OAuth per-credential alias",
			auth: codexOAuthTestAuth(map[string]string{
				oauthModelAliasesAttributeKey: `[{"name":"gpt-6.1-luna","alias":"luna"}]`,
			}),
			route: "luna",
			want:  []string{"gpt-6.1-luna"},
		},
		{
			name:  "OpenAI-compat single alias",
			auth:  compatTestAuth(),
			route: "solo",
			want:  []string{"solo-upstream"},
		},
		{
			name:  "OpenAI-compat unknown model passes through",
			auth:  compatTestAuth(),
			route: "other",
			want:  []string{"other"},
		},
		{
			name:  "OpenAI-compat pool in config order",
			auth:  compatTestAuth(),
			route: "public",
			want:  []string{"first-upstream", "second-upstream", "third-upstream"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			manager := NewManager(nil, nil, nil)
			manager.SetConfig(cfg)
			manager.SetOAuthModelAlias(oauthAliases)
			registerCapabilityTestAuth(t, manager, tt.auth)

			assertUpstreamModelsMatchExecution(t, manager, tt.auth, tt.route, tt.want)
		})
	}
}

func TestUpstreamModelsListsPoolWithoutAdvancingIt(t *testing.T) {
	manager := NewManager(nil, nil, nil)
	manager.SetConfig(&internalconfig.Config{OpenAICompatibility: []internalconfig.OpenAICompatibility{{
		Name:    "pool",
		BaseURL: "https://example.com/v1",
		Models: []internalconfig.OpenAICompatibilityModel{
			{Name: "first-upstream", Alias: "public"},
			{Name: "second-upstream", Alias: "public"},
		},
	}}})
	auth := &Auth{
		ID:       "auth-pool",
		Provider: "openai-compatibility:pool",
		Attributes: map[string]string{
			AttributeSource: "config:pool[0]",
			"compat_name":   "pool",
			"provider_key":  "openai-compatibility:pool",
		},
	}
	registerCapabilityTestAuth(t, manager, auth)

	before, _, _, _ := manager.executionModelCandidatesWithAlias(auth, "public")
	for range 3 {
		if got := manager.UpstreamModels(auth, "public"); !reflect.DeepEqual(got, []string{"first-upstream", "second-upstream"}) {
			t.Fatalf("UpstreamModels() = %v, want the pool in config order", got)
		}
	}
	after, _, _, _ := manager.executionModelCandidatesWithAlias(auth, "public")
	if before[0] == after[0] {
		t.Fatalf("pool cursor moved: execution picked %q twice in a row", after[0])
	}
}

// assertUpstreamModelsMatchExecution accepts any rotation of the pool from
// execution, since its cursor decides where the pool starts.
func assertUpstreamModelsMatchExecution(t *testing.T, manager *Manager, auth *Auth, routeModel string, want []string) {
	t.Helper()
	got := manager.UpstreamModels(auth, routeModel)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("UpstreamModels(%q) = %v, want %v", routeModel, got, want)
	}
	executed, _, _, _ := manager.executionModelCandidatesWithAlias(auth, routeModel)
	for offset := range got {
		if reflect.DeepEqual(rotateStrings(got, offset), executed) {
			return
		}
	}
	t.Fatalf("UpstreamModels(%q) = %v, execution resolves %v", routeModel, got, executed)
}

func codexOAuthTestAuth(attributes map[string]string) *Auth {
	auth := &Auth{
		ID:         "codex-a.json",
		Provider:   "codex",
		Attributes: map[string]string{AttributeAuthKind: AuthKindOAuth},
	}
	for key, value := range attributes {
		auth.Attributes[key] = value
	}
	return auth
}

func compatTestAuth() *Auth {
	return &Auth{
		ID:       "auth-compat",
		Provider: "openai-compatibility:compat",
		Attributes: map[string]string{
			AttributeSource: "config:compat[0]",
			AttributeAPIKey: "compat-key",
			"compat_name":   "compat",
			"provider_key":  "openai-compatibility:compat",
		},
	}
}
