import type { TFunction } from 'i18next';
import {
  getTypeLabel,
  HEALTHY_AUTH_FILE_STATUS_MESSAGES,
  isRuntimeOnlyAuthFile,
} from '@/features/authFiles/constants';
import type { ProviderResource } from '@/features/providers/types';
import type { RoutingCredential } from '@/services/api/routing';
import type { AuthFileItem, OpenAIProviderConfig } from '@/types';
import { isRecord } from '@/utils/helpers';

/** A routing credential joined with whichever upstream editor owns it. */
export interface CredentialRow {
  credential: RoutingCredential;
  /** Config API key: the provider resource the AI Providers sheet edits. */
  resource: ProviderResource | null;
  /** Auth file: the item the auth file details sheet edits. */
  file: AuthFileItem | null;
  title: string;
  detail: string;
  disabled: boolean;
}

export const isOpenAICompatible = (provider: string) => provider.startsWith('openai-compat');

export const credentialProviderLabel = (row: CredentialRow, t: TFunction): string => {
  if (row.resource) return t(`providersPage.providerNames.${row.resource.brand}`);
  if (isOpenAICompatible(row.credential.provider)) {
    return t('providersPage.providerNames.openaiCompatibility');
  }
  return getTypeLabel(t, row.credential.provider);
};

const entryAuthIndexes = (config: unknown): string[] =>
  isRecord(config) && Array.isArray(config.apiKeyEntries)
    ? config.apiKeyEntries.flatMap((entry) =>
        isRecord(entry) && typeof entry.authIndex === 'string' ? [entry.authIndex] : []
      )
    : [];

// An OpenAI-compatible resource groups several keys, and a sponsor resource (Kimi, FennoAI, ...)
// several config entries of different families; each key is its own credential.
const resourceAuthIndexes = (resource: ProviderResource): string[] => {
  const indexes = resource.authIndex ? [resource.authIndex] : [];
  const raw = resource.raw;
  indexes.push(...entryAuthIndexes(raw));
  if (isRecord(raw)) {
    (['openai', 'claude', 'codex', 'gemini'] as const).forEach((family) => {
      const items = raw[family];
      if (!Array.isArray(items)) return;
      items.forEach((item) => {
        if (!isRecord(item) || !isRecord(item.config)) return;
        if (typeof item.config.authIndex === 'string') indexes.push(item.config.authIndex);
        indexes.push(...entryAuthIndexes(item.config));
      });
    });
  }
  return indexes;
};

const groupName = (resource: ProviderResource): string => {
  const raw = resource.raw;
  if (!isRecord(raw) || !isRecord(raw.source) || !isRecord(raw.source.group)) return '';
  const name = raw.source.group.name;
  return typeof name === 'string' ? name.trim() : '';
};

const hostOf = (url: string | null): string => {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const resourceRow = (credential: RoutingCredential, resource: ProviderResource): CredentialRow => ({
  credential,
  resource,
  file: null,
  title: resource.name || groupName(resource) || hostOf(resource.baseUrl) || credential.label,
  detail: [hostOf(resource.baseUrl), resource.apiKeyPreview].filter(Boolean).join(' · '),
  disabled: resource.disabled,
});

// The backend builds no credential for a disabled OpenAI-compatible provider, so it would vanish.
const disabledResourceCredential = (resource: ProviderResource): RoutingCredential => ({
  id: `config:${resource.id}`,
  authIndex: '',
  fileName: '',
  provider: resource.brand,
  label: resource.name ?? '',
  kind: 'apikey',
  source: '',
  priority: resource.priority,
  disabled: true,
  status: 'disabled',
  statusMessage: '',
  unavailable: false,
  nextRetryAfter: null,
  models: [],
  lastModels: [],
  recentRequests: [],
});

/**
 * One row per credential in pick order, then one per disabled config resource the backend left
 * out. A key of an OpenAI-compatible or sponsor resource is joined with the whole resource.
 */
export const buildCredentialRows = (
  credentials: readonly RoutingCredential[],
  resources: readonly ProviderResource[],
  files: readonly AuthFileItem[]
): CredentialRow[] => {
  const resourceByIndex = new Map<string, ProviderResource>();
  resources.forEach((resource) => {
    resourceAuthIndexes(resource).forEach((index) => {
      if (!resourceByIndex.has(index)) resourceByIndex.set(index, resource);
    });
  });
  const fileByIndex = new Map<string, AuthFileItem>();
  files.forEach((file) => {
    if (file.authIndex !== undefined && file.authIndex !== null) {
      fileByIndex.set(String(file.authIndex), file);
    }
  });

  const joined = new Set<ProviderResource>();
  const rows = credentials.map((credential): CredentialRow => {
    const resource = resourceByIndex.get(credential.authIndex) ?? null;
    if (resource) {
      joined.add(resource);
      return resourceRow(credential, resource);
    }
    const file = fileByIndex.get(credential.authIndex) ?? null;
    const email = typeof file?.email === 'string' ? file.email : '';
    return {
      credential,
      resource: null,
      file,
      title: email || credential.label || credential.fileName || credential.id,
      detail: credential.fileName,
      disabled: credential.disabled,
    };
  });
  const leftOut = resources.filter((resource) => resource.disabled && !joined.has(resource));
  return [
    ...rows,
    ...leftOut.map((resource) => resourceRow(disabledResourceCredential(resource), resource)),
  ];
};

/** The keys of an OpenAI-compatible provider that stay once the given ones are removed. */
export const keysLeft = (resource: ProviderResource, authIndexes: ReadonlySet<string>) =>
  resource.brand === 'openaiCompatibility'
    ? ((resource.raw as OpenAIProviderConfig).apiKeyEntries ?? []).filter(
        (entry) => !authIndexes.has(String(entry.authIndex ?? ''))
      )
    : [];

/** Whether an editor owns the row; a runtime-only auth file has no file to edit, like upstream. */
export const isEditable = (row: CredentialRow) =>
  Boolean(row.resource || (row.file && !isRuntimeOnlyAuthFile(row.file)));

export type StatusTone = 'ok' | 'warn' | 'error' | 'off';

/** The backend's status message for a row, unless it is one of the healthy ones. */
export const rowWarning = (row: CredentialRow): string => {
  const message = row.credential.statusMessage.trim();
  return !row.disabled && message && !HEALTHY_AUTH_FILE_STATUS_MESSAGES.has(message.toLowerCase())
    ? message
    : '';
};

const formatTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};

/** Tone and label of a row's status; `limitedFor` is the countdown to an exhausted limit's reset. */
export const credentialStatus = (
  row: CredentialRow,
  limitedFor: string | null,
  t: TFunction
): [StatusTone, string] => {
  const { credential } = row;
  if (row.disabled) return ['off', t('credentials.status.disabled')];
  if (credential.unavailable && credential.nextRetryAfter) {
    return [
      'warn',
      t('credentials.status.cooling', { time: formatTime(credential.nextRetryAfter) }),
    ];
  }
  if (credential.status === 'error') return ['error', t('credentials.status.error')];
  if (credential.unavailable) return ['warn', t('credentials.status.unavailable')];
  if (limitedFor !== null) return ['warn', t('credentials.status.limited', { time: limitedFor })];
  if (credential.models.length === 0) return ['warn', t('credentials.status.no_models')];
  return [rowWarning(row) ? 'warn' : 'ok', t('credentials.status.active')];
};
