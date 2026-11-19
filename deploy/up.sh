#!/usr/bin/env bash
# Builds the dashboard, our plugins and the backend from this checkout, then starts or updates the live proxy.
# Each side is stamped with the upstream release its subtree is on and the last commit touching it.
# The stamps never use the clock, so an unchanged backend rebuilds from cache and keeps running.
set -euo pipefail
cd "$(dirname "$0")"

# release CLIProxyAPI -> v8.0.34, read from the subject of the subtree's last merge by scripts/sync-upstream.sh
release() {
  git log -1 --merges --format=%s --grep="^Sync $1 to " | sed "s/^Sync $1 to //"
}

# revision ../CLIProxyAPI -> abc1234, or abc1234-dirty with uncommitted changes there
revision() {
  echo "$(git log -1 --format=%h -- "$1")$([ -z "$(git status --porcelain -- "$1")" ] || echo -dirty)"
}

panel_version=$(release Cli-Proxy-API-Management-Center)
panel_version+=+$(revision ../Cli-Proxy-API-Management-Center)
(cd ../Cli-Proxy-API-Management-Center && bun install --frozen-lockfile && VERSION=$panel_version bun run build)

# plugins/<id>/ -> plugins/<os>/<arch>/<id>.so, built in the backend's builder image so it links the container's glibc
mkdir -p plugins
plugin_hashes() { find plugins -name .shadow -prune -o -name '*.so' -type f -exec sha256sum {} + | sort; } # .shadow: the backend's root-only copies
builder=$(sed -n 's/^FROM \([^ ]*\) AS builder$/\1/p' ../CLIProxyAPI/Dockerfile)
plugins_before=$(plugin_hashes)
for dir in ../plugins/*/; do
  [ -f "$dir/go.mod" ] || continue
  id=$(basename "$dir")
  docker run --rm -v "$PWD/../plugins":/src/plugins:ro -v "$PWD/../CLIProxyAPI":/src/CLIProxyAPI:ro \
    -v "$PWD/plugins":/out -v cliproxy-plugin-gomod:/go/pkg/mod -v cliproxy-plugin-gocache:/root/.cache/go-build \
    -w "/src/plugins/$id" "$builder" sh -c \
    "out=/out/\$(go env GOOS)/\$(go env GOARCH) && mkdir -p \$out && go build -buildvcs=false -trimpath -buildmode=c-shared -o /tmp/$id.so . && cp /tmp/$id.so \$out/"
done
plugins_after=$(plugin_hashes)

VERSION=$(release CLIProxyAPI)
COMMIT=$(revision ../CLIProxyAPI)
BUILD_DATE=$(TZ=UTC git log -1 --date=format-local:%Y-%m-%dT%H:%M:%SZ --format=%cd -- ../CLIProxyAPI)
export VERSION COMMIT BUILD_DATE
container=$(docker compose ps -q cli-proxy-api)
mkdir -p static # before compose, or Docker creates the bind-mount source as root and the copy below fails
docker compose up -d --build
# The backend loads plugins only at startup, so a changed plugin needs a restart when compose kept the container.
if [ "$plugins_before" != "$plugins_after" ] && [ "$(docker compose ps -q cli-proxy-api)" = "$container" ]; then
  docker compose restart cli-proxy-api
fi

# Last, so the new dashboard never talks to the old backend.
cp ../Cli-Proxy-API-Management-Center/dist/index.html static/management.html
