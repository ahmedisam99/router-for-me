#!/usr/bin/env bash
# Builds the dashboard and backend from this checkout, then starts or updates the live proxy.
# Each side is stamped with the upstream release its subtree is on and the last commit touching it.
# The stamps never use the clock, so an unchanged backend rebuilds from cache and keeps running.
set -euo pipefail
cd "$(dirname "$0")"

# release CLIProxyAPI -> v8.0.34, read from the subtree's last squash commit
release() {
  git describe --tags --exact-match \
    "$(git log -1 --format=%B --grep="^git-subtree-dir: $1\$" | sed -n 's/^git-subtree-split: //p')" |
    sed 's|^[^/]*/||'
}

# revision ../CLIProxyAPI -> abc1234, or abc1234-dirty with uncommitted changes there
revision() {
  echo "$(git log -1 --format=%h -- "$1")$([ -z "$(git status --porcelain -- "$1")" ] || echo -dirty)"
}

panel_version=$(release Cli-Proxy-API-Management-Center)
panel_version+=+$(revision ../Cli-Proxy-API-Management-Center)
(cd ../Cli-Proxy-API-Management-Center && bun install --frozen-lockfile && VERSION=$panel_version bun run build)
mkdir -p static
cp ../Cli-Proxy-API-Management-Center/dist/index.html static/management.html

VERSION=$(release CLIProxyAPI)
COMMIT=$(revision ../CLIProxyAPI)
BUILD_DATE=$(TZ=UTC git log -1 --date=format-local:%Y-%m-%dT%H:%M:%SZ --format=%cd -- ../CLIProxyAPI)
export VERSION COMMIT BUILD_DATE
docker compose up -d --build
