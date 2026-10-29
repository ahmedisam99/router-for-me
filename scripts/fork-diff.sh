#!/usr/bin/env bash
# Shows what this fork changes in each subtree against the upstream release it is synced to:
# the upstream files we modify or delete, and the files we add. --diff also prints the patch of the
# modified ones, the hunks a sync can conflict on.
set -euo pipefail
cd "$(dirname "$0")/.."

# base CLIProxyAPI -> backend/v8.0.47, read from the subtree's last squash commit
base() {
  git describe --tags --exact-match \
    "$(git log -1 --format=%B --grep="^git-subtree-dir: $1\$" | sed -n 's/^git-subtree-split: //p')"
}

for dir in CLIProxyAPI Cli-Proxy-API-Management-Center; do
  tag=$(base "$dir")
  changes=$(git diff --name-status "$tag" "HEAD:$dir")
  modified=$(awk '$1 != "A" { print $2 }' <<<"$changes")
  echo "== $dir against $tag"
  echo "upstream files we change:"
  awk '$1 != "A" { print "  " $1 " " $2 }' <<<"$changes"
  echo "files we add: $(grep -c '^A' <<<"$changes" || true)"
  awk '$1 == "A" { print "  " $2 }' <<<"$changes"
  if [ "${1:-}" = --diff ] && [ -n "$modified" ]; then
    # shellcheck disable=SC2086 # one path per word
    git diff "$tag" "HEAD:$dir" -- $modified
  fi
  echo
done
