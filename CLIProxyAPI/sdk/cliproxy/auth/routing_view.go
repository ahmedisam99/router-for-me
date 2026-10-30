package auth

import (
	"slices"
	"strings"
)

// UpstreamModels returns the upstream models a request for routeModel reaches on
// auth, mirroring executionModelCandidatesWithAlias. Pools come back in config
// order and the pool cursor is never advanced, so read-only views can call it.
func (m *Manager) UpstreamModels(auth *Auth, routeModel string) []string {
	if auth != nil && auth.Attributes != nil {
		if homeModel := strings.TrimSpace(auth.Attributes[homeUpstreamModelAttributeKey]); homeModel != "" {
			return []string{homeModel}
		}
	}
	routing := m.loadAPIKeyModelRouting()
	requestedModel := rewriteModelForAuth(routeModel, auth)
	aliasResult := m.resolveExecutionAliasResultForRequestedWithRouting(routing, auth, requestedModel)
	upstreamModel := executionAliasPoolModel(auth, requestedModel, aliasResult)
	if pool := resolveOpenAICompatUpstreamModelPool(routing.config, auth, upstreamModel); len(pool) > 0 {
		return pool
	}
	resolved := m.applyAPIKeyModelAliasWithRouting(routing, auth, upstreamModel)
	if strings.TrimSpace(resolved) == "" {
		resolved = upstreamModel
	}
	return []string{resolved}
}

// UpstreamModelsForModel returns the upstream models a request for model reaches on any
// enabled credential serving it, deduplicated, in no particular order. A prefixed model no
// credential serves falls back to its unprefixed form, as native tool search does.
func (m *Manager) UpstreamModelsForModel(model string) []string {
	model = strings.TrimSpace(model)
	if m == nil || model == "" {
		return nil
	}
	auths := m.List()
	serving := nativeToolSearchServingAuths(auths, model)
	if len(serving) == 0 {
		if slash := strings.Index(model, "/"); slash >= 0 {
			model = strings.TrimSpace(model[slash+1:])
			serving = nativeToolSearchServingAuths(auths, model)
		}
	}
	var upstreams []string
	for _, auth := range serving {
		for _, upstream := range m.UpstreamModels(auth, model) {
			if !slices.Contains(upstreams, upstream) {
				upstreams = append(upstreams, upstream)
			}
		}
	}
	return upstreams
}

// Priority returns the priority the selector ranks auth by; higher is picked first.
func Priority(auth *Auth) int {
	return authPriority(auth)
}
