import { isRecord } from '@/utils/helpers';
import { normalizeOAuthProviderKey } from '@/utils/providerKeys';
import { authFilesApi, type AuthFileFieldsPatch } from './authFiles';
import {
  buildCredentialAliases,
  readCredentialAliases,
  readCredentialPolicyValue,
} from './authFilePolicyAdapter';
import { apiClient } from './client';
import { getConfigValue, guardConfigConnection } from './configValue';

type RawEntry = Record<string, unknown>;

/**
 * Where an alias lives. The backend applies each differently: a channel alias covers every OAuth
 * account of that provider, a file alias one account (and wins over the channel), and a key alias
 * sits in an API key's models list, which also limits the key to the models listed.
 */
export type AliasScope =
  | { kind: 'channel'; channel: string }
  | { kind: 'file'; name: string }
  | { kind: 'key'; authIndex: string };

export interface ModelAlias {
  scope: AliasScope;
  alias: string;
  upstream: string;
  /** OAuth only: keep serving the upstream name too. */
  fork: boolean;
}

export interface AliasChange {
  alias: string;
  upstream: string;
  fork: boolean;
}

export const scopeKey = (scope: AliasScope): string =>
  scope.kind === 'channel'
    ? `channel:${scope.channel}`
    : scope.kind === 'file'
      ? `file:${scope.name}`
      : `key:${scope.authIndex}`;

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const aliasesIn = (list: unknown, scope: AliasScope): ModelAlias[] =>
  (Array.isArray(list) ? list : []).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const upstream = text(entry.name);
    const alias = text(entry.alias);
    if (!upstream || !alias || alias === upstream) return [];
    return [{ scope, alias, upstream, fork: entry.fork === true }];
  });

/** Aliases in the api-keys tree of a raw v8 config. A list a group shares is reported once. */
export function keyAliasesFromConfig(raw: unknown): ModelAlias[] {
  const families = isRecord(raw) && isRecord(raw['api-keys']) ? raw['api-keys'] : {};
  return Object.values(families).flatMap((groups) =>
    (Array.isArray(groups) ? groups : []).flatMap((group) => {
      if (!isRecord(group) || !Array.isArray(group.keys)) return [];
      const keys = group.keys.filter(isRecord);
      const own = keys.flatMap((key) =>
        Array.isArray(key.models) && text(key.auth_index)
          ? aliasesIn(key.models, { kind: 'key', authIndex: text(key.auth_index) })
          : []
      );
      const firstInheriting = keys.find(
        (key) => !Array.isArray(key.models) && text(key.auth_index)
      );
      const shared = firstInheriting
        ? aliasesIn(group.models, { kind: 'key', authIndex: text(firstInheriting.auth_index) })
        : [];
      return [...own, ...shared];
    })
  );
}

/** A model an API key lists in config, whether or not the key is serving it right now. */
export interface KeyModel {
  authIndex: string;
  id: string;
  upstream: string;
}

/** Every API key's configured models list, its own or the one its group shares. */
export function keyModelsFromConfig(raw: unknown): KeyModel[] {
  const families = isRecord(raw) && isRecord(raw['api-keys']) ? raw['api-keys'] : {};
  return Object.values(families).flatMap((groups) =>
    (Array.isArray(groups) ? groups : []).flatMap((group) => {
      if (!isRecord(group) || !Array.isArray(group.keys)) return [];
      return group.keys.filter(isRecord).flatMap((key) => {
        const authIndex = text(key.auth_index);
        const list = Array.isArray(key.models) ? key.models : group.models;
        if (!authIndex || !Array.isArray(list)) return [];
        return list.flatMap((entry) => {
          const upstream = isRecord(entry) ? text(entry.name) : '';
          if (!upstream) return [];
          return [{ authIndex, id: text(entry.alias) || upstream, upstream }];
        });
      });
    })
  );
}

/** Applies one add, edit or removal to a raw alias list, keeping other entries and fields. */
export function editAliasList(
  list: readonly RawEntry[],
  original: { alias: string; upstream: string } | null,
  change: AliasChange | null,
  withFork: boolean
): RawEntry[] {
  const index = original
    ? list.findIndex(
        (entry) => text(entry.name) === original.upstream && text(entry.alias) === original.alias
      )
    : -1;
  if (original && index < 0) throw new Error(`alias ${original.alias} no longer exists`);
  const next = [...list];
  if (!change) {
    next.splice(index, 1);
    return next;
  }
  const entry: RawEntry = { ...(index >= 0 ? list[index] : {}) };
  entry.name = change.upstream.trim();
  entry.alias = change.alias.trim();
  if (withFork && change.fork) entry.fork = true;
  else delete entry.fork;
  if (index >= 0) next[index] = entry;
  else next.push(entry);
  return next;
}

/**
 * Edits the models list an API key uses (its own, else its group's) inside the api-keys tree.
 * Returns the family to write back, or null when no key has that auth index.
 */
