# Credential order

The Models page lists each model's credentials in the order the proxy picks them. The rules below
decide what that order means. Upstream's Routing page sets the priorities.

## How the backend picks

Highest `priority` wins, and ties fall back to the credential ID compared byte by byte. Order in
`config.yaml` counts for nothing. A config API key's ID is a hash of its key, base URL, proxy,
prefix and headers, so a tie between two keys is effectively random and changes when any of those
fields is edited. Under `fill-first` the order is strict; under the round-robin strategies,
credentials of equal priority rotate. The order also only applies per model, among the credentials
that serve it.

A tie between providers has no single answer. When a model is served by several providers, the
scheduler takes the best priority across them, then breaks a tie by provider order: most
credentials for that model first, then name. The legacy path, used for example when an alias maps
the model to another upstream name, breaks the same tie by ID. The Models page therefore gives tied
credentials of different providers one shared rank, and only ranks by ID within a provider.

## Why a core endpoint

`GET /v8/management/routing/models` lists every credential, config keys included, in pick order
with the models it serves and what each resolves to upstream. Upstream has no such view.
`/credentials` drops config keys, and plugins can't read the model registry. The handler is
[`routing_models.go`](../../CLIProxyAPI/internal/api/handlers/management/routing_models.go).

The upstream names come from `Manager.UpstreamModels` in
[`routing_view.go`](../../CLIProxyAPI/sdk/cliproxy/auth/routing_view.go), a copy of the executor's
`executionModelCandidatesWithAlias` that skips advancing the model pool cursor, so a read can't
shift live routing. Its test compares the two, so a sync that changes the executor's alias logic
fails there rather than drifting silently.

Disabling a credential drops its models from the registry, and working out what it would serve
means copying upstream's per-provider registration. So the endpoint remembers what each enabled
credential serves, in `<auth-dir>/routing/last-models.yaml`, and lists that as a disabled one's
`last_models`. The memory updates only when one of our pages reads the endpoint (Home, Models,
Stats, Keys), not when upstream's Auth Files or AI Providers pages disable a credential. Home is
where the dashboard lands, so a credential is normally recorded before it is disabled. A disabled
OpenAI-compatible provider has no credential at all, so the dashboard lists the models from its
config instead.
