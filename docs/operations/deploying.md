# Deploying

The live proxy is the `cli-proxy-api` container in `deploy/`. Its image is built from `CLIProxyAPI/`
with upstream's Dockerfile. It serves the dashboard from `deploy/static/management.html`, built from
`Cli-Proxy-API-Management-Center/`.

## Deploy

```bash
deploy/up.sh
```

It builds the dashboard, the plugins and the backend, runs `docker compose up -d --build`, and only
then copies the dashboard into `deploy/static/`, so a new dashboard never talks to an old backend.
The backend reads `management.html` from disk on every request, so it shows on the next page load.
A backend build normally takes seconds. When `go.mod` or the `golang` base image changed, which
happens on most syncs, it takes about 10 minutes: upstream's Dockerfile has no module cache, so
every dependency downloads again.
Compose recreates the container only when the backend changed, and that drops in-flight requests.

The version stamps name the upstream release each subtree is on, not a version of ours. The backend
sends its version upstream in `User-Agent`, and the System page compares it with upstream's latest
release. Our commit goes in `COMMIT` and in the dashboard's `+<sha>` suffix.

For dashboard work, run `bun run dev` in `Cli-Proxy-API-Management-Center/` and log in to
`http://127.0.0.1:8317`. Deploy once the change is done.

## Plugins

`up.sh` builds every `plugins/<id>/` into `deploy/plugins/linux/amd64/<id>.so`. It builds inside the
backend's own builder image, so the plugin links the same glibc as the container. The backend loads
plugins only at startup, so `up.sh` restarts the container when a plugin changed and the backend
didn't.

A built plugin stays off until `deploy/config.yaml` enables it:

```yaml
plugins:
    enabled: true
    configs:
        usage-stats:
            enabled: true
```

`usage-stats` keeps one `.jsonl` file per day in `deploy/data/plugins/usage-stats/`, 90 days by
default (`retention_days`). The Stats page reads it; without the plugin the page says so.

## Config

`deploy/config.yaml` is not in git. Keep `disable-auto-update-panel: true` under `management:` in it.
Without it the backend tries to replace our dashboard with upstream's latest release every 3 hours.
The read-only mount blocks the write, but every attempt logs a warning.

## Rolling back

A backend upgrade can rewrite `deploy/config.yaml` and the auth files in `deploy/data/`, so copy both
before deploying a sync. To roll back, run `deploy/up.sh` from the last good commit and restore the
copies if the newer backend changed them.
