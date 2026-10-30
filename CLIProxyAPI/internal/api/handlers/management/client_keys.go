package management

import (
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/clientkeys"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
)

// GetClientKeys lists every client API key in config, in config order, with its policy,
// spend and last use, plus the profiles.
func (h *Handler) GetClientKeys(c *gin.Context) {
	svc := clientKeysService(c)
	if svc == nil {
		return
	}
	c.JSON(http.StatusOK, svc.Overview(h.configSnapshot().APIKeys))
}

// PutClientKey changes the settings of the client key with the id in the path.
func (h *Handler) PutClientKey(c *gin.Context) {
	svc := clientKeysService(c)
	if svc == nil {
		return
	}
	var body clientkeys.KeyUpdate
	if errBind := c.ShouldBindJSON(&body); errBind != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	view, errUpdate := svc.UpdateKey(h.configSnapshot().APIKeys, c.Param("id"), body)
	if errUpdate != nil {
		writeClientKeysError(c, errUpdate)
		return
	}
	c.JSON(http.StatusOK, view)
}

// PutClientKeyProfiles replaces the profile list and returns it with ids filled in.
func (h *Handler) PutClientKeyProfiles(c *gin.Context) {
	svc := clientKeysService(c)
	if svc == nil {
		return
	}
	var body struct {
		Profiles []clientkeys.Profile `json:"profiles"`
	}
	if errBind := c.ShouldBindJSON(&body); errBind != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	profiles, errReplace := svc.ReplaceProfiles(body.Profiles)
	if errReplace != nil {
		writeClientKeysError(c, errReplace)
		return
	}
	c.JSON(http.StatusOK, gin.H{"profiles": profiles})
}

// GetClientKeyPrices lists the price of every served model and every price override.
func (h *Handler) GetClientKeyPrices(c *gin.Context) {
	svc := clientKeysService(c)
	if svc == nil {
		return
	}
	c.JSON(http.StatusOK, svc.Prices(h.clientKeyServedModels()))
}

// PutClientKeyPrice sets a model's price override, or removes it when override is null.
func (h *Handler) PutClientKeyPrice(c *gin.Context) {
	svc := clientKeysService(c)
	if svc == nil {
		return
	}
	var body struct {
		Model    string            `json:"model"`
		Override *clientkeys.Price `json:"override"`
	}
	if errBind := c.ShouldBindJSON(&body); errBind != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	if errSet := svc.SetPriceOverride(body.Model, body.Override); errSet != nil {
		writeClientKeysError(c, errSet)
		return
	}
	c.JSON(http.StatusOK, svc.Prices(h.clientKeyServedModels()))
}

// RefreshClientKeyPrices downloads the imported price list now.
func (h *Handler) RefreshClientKeyPrices(c *gin.Context) {
	svc := clientKeysService(c)
	if svc == nil {
		return
	}
	if errRefresh := svc.RefreshPrices(c.Request.Context()); errRefresh != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": errRefresh.Error()})
		return
	}
	c.JSON(http.StatusOK, svc.Prices(h.clientKeyServedModels()))
}

// clientKeyServedModels maps every model an enabled credential serves to the providers serving it.
func (h *Handler) clientKeyServedModels() map[string][]string {
	served := make(map[string][]string)
	if h.authManager == nil {
		return served
	}
	reg := registry.GetGlobalRegistry()
	for _, auth := range h.authManager.List() {
		if auth.Disabled {
			continue
		}
		for _, model := range reg.GetModelsForClient(auth.ID) {
			if model == nil || strings.TrimSpace(model.ID) == "" || slices.Contains(served[model.ID], auth.Provider) {
				continue
			}
			served[model.ID] = append(served[model.ID], auth.Provider)
		}
	}
	return served
}

func clientKeysService(c *gin.Context) *clientkeys.Service {
	svc, errUnavailable := clientkeys.Current()
	switch {
	case errUnavailable != nil:
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": errUnavailable.Error()})
	case svc == nil:
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "client keys unavailable"})
	}
	return svc
}

func writeClientKeysError(c *gin.Context, err error) {
	var invalid *clientkeys.InvalidError
	switch {
	case errors.Is(err, clientkeys.ErrKeyNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
	case errors.As(err, &invalid):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
	}
}
