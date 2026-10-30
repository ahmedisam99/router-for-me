import { pickRanks } from '@/features/credentials/order';
import type { CredentialRow } from '@/features/credentials/rows';
import type { KeyModel, ModelAlias } from '@/services/api/modelAliases';
import { isRecord } from '@/utils/helpers';
import { scopedRows } from './scopes';

export type InactiveReason = 'disabled' | 'not-served';

export interface ModelRoute {
  row: CredentialRow;
  /** Pick order among the live credentials serving this model; tied ones share one. 0 if inactive. */
  rank: number;
  upstream: string[];
  /** Set when the route is configured but the router doesn't serve it. */
  inactive?: InactiveReason;
}

/** A model ID clients can request, with the credentials serving it in pick order. */
export interface ModelEntry {
  id: string;
  routes: ModelRoute[];
  /** Some credential sends it upstream under another name. */
  renamed: boolean;
  /** Some credential serves it right now. */
  live: boolean;
}

/** A route that config describes but the router doesn't serve right now. */
export interface InactiveRoute {
  row: CredentialRow;
  id: string;
  upstream: string[];
  reason: InactiveReason;
}

const serves = (row: CredentialRow, id: string, upstream: string) =>
  row.credential.models.some((model) => model.id === id && model.upstream.includes(upstream));

/** The models a provider's own config lists, as model ID and upstream name. */
const configuredModels = (raw: unknown) =>
  (isRecord(raw) && Array.isArray(raw.models) ? raw.models : []).flatMap((model) => {
    const upstream = isRecord(model) && typeof model.name === 'string' ? model.name.trim() : '';
    const alias = isRecord(model) && typeof model.alias === 'string' ? model.alias.trim() : '';
    return upstream ? [{ id: alias || upstream, upstream }] : [];
  });

/**
 * Routes missing from what the router serves: a disabled key's models list, listed models an
 * enabled key doesn't serve, the models of a disabled provider the backend leaves out, what a
 * disabled credential served when last seen enabled, and OAuth aliases an account doesn't serve.
 * Each route shows once.
 */
export function inactiveRoutes(
  rows: readonly CredentialRow[],
  aliases: readonly ModelAlias[],
  keyModels: readonly KeyModel[]
): InactiveRoute[] {
  const fromKeys = rows
    .filter((row) => row.resource)
    .flatMap((row) =>
      keyModels
        .filter(
          (model) =>
            model.authIndex === row.credential.authIndex && !serves(row, model.id, model.upstream)
        )
        .map((model) => ({
          row,
          id: model.id,
          upstream: [model.upstream],
          reason: row.disabled ? ('disabled' as const) : ('not-served' as const),
        }))
    );
  // The backend builds no credential for these, so their rows carry no auth index.
  const fromLeftOut = rows
    .filter((row) => row.resource && !row.credential.authIndex)
    .flatMap((row) =>
      configuredModels(row.resource!.raw).map((model) => ({
        row,
        id: model.id,
        upstream: [model.upstream],
        reason: 'disabled' as const,
      }))
    );
  const fromLastSeen = rows
    .filter((row) => row.disabled)
    .flatMap((row) =>
      row.credential.lastModels.map((model) => ({
        row,
        id: model.id,
        upstream: model.upstream,
        reason: 'disabled' as const,
      }))
    );
  const fromAliases = aliases
    .filter((alias) => alias.scope.kind !== 'key')
    .flatMap((alias) =>
      scopedRows(alias.scope, rows)
        .filter((row) => !serves(row, alias.alias, alias.upstream))
        .map((row) => ({
          row,
          id: alias.alias,
          upstream: [alias.upstream],
          reason: row.disabled ? ('disabled' as const) : ('not-served' as const),
        }))
    );
  const seen = new Set<string>();
  return [...fromKeys, ...fromLeftOut, ...fromLastSeen, ...fromAliases].filter((route) => {
    const key = [route.row.credential.id, route.id, ...route.upstream].join('\n');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Models from rows given in pick order, each ranking only the credentials that serve it. */
export const buildModelMap = (
  rows: readonly CredentialRow[],
  strategy: string | undefined,
  inactive: readonly InactiveRoute[] = []
): ModelEntry[] => {
  const entries = new Map<string, ModelEntry>();
  const entryFor = (id: string) => {
    let entry = entries.get(id);
    if (!entry) {
      entry = { id, routes: [], renamed: false, live: false };
      entries.set(id, entry);
    }
    return entry;
  };

  rows.forEach((row) => {
    row.credential.models.forEach((model) => {
      const entry = entryFor(model.id);
      entry.live = true;
      entry.routes.push({ row, rank: 0, upstream: model.upstream });
      if (model.upstream.some((name) => name !== model.id)) entry.renamed = true;
    });
  });
  entries.forEach((entry) => {
    const ranks = pickRanks(
      entry.routes.map((route) => route.row.credential),
      strategy
    );
    entry.routes.forEach((route, index) => {
      route.rank = ranks[index];
    });
  });
  inactive.forEach((route) => {
    const entry = entryFor(route.id);
    entry.routes.push({
      row: route.row,
      rank: 0,
      upstream: route.upstream,
      inactive: route.reason,
    });
    if (route.upstream.some((name) => name !== route.id)) entry.renamed = true;
  });
  return Array.from(entries.values()).sort((a, b) => a.id.localeCompare(b.id));
};
