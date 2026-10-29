// Command usage-stats is a CLIProxyAPI plugin that keeps every upstream attempt's usage
// record on disk and serves an hourly rollup at GET /v0/management/usage-stats.
package main

/*
#include <stdint.h>
#include <stdlib.h>

typedef struct {
	void* ptr;
	size_t len;
} cliproxy_buffer;

typedef struct {
	uint32_t abi_version;
	void* host_ctx;
	void* call;
	void* free_buffer;
} cliproxy_host_api;

typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);

typedef struct {
	uint32_t abi_version;
	cliproxy_plugin_call_fn call;
	cliproxy_plugin_free_fn free_buffer;
	cliproxy_plugin_shutdown_fn shutdown;
} cliproxy_plugin_api;

extern int cliproxyPluginCall(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void cliproxyPluginFree(void*, size_t);
extern void cliproxyPluginShutdown(void);
*/
import "C"

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
	"gopkg.in/yaml.v3"
)

const (
	routePath            = "/usage-stats"
	defaultRetentionDays = 90
	queueSize            = 4096
)

var (
	stateMu    sync.Mutex
	current    *store
	queue      = make(chan entry, queueSize)
	workerOnce sync.Once
	dropped    atomic.Int64
)

type envelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *envelopeError  `json:"error,omitempty"`
}

type envelopeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type lifecycleRequest struct {
	ConfigYAML []byte `json:"config_yaml"`
}

type pluginConfig struct {
	DataDir       string `yaml:"data_dir"`
	RetentionDays int    `yaml:"retention_days"`
}

type registration struct {
	SchemaVersion uint32                 `json:"schema_version"`
	Metadata      pluginapi.Metadata     `json:"metadata"`
	Capabilities  registrationCapability `json:"capabilities"`
}

type registrationCapability struct {
	UsagePlugin   bool `json:"usage_plugin"`
	ManagementAPI bool `json:"management_api"`
}

type managementRegistration struct {
	Routes []pluginapi.ManagementRoute `json:"routes"`
}

func main() {}

//export cliproxy_plugin_init
func cliproxy_plugin_init(_ *C.cliproxy_host_api, plugin *C.cliproxy_plugin_api) C.int {
	if plugin == nil {
		return 1
	}
	plugin.abi_version = C.uint32_t(pluginabi.ABIVersion)
	plugin.call = C.cliproxy_plugin_call_fn(C.cliproxyPluginCall)
	plugin.free_buffer = C.cliproxy_plugin_free_fn(C.cliproxyPluginFree)
	plugin.shutdown = C.cliproxy_plugin_shutdown_fn(C.cliproxyPluginShutdown)
	return 0
}

//export cliproxyPluginCall
func cliproxyPluginCall(method *C.char, request *C.uint8_t, requestLen C.size_t, response *C.cliproxy_buffer) C.int {
	if response != nil {
		response.ptr = nil
		response.len = 0
	}
	if method == nil {
		writeResponse(response, errorEnvelope("invalid_method", "method is required"))
		return 1
	}
	var requestBytes []byte
	if request != nil && requestLen > 0 {
		requestBytes = C.GoBytes(unsafe.Pointer(request), C.int(requestLen))
	}
	raw, errHandle := handleMethod(C.GoString(method), requestBytes)
	if errHandle != nil {
		writeResponse(response, errorEnvelope("plugin_error", errHandle.Error()))
		return 1
	}
	writeResponse(response, raw)
	return 0
}

//export cliproxyPluginFree
func cliproxyPluginFree(ptr unsafe.Pointer, len C.size_t) {
	if ptr != nil {
		C.free(ptr)
	}
}

//export cliproxyPluginShutdown
func cliproxyPluginShutdown() {
	shutdown()
}

func handleMethod(method string, request []byte) ([]byte, error) {
	switch method {
	case pluginabi.MethodPluginRegister, pluginabi.MethodPluginReconfigure:
		if errConfigure := configure(request); errConfigure != nil {
			return nil, errConfigure
		}
		return okEnvelope(pluginRegistration())
	case pluginabi.MethodPluginShutdown:
		shutdown()
		return okEnvelope(struct{}{})
	case pluginabi.MethodUsageHandle:
		return handleUsage(request)
	case pluginabi.MethodManagementRegister:
		return okEnvelope(managementRegistration{Routes: []pluginapi.ManagementRoute{{Method: http.MethodGet, Path: routePath}}})
	case pluginabi.MethodManagementHandle:
		return handleManagement(request)
	default:
		return errorEnvelope("unknown_method", "unknown method: "+method), nil
	}
}

// configure opens the store for the configured data dir, or only updates retention
// when the dir is unchanged.
func configure(raw []byte) error {
	var req lifecycleRequest
	if len(raw) > 0 {
		if errUnmarshal := json.Unmarshal(raw, &req); errUnmarshal != nil {
			return errUnmarshal
		}
	}
	var cfg pluginConfig
	if len(req.ConfigYAML) > 0 {
		if errUnmarshal := yaml.Unmarshal(req.ConfigYAML, &cfg); errUnmarshal != nil {
			return errUnmarshal
		}
	}
	if cfg.RetentionDays <= 0 {
		cfg.RetentionDays = defaultRetentionDays
	}
	dir, errDir := resolveDataDir(cfg.DataDir)
	if errDir != nil {
		return errDir
	}

	stateMu.Lock()
	defer stateMu.Unlock()
	if current != nil && current.dir == dir {
		current.mu.Lock()
		current.retentionDays = cfg.RetentionDays
		current.mu.Unlock()
	} else {
		next, errOpen := openStore(dir, cfg.RetentionDays, time.Now)
		if errOpen != nil {
			return errOpen
		}
		if current != nil {
			current.close()
		}
		current = next
	}
	workerOnce.Do(func() { go work() })
	return nil
}

