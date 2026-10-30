#!/usr/bin/env bash
# Merges an upstream release into each subtree, then runs the checks our changes depend on.
# Usage: scripts/sync-upstream.sh [backend-tag panel-tag]   e.g. v8.0.47 v1.26.7; default: the latest of each
# On a conflict it stops. Resolve, `git commit`, and run it again: a subtree already on its tag is skipped.
# It never pushes and never deploys.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -ne 0 ] && [ $# -ne 2 ]; then
  echo "usage: $0 [backend-tag panel-tag]" >&2
  exit 2
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Commit or stash your changes first." >&2
  exit 1
fi

git fetch -q backend-upstream
git fetch -q panel-upstream
latest() { git tag -l "$1/v*" --sort=-v:refname | sed -n "1s|^$1/||p"; }
backend=${1:-$(latest backend)}
panel=${2:-$(latest panel)}

# synced CLIProxyAPI -> v8.0.47, read from the subtree's last squash commit; synced CLIProxyAPI 1 -> the
# release it was on before that
synced() {
  git describe --tags --exact-match \
    "$(git log --skip="${2:-0}" -1 --format=%B --grep="^git-subtree-dir: $1\$" |
      sed -n 's/^git-subtree-split: //p')" | sed 's|^[^/]*/||'
}

# merge <dir> <tag namespace> <tag>
merge() {
  if [ "$(synced "$1")" = "$3" ]; then
    echo "$1 is on $3"
    return
  fi
  echo "Merging $2/$3 into $1"
  if ! git subtree merge --prefix="$1" --squash -m "Sync $1 to $3" "$2/$3"; then
    echo "Conflicts in $1:" >&2
    git diff --name-only --diff-filter=U | sed 's/^/  /' >&2
    echo "Resolve them, git commit, then run $0 $backend $panel again." >&2
    exit 1
  fi
}
merge CLIProxyAPI backend "$backend"
merge Cli-Proxy-API-Management-Center panel "$panel"

echo "== Backend: build, and the tests of the packages we change"
(cd CLIProxyAPI && go build -o /dev/null ./cmd/server &&
  go test -count=1 ./internal/api/ ./internal/api/handlers/management/ ./internal/clientkeys/ \
    ./sdk/api/handlers/ ./sdk/cliproxy/auth/)

# A plugin builds against ../../CLIProxyAPI, so its go.mod follows the backend's.
echo "== Plugins: tidy, tests and a build against the new backend"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
for dir in plugins/*/; do
  [ -f "$dir/go.mod" ] || continue
  (cd "$dir" && go mod tidy && go test -count=1 ./... && go build -buildmode=c-shared -o "$out/plugin.so" .)
done

echo "== Dashboard: tests, lint and build"
(cd Cli-Proxy-API-Management-Center && bun install --frozen-lockfile && bun run verify)

scripts/fork-diff.sh

# Our pages replace these (docs/internals/dashboard-layout.md), so what upstream adds to them reaches
# our dashboard only if we carry it over. Paths are as in upstream's repo, compared between its tags.
# The sign-in sheet mirrors the OAuth page's tiles, so new sign-in options land there too.
replaced=(src/features/oauth/OAuthPage.tsx src/features/dashboard/DashboardPage.tsx)
previous=$(synced Cli-Proxy-API-Management-Center 1)
changed=$(git diff --stat "panel/$previous" "panel/$panel" -- "${replaced[@]}")
if [ -n "$changed" ]; then
  echo "Upstream changed pages ours replace since $previous; carry any new feature over:"
  echo "$changed"
fi
if [ -n "$(git status --porcelain -- plugins)" ]; then
  echo "The backend's modules moved: commit the plugins' go.mod and go.sum."
fi
echo "Next: scripts/staging.sh to look at it, then deploy/up.sh."
