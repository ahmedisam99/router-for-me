import { isRecord } from '@/utils/helpers';
import { apiKeysApi } from './apiKeys';
import { apiClient } from './client';
import { guardConfigConnection } from './configValue';

/** Rolling windows a key's spend is measured over, smallest first. */
export const BUDGET_WINDOWS = ['5h', 'day', 'week', 'month'] as const;
export type BudgetWindow = (typeof BUDGET_WINDOWS)[number];

export type OverBudget = 'block' | 'warn';
export type RuleAction = 'block' | 'redirect';

/** What a key's PUT route takes. */
export interface KeySettings {
  enabled: boolean;
  /** Profile id, or '' for none. */
  profile: string;
  /** USD per window; a window without an entry has no budget. */
  budgets: Partial<Record<BudgetWindow, number>>;
  overBudget: OverBudget;
}

/** A client key from `access.api-keys`, with its policy and spend. */
export interface ClientKey extends KeySettings {
  /** Hex SHA-256 of the key; policy is stored by it. */
  id: string;
  key: string;
  spend: Record<BudgetWindow, number>;
  exceeded: BudgetWindow[];
  /** Unix ms, or null when never used. */
  lastUsed: number | null;
}

export interface ProfileRule {
  /** Glob patterns, matched case-insensitively. */
  models: string[];
  /** Effort levels; empty matches any. */
  efforts: string[];
  action: RuleAction;
  /** Redirect target; '' keeps the requested one. */
  redirectModel: string;
  redirectEffort: string;
}

export interface KeyProfile {
  /** Stable slug; '' for a profile not saved yet. */
  id: string;
  name: string;
  /** First match wins. */
  rules: ProfileRule[];
}

export interface ClientKeysData {
  keys: ClientKey[];
  profiles: KeyProfile[];
}

/** USD per 1M tokens. */
export interface TokenPrices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelPrice {
  model: string;
  imported: TokenPrices | null;
  override: TokenPrices | null;
}

