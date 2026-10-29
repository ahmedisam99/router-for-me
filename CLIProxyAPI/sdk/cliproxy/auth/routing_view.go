package auth

import "strings"

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

// Priority returns the priority the selector ranks auth by; higher is picked first.
func Priority(auth *Auth) int {
	return authPriority(auth)
}
