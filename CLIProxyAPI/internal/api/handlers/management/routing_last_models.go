package management

import (
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"sync"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/util"
	log "github.com/sirupsen/logrus"
	"gopkg.in/yaml.v3"
)

// lastModels remembers the model IDs each enabled credential serves, so the routing view can
// still list a disabled credential's models: disabling one drops them from the registry.
var lastModels lastModelsStore

type lastModelsStore struct {
	mu     sync.Mutex
	path   string
	byAuth map[string][]string
}

// lastModelsPath is <auth-dir>/routing/last-models.yaml. Never .json: the auth store loads
// every *.json under the auth dir as a credential.
func lastModelsPath(cfg *config.Config) string {
	if cfg == nil {
		return ""
	}
	dir, errResolve := util.ResolveAuthDir(cfg.AuthDir)
	if errResolve != nil || dir == "" {
		return ""
	}
	return filepath.Join(dir, "routing", "last-models.yaml")
}

// update replaces the remembered models of every enabled credential with enabled, sorted IDs
// by auth ID (none forgets it), and returns what is remembered for each credential. A disabled
// credential keeps what it served when last seen enabled.
func (s *lastModelsStore) update(path string, enabled map[string][]string) map[string][]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.byAuth == nil || s.path != path {
		s.path, s.byAuth = path, loadLastModels(path)
	}
	changed := false
	for id, models := range enabled {
		if len(models) == 0 {
			if _, ok := s.byAuth[id]; ok {
				delete(s.byAuth, id)
				changed = true
			}
		} else if !slices.Equal(s.byAuth[id], models) {
			s.byAuth[id] = models
			changed = true
		}
	}
	if changed && path != "" {
		if errSave := saveLastModels(path, s.byAuth); errSave != nil {
			log.Warnf("routing: remember served models: %v", errSave)
		}
	}
	return maps.Clone(s.byAuth)
}

func loadLastModels(path string) map[string][]string {
	byAuth := make(map[string][]string)
	if path == "" {
		return byAuth
	}
	data, errRead := os.ReadFile(path)
	if errRead != nil {
		if !errors.Is(errRead, os.ErrNotExist) {
			log.Warnf("routing: read %s: %v", path, errRead)
		}
		return byAuth
	}
	if errParse := yaml.Unmarshal(data, &byAuth); errParse != nil {
		log.Warnf("routing: parse %s: %v", path, errParse)
		return make(map[string][]string)
	}
	return byAuth
}

func saveLastModels(path string, byAuth map[string][]string) error {
	data, errMarshal := yaml.Marshal(byAuth)
	if errMarshal != nil {
		return fmt.Errorf("encode: %w", errMarshal)
	}
	if errMkdir := os.MkdirAll(filepath.Dir(path), 0o700); errMkdir != nil {
		return errMkdir
	}
	tmp := path + ".tmp"
	if errWrite := os.WriteFile(tmp, data, 0o600); errWrite != nil {
		return errWrite
	}
	return os.Rename(tmp, path)
}
