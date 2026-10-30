# Client keys

The Keys page puts rules on the keys clients use to call the proxy: on/off, a profile of model rules,
budgets, spend and last use. The code is [`internal/clientkeys`](../../CLIProxyAPI/internal/clientkeys)
plus small hooks in upstream files, listed by `scripts/fork-diff.sh`.

## Why the core and not a plugin

A plugin that failed to load or crashed would leave keys working with no rules, so a sibling's limits
would quietly disappear. A plugin also can't learn which key asked for which effort, and its rejections
reach clients as raw bodies rather than errors in their protocol. In the core the checks are part of the
binary: if they break, the build or the tests fail.

## Keys stay in the config

The keys themselves remain in `access.api-keys`, checked by upstream, so the proxy never opens up when
our code misbehaves. Settings are stored by the SHA-256 of the key, never the key. Settings of a key
that is no longer in the config are kept on purpose: a key that disappears for a moment, for example
while being edited on the Config page, must not come back without its restrictions.

## Where the checks run

- **The auth middleware** refuses a switched-off key, or one over a budget set to block, on every route
  ([`server_middleware.go`](../../CLIProxyAPI/internal/api/server_middleware.go)). Upstream's rejection
  branch renders the error.
- **The execution hook** at the top of the three execute functions in `sdk/api/handlers` applies profile
  rules, and repeats the key checks for websocket turns that skip the middleware
  ([`client_keys.go`](../../CLIProxyAPI/sdk/api/handlers/client_keys.go)). Rules match the requested
  model and every upstream model it resolves to, so an alias can't get around a block. `auto` is resolved
  first, the way routing resolves it. Models named inside a Claude request body (the advisor tool's model,
  `fallbacks`) are matched too; they can be blocked but not redirected.
- **Codex duplex websocket follow-up turns** go straight upstream. A turn is refused when it would need a
  redirect the session isn't already running with.

Live, realtime and alpha search get the key checks but not the model rules; a realtime client secret is
checked against the key that minted it. Redirects on image and video routes are unreliable, because those
handlers shape the payload for the requested model first; blocks work.

## Effort redirects are a model suffix

A redirect rewrites the model to `model(level)`. Upstream already makes a suffix beat any effort in the
body on every executor path, so no executor changes. The hook runs after the handler records the client's
requested model, so responses and usage still show what the client asked for. A payload rule in
`config.yaml` that sets effort for a model still wins over the cap, because payload rules are applied last
by design (`CLIProxyAPI/AGENTS.md`). Don't write one for a model a profile restricts.

## Cost

Spend is what the request would have cost on the provider's paid API. Providers count tokens differently
(Claude's input excludes cached tokens, the others include them), so cost uses the core's
`Detail.TokenBreakdown`, which splits every record into uncached, cache read, cache write, output and
reasoning. Prices come from LiteLLM's list, refreshed weekly, with per-model overrides. A request costs the
price of the model that ran it, so a request for an alias costs its upstream model's price. The Prices
tab still lists every model at its own price, whatever it is aliased to. A cache-write price of 0 means
"charge the input price". An unpriced model costs 0 and is listed on the Prices tab. Spend runs low on
purpose in three cases: long cache writes (Claude 1 hour, OpenAI 12 hours) cost the short-write price
because usage records don't say which was used; Claude fast mode costs the standard price, since LiteLLM
has none for it; OpenAI's Ultrafast tier is ignored.

Budgets are rolling windows over 5-minute spend buckets, rebuilt at startup from the daily ledger. The
check happens before a request, so one request can go past a budget.

## Files

Everything lives in `<auth-dir>/client-keys/`, which is `deploy/data/client-keys/` live: `policy.yaml`,
the imported price list, and `spend/YYYY-MM-DD.jsonl`. No file there may end in `.json`, see the hazards in
`CLAUDE.md`. Edit `policy.yaml` by hand only with the proxy stopped; it is read at startup and written by
the management routes. If it can't be parsed, every request is refused with a 503 naming the file, so a
typo can't lift a sibling's limits. An unreadable spend line is skipped.
