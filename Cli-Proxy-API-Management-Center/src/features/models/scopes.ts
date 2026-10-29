import type { TFunction } from 'i18next';
import { getTypeLabel, normalizeProviderKey } from '@/features/authFiles/constants';
import { credentialProviderLabel, type CredentialRow } from '@/features/credentials/rows';
import { scopeKey, type AliasScope, type ModelAlias } from '@/services/api/modelAliases';

export interface ScopeOption {
  key: string;
  scope: AliasScope;
  label: string;
  /** Upstream names the scope's credentials serve, offered as suggestions. */
  upstreams: string[];
  /** An API key with no models list yet; its first alias limits it to the listed models. */
  restrictsKey: boolean;
}

const channelOf = (row: CredentialRow) => normalizeProviderKey(row.credential.provider);

const upstreamsOf = (rows: readonly CredentialRow[]) =>
  Array.from(
    new Set(rows.flatMap((row) => row.credential.models.flatMap((model) => model.upstream)))
  ).sort();

/** Every place an alias can live, labelled the way the alias table shows them. */
export function aliasScopes(
  rows: readonly CredentialRow[],
  channels: readonly string[],
  t: TFunction
): ScopeOption[] {
  const accounts = rows.filter((row) => row.file && row.credential.kind === 'oauth');
  const allChannels = Array.from(new Set([...accounts.map(channelOf), ...channels])).sort();

  return [
    ...allChannels.map((channel) => {
      const scope: AliasScope = { kind: 'channel', channel };
      return {
        key: scopeKey(scope),
        scope,
        label: t('models_page.scope_channel', { provider: getTypeLabel(t, channel) }),
        upstreams: upstreamsOf(accounts.filter((row) => channelOf(row) === channel)),
        restrictsKey: false,
      };
    }),
    ...accounts.map((row) => {
      const scope: AliasScope = { kind: 'file', name: row.file!.name };
      return {
        key: scopeKey(scope),
        scope,
        label: `${row.title} · ${credentialProviderLabel(row, t)}`,
        upstreams: upstreamsOf([row]),
        restrictsKey: false,
      };
    }),
    ...rows
      .filter((row) => row.resource)
      .map((row) => {
        const scope: AliasScope = { kind: 'key', authIndex: row.credential.authIndex };
        return {
          key: scopeKey(scope),
          scope,
          label: `${row.title} · ${credentialProviderLabel(row, t)} ${t('credentials.kind.apikey')}`,
          upstreams: upstreamsOf([row]),
          restrictsKey: row.resource!.models.length === 0,
        };
      }),
  ];
}

/** The credentials an alias applies to. */
export const scopedRows = (scope: AliasScope, rows: readonly CredentialRow[]) =>
  rows.filter((row) =>
    scope.kind === 'channel'
      ? row.file && row.credential.kind === 'oauth' && channelOf(row) === scope.channel
      : scope.kind === 'file'
        ? row.file?.name === scope.name
        : row.credential.authIndex === scope.authIndex
  );

/**
 * The definition behind a model a credential serves under another name: the file's own alias
 * first (it wins over the channel), then the channel's, then the key's, including a list the
 * key's group shares (reported under one of the group's keys).
 */
export function findAlias(
  aliases: readonly ModelAlias[],
  rows: readonly CredentialRow[],
  row: CredentialRow,
  id: string,
  upstream: string
): ModelAlias | null {
  const matching = aliases.filter((alias) => alias.alias === id && alias.upstream === upstream);
  if (row.file) {
    return (
      matching.find(
        (alias) => alias.scope.kind === 'file' && alias.scope.name === row.file?.name
      ) ??
      matching.find(
        (alias) => alias.scope.kind === 'channel' && alias.scope.channel === channelOf(row)
      ) ??
      null
    );
  }
  return (
    matching.find((alias) => {
      if (alias.scope.kind !== 'key') return false;
      const { authIndex } = alias.scope;
      if (authIndex === row.credential.authIndex) return true;
      const owner = rows.find((candidate) => candidate.credential.authIndex === authIndex);
      return Boolean(owner?.resource && owner.resource === row.resource);
    }) ?? null
  );
}
