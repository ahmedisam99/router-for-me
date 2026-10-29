# Dashboard layout

Where the fork's dashboard code lives, so upstream syncs stay cheap.

- **Our pages are new features.** Home, Credentials, Models and Stats live in `src/features/home`,
  `credentials`, `models` and `stats`. Upstream's AI Providers, Auth Files, OAuth and Dashboard
  pages stay in the tree untouched: `/ai-providers` and `/auth-files` redirect to `/credentials`,
  `/oauth` opens its add sheet, and nothing routes to the old dashboard.
- **We compose upstream's pieces, we don't copy them.** Credentials edits through upstream's
  `ProviderSheet` and `AuthFileDetailsSheet`, shows quota with `AuthFileQuotaSection`, and signs in
  with the OAuth page's tiles, flow hooks and dialogs. Home reuses the dashboard's styles and the
  quota timeline. The alias manager writes through the same calls as upstream's three alias editors,
  which stay reachable.
- **Our strings live in `src/i18n/fork/`.** They are merged into upstream's bundles at startup
  without overwriting upstream keys. Never add keys to `src/i18n/locales/*.json`; every sync would
  conflict there. Use a namespace upstream doesn't (upstream already owns `stats`, ours is
  `stats_page`).
- **Upstream hunks are wiring only.** They cover the routes, the sidebar entries, the i18n merge
  call, and one bug fix in `transformers.ts`, which read `auth-index` while v8 sends `auth_index`.
  Upstream's own test fixture uses the wrong spelling, so the fix reads both. Drop it once upstream
  fixes it.
- **Plugin routes keep their `/v0/management` path.** The plugin host forces that prefix, so
  `usageStats.ts` passes an absolute URL to `apiClient`, which skips the v8 base but keeps auth and
  error handling.
