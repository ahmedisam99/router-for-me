# router-for-me

My fork of the [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) stack, kept as one private
repo. The main goal is a better management dashboard for my own use. I also write my own plugins and
edit the core when needed.

| Path | What it is |
|---|---|
| `CLIProxyAPI/` | Go backend: proxy server, management API, plugin host. Subtree of `router-for-me/CLIProxyAPI` |
| `Cli-Proxy-API-Management-Center/` | TypeScript dashboard, released as one `management.html`. Subtree of `router-for-me/Cli-Proxy-API-Management-Center` |
| `plugins/` | Our plugins |
| `deploy/` | The live proxy: compose file, plus gitignored `config.yaml`, `data/` (auth files, logs) and `plugins/` (binaries) |
| `docs/` | Decisions, traps and procedures; start at `docs/README.md` |
| `CLAUDE.md`, `.claude/` | Instructions and settings for Claude Code sessions started here |

## Remotes

- `origin`: `ahmedisam99/router-for-me` (private). Everything we commit goes to `main`.
- `backend-upstream`, `panel-upstream`: the router-for-me repos, fetch only. Syncing with them is in
  [`docs/operations/syncing-upstream.md`](docs/operations/syncing-upstream.md).

Version stamps don't come from this repo's tags. The backend takes `VERSION`, `COMMIT` and
`BUILD_DATE` as Docker build args, and the dashboard reads a `VERSION` env var at build time.

The live proxy runs from `deploy/`.
