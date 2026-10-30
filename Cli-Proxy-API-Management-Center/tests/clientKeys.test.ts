import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  budgetBars,
  budgetDraft,
  cleanProfile,
  parseBudgetDraft,
  parsePriceDraft,
  priceDraft,
  priceOrigin,
  profileProblem,
  profileSummary,
  ruleSummary,
} from '@/features/keys/keysModel';
import { apiKeysApi } from '@/services/api/apiKeys';
import { apiClient } from '@/services/api/client';
import {
  clientKeysApi,
  normalizeClientKeys,
  normalizePriceTable,
  serializeTokenPrices,
  type ClientKey,
  type KeyProfile,
  type ProfileRule,
} from '@/services/api/clientKeys';

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

const key = (overrides: Partial<ClientKey>): ClientKey => ({
  id: 'k',
  key: 'sk-test',
  enabled: true,
  profile: '',
  budgets: {},
  overBudget: 'block',
  spend: { '5h': 0, day: 0, week: 0, month: 0 },
  exceeded: [],
  lastUsed: null,
  ...overrides,
});

const rule = (overrides: Partial<ProfileRule>): ProfileRule => ({
  models: ['m'],
  efforts: [],
  action: 'block',
  redirectModel: '',
  redirectEffort: '',
  ...overrides,
});

describe('client keys normalizers', () => {
  test('reads the contract shape and fills defaults', () => {
    const data = normalizeClientKeys({
      windows: ['5h', 'day', 'week', 'month'],
      keys: [
        {
          id: '3f1c',
          key: 'sk-one',
          enabled: false,
          profile: 'siblings',
          budgets: { '5h': 5, week: 30, year: 9, day: -1 },
          over_budget: 'warn',
          spend: { '5h': 1.23, day: 2.5 },
          exceeded: ['5h', 'decade'],
          last_used: '2026-10-30T12:00:00Z',
        },
        { id: 'bare', key: 'sk-two' },
        { key: 'no-id' },
        'junk',
      ],
      profiles: [
        {
          id: 'siblings',
          name: 'Siblings',
          rules: [
            { models: ['claude-fable-5'], efforts: [], action: 'block' },
            {
              models: ['claude-opus-5-5'],
              efforts: ['XHIGH', 'max'],
              action: 'redirect',
              redirect_model: '',
              redirect_effort: 'high',
            },
          ],
        },
        { rules: [] },
      ],
    });

    expect(data.keys).toHaveLength(2);
    expect(data.keys[0]).toEqual({
      id: '3f1c',
      key: 'sk-one',
      enabled: false,
      profile: 'siblings',
      budgets: { '5h': 5, week: 30 },
      overBudget: 'warn',
      spend: { '5h': 1.23, day: 2.5, week: 0, month: 0 },
      exceeded: ['5h'],
      lastUsed: Date.parse('2026-10-30T12:00:00Z'),
    });
    expect(data.keys[1]).toMatchObject({
      enabled: true,
      profile: '',
      budgets: {},
      overBudget: 'block',
      lastUsed: null,
    });
    expect(data.profiles).toHaveLength(1);
    expect(data.profiles[0].rules[1]).toEqual({
      models: ['claude-opus-5-5'],
      efforts: ['xhigh', 'max'],
      action: 'redirect',
      redirectModel: '',
      redirectEffort: 'high',
    });
  });

  test('tolerates a missing or broken body', () => {
    expect(normalizeClientKeys(null)).toEqual({ keys: [], profiles: [] });
    expect(normalizePriceTable('nope')).toEqual({
      source: { name: '', url: '', fetchedAt: null, error: '' },
      prices: [],
      unpriced: [],
    });
  });

  test('reads the price table', () => {
    const table = normalizePriceTable({
      source: { name: 'LiteLLM', url: 'https://x', fetched_at: null, error: 'timeout' },
      prices: [
        {
          model: 'gpt-6.1-sol',
          imported: { input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 },
          override: null,
        },
        { model: '' },
      ],
      unpriced: ['some-model'],
    });
    expect(table.source).toEqual({
      name: 'LiteLLM',
      url: 'https://x',
      fetchedAt: null,
      error: 'timeout',
    });
    expect(table.prices).toEqual([
      {
        model: 'gpt-6.1-sol',
        imported: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
        override: null,
      },
    ]);
    expect(table.unpriced).toEqual(['some-model']);
  });
});

describe('client keys API', () => {
  test('writes a key in snake_case under its encoded id', async () => {
    const put = spyOn(apiClient, 'put').mockResolvedValue({ id: 'a/b', key: 'sk' } as never);
    spies.push(put);
    const result = await clientKeysApi.updateKey('a/b', {
      enabled: true,
      profile: 'p',
      budgets: { day: 2 },
      overBudget: 'warn',
    });
    expect(put).toHaveBeenCalledWith('/client-keys/keys/a%2Fb', {
      enabled: true,
      profile: 'p',
      budgets: { day: 2 },
      over_budget: 'warn',
    });
    expect(result?.id).toBe('a/b');
  });

  test('sends a new profile without an id and a block rule without redirect fields', async () => {
    const put = spyOn(apiClient, 'put').mockResolvedValue({ profiles: [] } as never);
    spies.push(put);
    await clientKeysApi.replaceProfiles([
      { id: '', name: 'New', rules: [rule({ redirectModel: 'stale' })] },
      {
        id: 'old',
        name: 'Old',
        rules: [rule({ action: 'redirect', redirectModel: 'm2', redirectEffort: 'low' })],
      },
    ]);
    expect(put).toHaveBeenCalledWith('/client-keys/profiles', {
      profiles: [
        { name: 'New', rules: [{ models: ['m'], efforts: [], action: 'block' }] },
        {
          id: 'old',
          name: 'Old',
          rules: [
            {
              models: ['m'],
              efforts: [],
              action: 'redirect',
              redirect_model: 'm2',
              redirect_effort: 'low',
            },
          ],
        },
      ],
    });
  });

  test('removes a key by value through the config list', async () => {
    spies.push(spyOn(apiKeysApi, 'list').mockResolvedValue(['a', 'b', 'a']));
    const replace = spyOn(apiKeysApi, 'replace').mockResolvedValue(undefined as never);
    spies.push(replace);
    expect(await clientKeysApi.removeKey('a')).toEqual(['b']);
    expect(replace).toHaveBeenCalledWith(['b']);
  });
});

