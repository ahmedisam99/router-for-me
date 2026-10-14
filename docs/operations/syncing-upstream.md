# Syncing with upstream

`CLIProxyAPI/` and `Cli-Proxy-API-Management-Center/` are squashed git subtrees of the two
router-for-me repos. A sync merges a newer upstream release into each directory, on top of our changes.

## Remotes, once per clone

A clone of `origin` has no upstream remotes. Add them with namespaced tags, because the two repos
share tag names:

```bash
for r in backend:CLIProxyAPI panel:Cli-Proxy-API-Management-Center; do
  ns=${r%%:*}; repo=${r#*:}
  git remote add "$ns-upstream" "git@github.com:router-for-me/$repo.git"
  git config --add "remote.$ns-upstream.fetch" "+refs/tags/*:refs/tags/$ns/*"
  git config "remote.$ns-upstream.tagOpt" --no-tags
  git remote set-url --push "$ns-upstream" DISABLED
done
git config rerere.enabled true
```

Only fetch through these remotes. `git fetch --tags`, or a fetch from a URL or path, brings
upstream tags in without a namespace. Delete those if it happens.

## Sync

1. Fetch: `git fetch backend-upstream && git fetch panel-upstream`. This also gives `subtree merge`
   the previous upstream commit it diffs from, which a fresh clone lacks.
2. Pick the latest release on both sides:
   `git tag -l 'backend/v*' --sort=-v:refname | head -1`, and the same for `panel/`. Always move
   both together. The stock backend always serves the latest dashboard release, so latest with
   latest is the pair upstream runs. A dashboard newer than its backend's management API breaks.
3. Merge each one, always with `--squash`:

   ```bash
   git subtree merge --prefix=CLIProxyAPI --squash -m "Sync CLIProxyAPI to v8.0.30" backend/v8.0.30
   git subtree merge --prefix=Cli-Proxy-API-Management-Center --squash -m "Sync Cli-Proxy-API-Management-Center to v1.26.5" panel/v1.26.5
   ```

4. Resolve conflicts as in any merge, then `git commit`. `rerere` replays fixes it has seen before.
5. Run each side's checks from its `AGENTS.md` before pushing.

## Where each subtree stands

The last squash commit for a directory names the upstream commit it came from:

```bash
d=CLIProxyAPI   # or Cli-Proxy-API-Management-Center
git describe --tags --exact-match "$(git log -1 --format=%B --grep="^git-subtree-dir: $d\$" | sed -n 's/^git-subtree-split: //p')"
```

To see what the fork changes against that release:
`git diff backend/v8.0.29 HEAD:CLIProxyAPI` (or `panel/<tag> HEAD:Cli-Proxy-API-Management-Center`).