export function editKeyModels(
  families: Record<string, unknown>,
  authIndex: string,
  edit: (list: RawEntry[]) => RawEntry[]
): string | null {
  for (const [family, groups] of Object.entries(families)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.keys)) continue;
      const key = group.keys.find(
        (candidate) => isRecord(candidate) && text(candidate.auth_index) === authIndex
      );
      if (!isRecord(key)) continue;
      const owner = Array.isArray(key.models) || !Array.isArray(group.models) ? key : group;
      owner.models = edit(Array.isArray(owner.models) ? owner.models.filter(isRecord) : []);
      return family;
    }
  }
  return null;
}

const fileAliases = async (name: string): Promise<RawEntry[] | null> => {
  const json: unknown = JSON.parse(await authFilesApi.downloadText(name));
  if (!isRecord(json)) return null;
  const drafts = readCredentialAliases(readCredentialPolicyValue(json, 'model_aliases'));
  return drafts === null ? null : buildCredentialAliases(drafts);
};

const CHANNEL_ALIASES_PATH = '/config/oauth/model-alias';

/**
 * Edits one provider's list in the raw oauth model-alias map. Upstream's normalized API would
 * drop fields it doesn't model, such as display-name, from the provider's other aliases.
 */
const saveChannelAliases = async (channel: string, edit: (list: RawEntry[]) => RawEntry[]) => {
  const assertConnection = guardConfigConnection();
  const current = await getConfigValue<unknown>(CHANNEL_ALIASES_PATH, {});
  assertConnection();
  const map = isRecord(current) ? current : {};
  const key = normalizeOAuthProviderKey(channel);
  // Config may spell the provider differently; every spelling counts as this provider.
  const spellings = Object.keys(map).filter((name) => normalizeOAuthProviderKey(name) === key);
  const list = spellings.flatMap((name) => {
    const entries = map[name];
    return Array.isArray(entries) ? entries.filter(isRecord) : [];
  });
  const next = Object.fromEntries(
    Object.entries(map).filter(([name]) => !spellings.includes(name))
  );
  // Reads come back with sorted keys; put name and alias first again, as config.yaml has them.
  const edited = edit(list).map(({ name, alias, ...rest }) => ({ name, alias, ...rest }));
  if (edited.length > 0) next[key] = edited;
  await apiClient.put(CHANNEL_ALIASES_PATH, next);
};

const saveKeyAliases = async (authIndex: string, edit: (list: RawEntry[]) => RawEntry[]) => {
  const assertConnection = guardConfigConnection();
  const raw = await apiClient.get('/config');
  assertConnection();
  const families = isRecord(raw) && isRecord(raw['api-keys']) ? raw['api-keys'] : {};
  const family = editKeyModels(families, authIndex, edit);
  if (!family) throw new Error('API key not found');
  const groups = (families[family] as unknown[]).map((group) =>
    isRecord(group) && Array.isArray(group.keys)
      ? {
          ...group,
          keys: group.keys.map((key) => {
            if (!isRecord(key)) return key;
            const rest = { ...key };
            delete rest.auth_index;
            return rest;
          }),
        }
      : group
  );
  await apiClient.put(`/config/api-keys/${family}`, groups);
};

export const modelAliasesApi = {
  /**
   * Every alias (OAuth channels, the given auth files, API keys; opaque files are skipped) and
   * every API key's configured models.
   */
  load: async (
    fileNames: readonly string[]
  ): Promise<{ aliases: ModelAlias[]; keyModels: KeyModel[] }> => {
    const [channels, config, files] = await Promise.all([
      authFilesApi.getOauthModelAlias(),
      apiClient.get('/config'),
      Promise.all(
        fileNames.map(async (name) => ({
          name,
          aliases: await fileAliases(name).catch(() => null),
        }))
      ),
    ]);
    const channelAliases = Object.entries(channels).flatMap(([channel, entries]) =>
      entries
        .filter((entry) => entry.alias && entry.alias !== entry.name)
        .map((entry) => ({
          scope: { kind: 'channel', channel } as AliasScope,
          alias: entry.alias,
          upstream: entry.name,
          fork: entry.fork === true,
        }))
    );
    const perFile = files.flatMap(({ name, aliases }) =>
      (aliases ?? []).flatMap((entry) => {
        const alias = String(entry.alias ?? '').trim();
        const upstream = String(entry.name ?? '').trim();
        return alias && upstream && alias !== upstream
          ? [
              {
                scope: { kind: 'file', name } as AliasScope,
                alias,
                upstream,
                fork: entry.fork === true,
              },
            ]
          : [];
      })
    );
    return {
      aliases: [...channelAliases, ...perFile, ...keyAliasesFromConfig(config)],
      keyModels: keyModelsFromConfig(config),
    };
  },

  /** Adds (no original), edits, or removes (no change) one alias where its scope stores it. */
  save: async (scope: AliasScope, original: ModelAlias | null, change: AliasChange | null) => {
    if (scope.kind === 'channel') {
      await saveChannelAliases(scope.channel, (list) =>
        editAliasList(list, original, change, true)
      );
      return;
    }
    if (scope.kind === 'file') {
      const current = await fileAliases(scope.name);
      if (current === null) throw new Error('unreadable model_aliases');
      const next = editAliasList(current, original, change, true);
      await authFilesApi.patchFields(scope.name, {
        model_aliases: next as AuthFileFieldsPatch['model_aliases'],
      });
      return;
    }
    await saveKeyAliases(scope.authIndex, (list) => editAliasList(list, original, change, false));
  },
};