describe('budget bars', () => {
  test('one bar per budgeted window, toned by share spent', () => {
    const bars = budgetBars(
      key({
        budgets: { '5h': 10, week: 10, month: 10 },
        spend: { '5h': 2, day: 50, week: 6, month: 9 },
      })
    );
    expect(bars.map((bar) => [bar.window, bar.percent, bar.tone])).toEqual([
      ['5h', 20, 'good'],
      ['week', 60, 'warning'],
      ['month', 90, 'critical'],
    ]);
  });

  test('the backend decides exceeded, and the bar caps at full', () => {
    const [bar] = budgetBars(
      key({ budgets: { day: 5 }, spend: { '5h': 0, day: 7, week: 0, month: 0 }, exceeded: ['day'] })
    );
    expect(bar).toMatchObject({ percent: 100, exceeded: true, tone: 'critical' });
    expect(budgetBars(key({ budgets: { day: 0 } }))[0]).toMatchObject({ percent: 100 });
  });
});

describe('budget drafts', () => {
  test('empty means no budget and a negative amount is invalid', () => {
    const draft = budgetDraft({ '5h': 5 });
    expect(draft).toEqual({ '5h': '5', day: '', week: '', month: '' });
    expect(parseBudgetDraft({ ...draft, week: ' 2.5 ' })).toEqual({ '5h': 5, week: 2.5 });
    expect(parseBudgetDraft({ ...draft, day: '-1' })).toBeNull();
  });
});

describe('rule summaries', () => {
  test('block and redirect in the proxy notation', () => {
    expect(ruleSummary(rule({ models: ['a', 'b'] }), 'blocked')).toBe('a, b → blocked');
    expect(
      ruleSummary(
        rule({
          models: ['opus'],
          efforts: ['xhigh', 'max'],
          action: 'redirect',
          redirectEffort: 'high',
        }),
        'blocked'
      )
    ).toBe('opus (xhigh, max) → (high)');
    expect(
      ruleSummary(rule({ action: 'redirect', redirectModel: 'small', redirectEffort: 'low' }), 'x')
    ).toBe('m → small(low)');
    expect(
      profileSummary(
        { id: 'p', name: 'P', rules: [rule({}), rule({ action: 'redirect', redirectModel: 'n' })] },
        'blocked'
      )
    ).toBe('m → blocked · m → n');
  });
});

describe('profile validation', () => {
  const others: KeyProfile[] = [{ id: 'kids', name: 'Kids', rules: [] }];

  test('cleaning trims, drops empty patterns and clears unused redirect fields', () => {
    expect(
      cleanProfile({
        id: 'p',
        name: '  Work ',
        rules: [rule({ models: [' a ', '', 'a', 'b'], redirectModel: 'x', redirectEffort: 'low' })],
      })
    ).toEqual({ id: 'p', name: 'Work', rules: [rule({ models: ['a', 'b'] })] });
  });

  test('reports the first problem the backend would reject', () => {
    const check = (profile: KeyProfile) => profileProblem(cleanProfile(profile), others);
    expect(check({ id: '', name: ' ', rules: [] })).toEqual({ key: 'name' });
    expect(check({ id: '', name: 'kids', rules: [] })).toEqual({ key: 'name_taken' });
    expect(check({ id: '', name: 'Ok', rules: [rule({}), rule({ models: [' '] })] })).toEqual({
      key: 'models',
      rule: 2,
    });
    expect(check({ id: '', name: 'Ok', rules: [rule({ action: 'redirect' })] })).toEqual({
      key: 'target',
      rule: 1,
    });
    expect(
      check({ id: '', name: 'Ok', rules: [rule({ action: 'redirect', redirectEffort: 'low' })] })
    ).toBeNull();
  });
});

describe('price overrides', () => {
  test('round-trip through the editor and the API shape', () => {
    const override = { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 };
    expect(parsePriceDraft(priceDraft(override))).toEqual(override);
    expect(parsePriceDraft({ ...priceDraft(null), input: '3' })).toEqual({
      input: 3,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(parsePriceDraft({ ...priceDraft(override), output: '-2' })).toBeNull();

    const table = normalizePriceTable({
      prices: [{ model: 'm', imported: null, override: serializeTokenPrices(override) }],
    });
    expect(table.prices[0].override).toEqual(override);
    expect(priceOrigin(table.prices[0])).toBe('override');
    expect(priceOrigin({ model: 'm', imported: override, override: null })).toBe('imported');
    expect(priceOrigin({ model: 'm', imported: null, override: null })).toBe('none');
  });

  test('a reset sends a null override', async () => {
    const put = spyOn(apiClient, 'put').mockResolvedValue({} as never);
    spies.push(put);
    await clientKeysApi.setPriceOverride('m', null);
    expect(put).toHaveBeenCalledWith('/client-keys/prices', { model: 'm', override: null });
  });
});
