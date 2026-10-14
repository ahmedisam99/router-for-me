# router-for-me

My fork of the [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) stack, kept as one private
repo. The main goal is a better management dashboard for my own use. I also write my own plugins and
edit the core when needed.

| Path | What it is |
|---|---|
| `CLIProxyAPI/` | Go backend: proxy server, management API, plugin host. Subtree of `router-for-me/CLIProxyAPI` |
| `Cli-Proxy-API-Management-Center/` | TypeScript dashboard, released as one `management.html`. Subtree of `router-for-me/Cli-Proxy-API-Management-Center` |
| `plugins/` | Our plugins |
| `CLAUDE.md`, `.claude/` | Instructions and settings for Claude Code sessions started here |

## Remotes

- `origin`: `ahmedisam99/router-for-me` (private). Everything we commit goes to `main`.
- `backend-upstream`, `panel-upstream`: the router-for-me repos. Fetch only; push is `DISABLED`.
  Their tags arrive as `backend/*` and `panel/*` because the two repos share tag names.

The subtrees started from backend `v8.0.29` and dashboard `v1.26.4` (2026-10-15).

## Syncing with upstream

The backend and dashboard move together: pick a backend release and the dashboard release that
matches it. A dashboard newer than its backend's management API breaks.

```bash
git fetch backend-upstream && git fetch panel-upstream
git subtree merge --prefix=CLIProxyAPI --squash backend/v8.0.30
git subtree merge --prefix=Cli-Proxy-API-Management-Center --squash panel/v1.26.5
```

Conflicts resolve like any merge, and `rerere` is on, so a conflict fixed once is reused.

What the fork changes against the release it was last synced to:

```bash
git diff backend/v8.0.29 HEAD:CLIProxyAPI
git diff panel/v1.26.4 HEAD:Cli-Proxy-API-Management-Center
```

Version stamps don't come from this repo's tags. The backend takes `VERSION`, `COMMIT` and
`BUILD_DATE` as Docker build args, and the dashboard reads a `VERSION` env var at build time.

The running deployment (Docker setup, config, journal) still lives in
`~/repos/personal/claude-workshop/cli-proxy-api/` and will move here.
