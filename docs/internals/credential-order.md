# Credential order

The Credentials page lists every credential in the order the proxy picks it, and dragging a row
rewrites priorities. The rules below decide what that order means.

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
the model to another upstream name, breaks the same tie by ID. The pages therefore give tied
credentials of different providers one shared rank, and only rank by ID within a provider.

## How the dashboard pins it

A reorder writes distinct priorities, from N at the top down to 1, so no ties are left and the
list is the real order. Config keys get a key-level `priority` in `api-keys.<family>`;
OpenAI-compatible providers only accept one at the group level, so all keys of such a group share
it. Auth files take it through `PATCH /credentials/fields`. Runtime-only credentials can't hold a
priority and keep theirs. See [`routing.ts`](../../Cli-Proxy-API-Management-Center/src/services/api/routing.ts)
and [`order.ts`](../../Cli-Proxy-API-Management-Center/src/features/credentials/order.ts).

Pinning removes rotation, which is right for `fill-first` and wrong for a round-robin setup. Revisit
this if the strategy changes.

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
`last_models`. The memory updates only when the endpoint is read, which the dashboard does before
you can disable anything. A disabled OpenAI-compatible provider has no credential at all, so the
dashboard lists the models from its config instead.
