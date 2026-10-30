import {
  BUDGET_WINDOWS,
  type BudgetWindow,
  type ClientKey,
  type KeyProfile,
  type ModelPrice,
  type ProfileRule,
  type TokenPrices,
} from '@/services/api/clientKeys';

export type BudgetTone = 'good' | 'warning' | 'critical';

export interface BudgetBar {
  window: BudgetWindow;
  spend: number;
  budget: number;
  /** Share of the budget spent, 0 to 100. */
  percent: number;
  exceeded: boolean;
  tone: BudgetTone;
}

/** One bar per budgeted window, toned like the Credentials quota bars by how much is used. */
export const budgetBars = (key: ClientKey): BudgetBar[] =>
  BUDGET_WINDOWS.flatMap((window) => {
    const budget = key.budgets[window];
    if (budget === undefined) return [];
    const spend = key.spend[window];
    const percent = budget > 0 ? Math.min(100, (spend / budget) * 100) : 100;
    const exceeded = key.exceeded.includes(window);
    const tone: BudgetTone =
      exceeded || percent > 80 ? 'critical' : percent > 50 ? 'warning' : 'good';
    return [{ window, spend, budget, percent, exceeded, tone }];
  });

const currencyFormatters = new Map<string, Intl.NumberFormat>();

/** USD with two decimals, or up to four for per-token prices such as $0.0375. */
export const formatUsd = (value: number, locale?: string, precise = false) => {
  const cacheKey = `${locale ?? ''}|${precise}`;
  let formatter = currencyFormatters.get(cacheKey);
  if (!formatter) {
    const options: Intl.NumberFormatOptions = {
      style: 'currency',
      currency: 'USD',
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 2,
      maximumFractionDigits: precise ? 4 : 2,
    };
    try {
      formatter = new Intl.NumberFormat(locale, options);
    } catch {
      formatter = new Intl.NumberFormat(undefined, options);
    }
    currencyFormatters.set(cacheKey, formatter);
  }
  return formatter.format(value);
};

/** A rule in the proxy's own `model(effort)` notation, such as `opus-* (xhigh, max) → (high)`. */
export const ruleSummary = (rule: ProfileRule, blockedLabel: string) => {
  const match = rule.efforts.length
    ? `${rule.models.join(', ')} (${rule.efforts.join(', ')})`
    : rule.models.join(', ');
  if (rule.action === 'block') return `${match} → ${blockedLabel}`;
  const effort = rule.redirectEffort ? `(${rule.redirectEffort})` : '';
  return `${match} → ${rule.redirectModel}${effort}`;
};

export const profileSummary = (profile: KeyProfile, blockedLabel: string) =>
  profile.rules.map((rule) => ruleSummary(rule, blockedLabel)).join(' · ');

/** Trims what the editor collects and drops empty patterns and unused redirect fields. */
export const cleanProfile = (profile: KeyProfile): KeyProfile => ({
  id: profile.id,
  name: profile.name.trim(),
  rules: profile.rules.map((rule) => {
    const models = [...new Set(rule.models.map((model) => model.trim()).filter(Boolean))];
    const redirect = rule.action === 'redirect';
    return {
      models,
      efforts: rule.efforts,
      action: rule.action,
      redirectModel: redirect ? rule.redirectModel.trim() : '',
      redirectEffort: redirect ? rule.redirectEffort : '',
    };
  }),
});

export interface ProfileProblem {
  /** Key under `keys_page.profile_errors`. */
  key: 'name' | 'name_taken' | 'models' | 'target';
  /** One-based rule number, for rule problems. */
  rule?: number;
}

/** The first thing the backend would reject in a cleaned profile, checked before saving. */
export const profileProblem = (
  profile: KeyProfile,
  others: readonly KeyProfile[]
): ProfileProblem | null => {
  if (!profile.name) return { key: 'name' };
  const name = profile.name.toLowerCase();
  if (others.some((other) => other.name.trim().toLowerCase() === name)) {
    return { key: 'name_taken' };
  }
  for (const [index, rule] of profile.rules.entries()) {
    if (rule.models.length === 0) return { key: 'models', rule: index + 1 };
    if (rule.action === 'redirect' && !rule.redirectModel && !rule.redirectEffort) {
      return { key: 'target', rule: index + 1 };
    }
  }
  return null;
};

/** A typed amount: undefined when empty, null when not a non-negative number. */
export const parseAmount = (value: string): number | undefined | null => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const number = Number(trimmed);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

export type BudgetDraft = Record<BudgetWindow, string>;

export const budgetDraft = (budgets: ClientKey['budgets']): BudgetDraft =>
  Object.fromEntries(
    BUDGET_WINDOWS.map((window) => [window, budgets[window]?.toString() ?? ''])
  ) as BudgetDraft;

/** Budgets from the editor's fields, or null when one isn't a valid amount. */
export const parseBudgetDraft = (draft: BudgetDraft): ClientKey['budgets'] | null => {
  const budgets: ClientKey['budgets'] = {};
  for (const window of BUDGET_WINDOWS) {
    const value = parseAmount(draft[window]);
    if (value === null) return null;
    if (value !== undefined) budgets[window] = value;
  }
  return budgets;
};

export const PRICE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
export type PriceField = (typeof PRICE_FIELDS)[number];
export const PRICE_FIELD_LABELS: Record<PriceField, string> = {
  input: 'keys_page.input',
  output: 'keys_page.output',
  cacheRead: 'keys_page.cache_read',
  cacheWrite: 'keys_page.cache_write',
};
export type PriceDraft = Record<PriceField, string>;

export type PriceOrigin = 'override' | 'imported' | 'none';

export const priceOrigin = (price: ModelPrice): PriceOrigin =>
  price.override ? 'override' : price.imported ? 'imported' : 'none';

export const effectivePrice = (price: ModelPrice) => price.override ?? price.imported;

export const priceDraft = (prices: TokenPrices | null): PriceDraft =>
  Object.fromEntries(
    PRICE_FIELDS.map((field) => [field, prices ? String(prices[field]) : ''])
  ) as PriceDraft;

/** An override from the editor's fields, empty ones at 0, or null when one is invalid. */
export const parsePriceDraft = (draft: PriceDraft): TokenPrices | null => {
  const prices: Partial<TokenPrices> = {};
  for (const field of PRICE_FIELDS) {
    const value = parseAmount(draft[field]);
    if (value === null) return null;
    prices[field] = value ?? 0;
  }
  return prices as TokenPrices;
};
