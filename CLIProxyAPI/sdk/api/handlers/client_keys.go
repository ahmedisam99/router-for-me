package handlers

import (
	"errors"
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/clientkeys"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/interfaces"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/thinking"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/util"
	coreusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
	"github.com/tidwall/gjson"
	"golang.org/x/net/context"
)

// clientKeyModel applies the calling client key's policy before model routing. It returns
// the model and body to route, rewritten by a redirect, or the error for a switched-off or
// over-budget key or a blocked model. Internal executions from plugins are exempt.
func (h *BaseAPIHandler) clientKeyModel(ctx context.Context, format, modelName string, rawJSON []byte, execOptions modelExecutionOptions) (string, []byte, *interfaces.ErrorMessage) {
	key := coreusage.APIKeyFromContext(ctx)
	if execOptions.InternalSource || key == "" || !clientkeys.Enforced() {
		return modelName, rawJSON, nil
	}
	model, body, rejection := clientkeys.Route(key, h.clientKeyResolveAuto(modelName), format, rawJSON, h.clientKeyUpstreamModels)
	if rejection != nil {
		return modelName, rawJSON, clientKeyError(rejection)
	}
	return model, body, nil
}

// RejectClientKeyTurn checks a websocket follow-up turn that goes upstream without model
// routing, on a session that ran sessionBody for sessionModel, against the client key's policy.
func (h *BaseAPIHandler) RejectClientKeyTurn(key, format, sessionModel string, sessionBody, turn []byte) *interfaces.ErrorMessage {
	if key == "" || !clientkeys.Enforced() {
		return nil
	}
	turnModel := strings.TrimSpace(gjson.GetBytes(turn, "model").String())
	if turnModel == "" {
		turnModel = sessionModel
	}
	if rejection := clientkeys.RejectTurn(key, format, h.clientKeyResolveAuto(sessionModel), sessionBody, h.clientKeyResolveAuto(turnModel), turn, h.clientKeyUpstreamModels); rejection != nil {
		return clientKeyError(rejection)
	}
	return nil
}

// clientKeyResolveAuto resolves the "auto" model as routing does, keeping its suffix, so
// rules see the model that runs.
func (h *BaseAPIHandler) clientKeyResolveAuto(model string) string {
	parsed := thinking.ParseSuffix(model)
	if parsed.ModelName != "auto" || (h != nil && h.AuthManager != nil && h.AuthManager.HomeEnabled()) {
		return model
	}
	resolved := util.ResolveAutoModel(parsed.ModelName)
	if parsed.HasSuffix {
		return resolved + "(" + parsed.RawSuffix + ")"
	}
	return resolved
}

func (h *BaseAPIHandler) clientKeyUpstreamModels(model string) []string {
	if h == nil || h.AuthManager == nil {
		return nil
	}
	return h.AuthManager.UpstreamModelsForModel(model)
}

func clientKeyError(rejection *clientkeys.Rejection) *interfaces.ErrorMessage {
	return &interfaces.ErrorMessage{StatusCode: rejection.Status, Error: errors.New(rejection.Message)}
}

func clientKeyErrorChannel(errMsg *interfaces.ErrorMessage) <-chan *interfaces.ErrorMessage {
	errChan := make(chan *interfaces.ErrorMessage, 1)
	errChan <- errMsg
	close(errChan)
	return errChan
}