// resolveDataDir defaults to plugins/usage-stats under the backend's default auth dir.
func resolveDataDir(dir string) (string, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		dir = "~/.cli-proxy-api/plugins/usage-stats"
	}
	if rest, ok := strings.CutPrefix(dir, "~"); ok {
		home, errHome := os.UserHomeDir()
		if errHome != nil {
			return "", fmt.Errorf("resolve data dir: %w", errHome)
		}
		dir = filepath.Join(home, rest)
	}
	return filepath.Clean(dir), nil
}

func currentStore() *store {
	stateMu.Lock()
	defer stateMu.Unlock()
	return current
}

// work persists queued entries, off the host's single usage dispatch goroutine.
func work() {
	for e := range queue {
		if s := currentStore(); s != nil {
			s.add(e)
		}
	}
}

func handleUsage(raw []byte) ([]byte, error) {
	var record pluginapi.UsageRecord
	if errUnmarshal := json.Unmarshal(raw, &record); errUnmarshal != nil {
		return nil, errUnmarshal
	}
	select {
	case queue <- entryFromRecord(record, time.Now()):
	default:
		if n := dropped.Add(1); n%1000 == 1 {
			logf("queue full, %d records dropped so far", n)
		}
	}
	return okEnvelope(struct{}{})
}

func handleManagement(raw []byte) ([]byte, error) {
	var req pluginapi.ManagementRequest
	if errUnmarshal := json.Unmarshal(raw, &req); errUnmarshal != nil {
		return nil, errUnmarshal
	}
	to := time.Now().Unix()
	from := to - 24*hourSeconds
	var errParse error
	if v := req.Query.Get("to"); v != "" {
		if to, errParse = strconv.ParseInt(v, 10, 64); errParse != nil {
			return jsonResponse(http.StatusBadRequest, map[string]string{"error": "invalid to"})
		}
		from = to - 24*hourSeconds
	}
	if v := req.Query.Get("from"); v != "" {
		if from, errParse = strconv.ParseInt(v, 10, 64); errParse != nil {
			return jsonResponse(http.StatusBadRequest, map[string]string{"error": "invalid from"})
		}
	}
	if from >= to {
		return jsonResponse(http.StatusBadRequest, map[string]string{"error": "from must be before to"})
	}
	s := currentStore()
	if s == nil {
		return jsonResponse(http.StatusServiceUnavailable, map[string]string{"error": "not configured"})
	}
	return jsonResponse(http.StatusOK, s.query(from, to))
}

func jsonResponse(status int, body any) ([]byte, error) {
	raw, errMarshal := json.Marshal(body)
	if errMarshal != nil {
		return nil, errMarshal
	}
	return okEnvelope(pluginapi.ManagementResponse{
		StatusCode: status,
		Headers:    http.Header{"Content-Type": []string{"application/json"}},
		Body:       raw,
	})
}

// shutdown persists whatever is still queued and closes the day file.
func shutdown() {
	s := currentStore()
	if s == nil {
		return
	}
	for {
		select {
		case e := <-queue:
			s.add(e)
		default:
			s.close()
			return
		}
	}
}

func pluginRegistration() registration {
	return registration{
		SchemaVersion: pluginabi.SchemaVersion,
		Metadata: pluginapi.Metadata{
			Name:             "usage-stats",
			Version:          "0.1.0",
			Author:           "ahmedisam99",
			GitHubRepository: "https://github.com/ahmedisam99/router-for-me",
			ConfigFields: []pluginapi.ConfigField{
				{
					Name:        "retention_days",
					Type:        pluginapi.ConfigFieldTypeInteger,
					Default:     defaultRetentionDays,
					Description: "Days of usage records to keep.",
				},
				{
					Name:        "data_dir",
					Type:        pluginapi.ConfigFieldTypeString,
					Default:     "~/.cli-proxy-api/plugins/usage-stats",
					Description: "Directory for the daily usage record files.",
				},
			},
		},
		Capabilities: registrationCapability{UsagePlugin: true, ManagementAPI: true},
	}
}

func okEnvelope(v any) ([]byte, error) {
	raw, errMarshal := json.Marshal(v)
	if errMarshal != nil {
		return nil, errMarshal
	}
	return json.Marshal(envelope{OK: true, Result: raw})
}

func errorEnvelope(code, message string) []byte {
	raw, _ := json.Marshal(envelope{OK: false, Error: &envelopeError{Code: code, Message: message}})
	return raw
}

func writeResponse(response *C.cliproxy_buffer, raw []byte) {
	if response == nil || len(raw) == 0 {
		return
	}
	ptr := C.CBytes(raw)
	if ptr == nil {
		return
	}
	response.ptr = ptr
	response.len = C.size_t(len(raw))
}
