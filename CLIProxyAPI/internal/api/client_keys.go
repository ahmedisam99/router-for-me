package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/clientkeys"
)

// clientKeyRealtimeDenied refuses a realtime client secret whose issuing client key is now
// switched off or over budget, in the realtime error format, and reports whether it did.
func clientKeyRealtimeDenied(c *gin.Context, principal string) bool {
	errAdmit := clientkeys.Admit(principal)
	if errAdmit == nil {
		return false
	}
	closeUnconsumedRequestOnAbort(c)
	errorType := "invalid_request_error"
	if errAdmit.HTTPStatusCode() >= http.StatusInternalServerError {
		errorType = "server_error"
	}
	c.AbortWithStatusJSON(errAdmit.HTTPStatusCode(), gin.H{"error": gin.H{
		"message": errAdmit.Message,
		"type":    errorType,
		"param":   nil,
		"code":    string(errAdmit.Code),
	}})
	return true
}
