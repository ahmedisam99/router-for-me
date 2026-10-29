package management

import (
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// GetRoutingModels lists every runtime credential, config API keys included, with
// the model IDs it serves and the upstream models each resolves to. Credentials
// come in fill-first pick order: priority descending, then ID ascending.
func (h *Handler) GetRoutingModels(c *gin.Context) {
	if h == nil || h.authManager == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "auth manager unavailable"})
		return
	}
	reg := registry.GetGlobalRegistry()
	now := time.Now().UTC()
	auths := h.authManager.List()
	sort.SliceStable(auths, func(i, j int) bool {
		pi, pj := coreauth.Priority(auths[i]), coreauth.Priority(auths[j])
		if pi != pj {
			return pi > pj
		}
		return auths[i].ID < auths[j].ID
	})

	credentials := make([]gin.H, 0, len(auths))
	for _, auth := range auths {
		auth.EnsureIndex()
		unavailable, status, statusMessage, nextRetryAfter := reconcileAuthFileCooldownState(auth, now)
		models := make([]gin.H, 0)
		for _, model := range reg.GetModelsForClient(auth.ID) {
			if model == nil || strings.TrimSpace(model.ID) == "" {
				continue
			}
			models = append(models, gin.H{
				"id":       model.ID,
				"upstream": h.authManager.UpstreamModels(auth, model.ID),
			})
		}
		sort.Slice(models, func(i, j int) bool {
			return models[i]["id"].(string) < models[j]["id"].(string)
		})
		entry := gin.H{
			"id":              auth.ID,
			"auth_index":      auth.Index,
			"name":            strings.TrimSpace(auth.FileName),
			"provider":        strings.TrimSpace(auth.Provider),
			"label":           auth.Label,
			"kind":            auth.AuthKind(),
			"source":          auth.AuthSourceKind(),
			"priority":        coreauth.Priority(auth),
			"disabled":        auth.Disabled,
			"status":          status,
			"status_message":  statusMessage,
			"unavailable":     unavailable,
			"models":          models,
			"recent_requests": auth.RecentRequestsSnapshot(now),
		}
		if !nextRetryAfter.IsZero() {
			entry["next_retry_after"] = nextRetryAfter
		}
		credentials = append(credentials, entry)
	}
	c.JSON(http.StatusOK, gin.H{"credentials": credentials})
}