export interface PriceTable {
  source: { name: string; url: string; fetchedAt: number | null; error: string };
  prices: ModelPrice[];
  /** Served models with neither an imported price nor an override. */
  unpriced: string[];
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const amount = (value: unknown) => {
  const number = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
};
const strings = (value: unknown) =>
  Array.isArray(value) ? value.map(text).filter(Boolean) : ([] as string[]);
const instant = (value: unknown) => {
  const ms = typeof value === 'string' && value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
};
const isWindow = (value: string): value is BudgetWindow =>
  (BUDGET_WINDOWS as readonly string[]).includes(value);

export const normalizeClientKey = (value: unknown): ClientKey | null => {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  if (!id) return null;
  const budgets: Partial<Record<BudgetWindow, number>> = {};
  const rawBudgets = isRecord(value.budgets) ? value.budgets : {};
  const rawSpend = isRecord(value.spend) ? value.spend : {};
  BUDGET_WINDOWS.forEach((window) => {
    const budget = amount(rawBudgets[window]);
    if (budget !== null) budgets[window] = budget;
  });
  return {
    id,
    key: typeof value.key === 'string' ? value.key : '',
    enabled: value.enabled !== false,
    profile: text(value.profile),
    budgets,
    overBudget: value.over_budget === 'warn' ? 'warn' : 'block',
    spend: Object.fromEntries(
      BUDGET_WINDOWS.map((window) => [window, amount(rawSpend[window]) ?? 0])
    ) as Record<BudgetWindow, number>,
    exceeded: strings(value.exceeded).filter(isWindow),
    lastUsed: instant(value.last_used),
  };
};

const normalizeRule = (value: unknown): ProfileRule | null => {
  if (!isRecord(value)) return null;
  return {
    models: strings(value.models),
    efforts: strings(value.efforts).map((effort) => effort.toLowerCase()),
    action: value.action === 'redirect' ? 'redirect' : 'block',
    redirectModel: text(value.redirect_model),
    redirectEffort: text(value.redirect_effort).toLowerCase(),
  };
};

export const normalizeProfile = (value: unknown): KeyProfile | null => {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const name = text(value.name) || id;
  if (!name) return null;
  return {
    id,
    name,
    rules: (Array.isArray(value.rules) ? value.rules : [])
      .map(normalizeRule)
      .filter((rule): rule is ProfileRule => rule !== null),
  };
};

const normalizeProfiles = (value: unknown) =>
  (Array.isArray(value) ? value : [])
    .map(normalizeProfile)
    .filter((profile): profile is KeyProfile => profile !== null);

export const normalizeClientKeys = (value: unknown): ClientKeysData => {
  const raw = isRecord(value) ? value : {};
  return {
    keys: (Array.isArray(raw.keys) ? raw.keys : [])
      .map(normalizeClientKey)
      .filter((key): key is ClientKey => key !== null),
    profiles: normalizeProfiles(raw.profiles),
  };
};

const normalizeTokenPrices = (value: unknown): TokenPrices | null =>
  isRecord(value)
    ? {
        input: amount(value.input) ?? 0,
        output: amount(value.output) ?? 0,
        cacheRead: amount(value.cache_read) ?? 0,
        cacheWrite: amount(value.cache_write) ?? 0,
      }
    : null;

export const normalizePriceTable = (value: unknown): PriceTable => {
  const raw = isRecord(value) ? value : {};
  const source = isRecord(raw.source) ? raw.source : {};
  return {
    source: {
      name: text(source.name),
      url: text(source.url),
      fetchedAt: instant(source.fetched_at),
      error: text(source.error),
    },
    prices: (Array.isArray(raw.prices) ? raw.prices : []).flatMap((item) => {
      const model = isRecord(item) ? text(item.model) : '';
      if (!isRecord(item) || !model) return [];
      return [
        {
          model,
          imported: normalizeTokenPrices(item.imported),
          override: normalizeTokenPrices(item.override),
        },
      ];
    }),
    unpriced: strings(raw.unpriced),
  };
};

const serializeRule = (rule: ProfileRule) => ({
  models: rule.models,
  efforts: rule.efforts,
  action: rule.action,
  ...(rule.action === 'redirect'
    ? { redirect_model: rule.redirectModel, redirect_effort: rule.redirectEffort }
    : {}),
});

/** A profile without an id gets one derived from its name by the backend. */
export const serializeProfile = (profile: KeyProfile) => ({
  ...(profile.id ? { id: profile.id } : {}),
  name: profile.name,
  rules: profile.rules.map(serializeRule),
});

export const serializeTokenPrices = (prices: TokenPrices) => ({
  input: prices.input,
  output: prices.output,
  cache_read: prices.cacheRead,
  cache_write: prices.cacheWrite,
});

export const keySettings = (key: ClientKey): KeySettings => ({
  enabled: key.enabled,
  profile: key.profile,
  budgets: key.budgets,
  overBudget: key.overBudget,
});

// Keys themselves live in upstream's access.api-keys list; these edit it by value.
const editKeyList = async (edit: (keys: string[]) => string[]) => {
  const assertConnection = guardConfigConnection();
  const keys = await apiKeysApi.list();
  assertConnection();
  const next = edit(keys);
  await apiKeysApi.replace(next);
  return next;
};

export const clientKeysApi = {
  list: async (): Promise<ClientKeysData> =>
    normalizeClientKeys(await apiClient.get('/client-keys')),

  updateKey: async (id: string, settings: KeySettings): Promise<ClientKey | null> =>
    normalizeClientKey(
      await apiClient.put(`/client-keys/keys/${encodeURIComponent(id)}`, {
        enabled: settings.enabled,
        profile: settings.profile,
        budgets: settings.budgets,
        over_budget: settings.overBudget,
      })
    ),

  /** Replaces the whole list; keys on a profile that is gone fall back to none. */
  replaceProfiles: async (profiles: KeyProfile[]): Promise<KeyProfile[]> => {
    const raw = await apiClient.put('/client-keys/profiles', {
      profiles: profiles.map(serializeProfile),
    });
    return normalizeProfiles(isRecord(raw) ? raw.profiles : raw);
  },

  getPrices: async (): Promise<PriceTable> =>
    normalizePriceTable(await apiClient.get('/client-keys/prices')),

  /** Sets a model's override, or removes it with null. */
  setPriceOverride: async (model: string, override: TokenPrices | null): Promise<PriceTable> =>
    normalizePriceTable(
      await apiClient.put('/client-keys/prices', {
        model,
        override: override ? serializeTokenPrices(override) : null,
      })
    ),

  /** Downloads the imported list again. */
  refreshPrices: async (): Promise<PriceTable> =>
    normalizePriceTable(await apiClient.post('/client-keys/prices/refresh')),

  /** Appends a key to access.api-keys; returns the new list. */
  addKey: (key: string) => editKeyList((keys) => [...keys, key]),

  /** Removes every copy of a key from access.api-keys; returns the new list. */
  removeKey: (key: string) => editKeyList((keys) => keys.filter((item) => item !== key)),
};
