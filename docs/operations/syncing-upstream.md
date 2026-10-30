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

```bash
scripts/sync-upstream.sh                  # the latest release on both sides
scripts/sync-upstream.sh v8.0.47 v1.26.7  # or a given pair
```

It merges each release with `git subtree merge --squash`, then runs the checks our changes depend on:
the backend build and the tests of the packages we change, every plugin's tests and build, and the
dashboard's `bun run verify`. It ends with `scripts/fork-diff.sh` and never pushes or deploys.

Both sides always move together. The stock backend serves the latest dashboard release, so latest
with latest is the pair upstream runs. A dashboard newer than its backend's management API breaks.

On a conflict the script stops and lists the files. Resolve them, `git commit`, and run it again
with the same tags: a subtree already on its tag is skipped. `rerere` replays fixes it has seen.

Read both releases' notes too. When upstream adds something that overlaps a page of ours, such as
v1.27.0's Routing page beside our credential order, tell the developer and keep it visible. Hiding
or removing it is their decision, made after they have seen it.

Sync about weekly, or sooner for a fix we need, not on every release. Upstream ships several a day,
each deploy restarts the live proxy, and a `go.mod` change makes the backend build take about ten
minutes. Then look at the result with `scripts/staging.sh` and deploy, see
[Deploying](deploying.md).

## What the fork changes

`scripts/fork-diff.sh` lists, for each subtree, the upstream files we modify and the files we add,
against the release it is synced to. `--diff` adds the patch of the modified ones, which are the
hunks a sync can conflict on.
