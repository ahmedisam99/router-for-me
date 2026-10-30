import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { TFunction } from 'i18next';
import { lineRanks, moveItem, pickRanks, priorityChanges } from '@/features/credentials/order';
import {
  formatCountdown,
  limitedUntil,
  quotaLimits,
  quotaPlan,
} from '@/features/credentials/quota';
import {
  buildCredentialRows,
  credentialStatus,
  isEditable,
  keysLeft,
} from '@/features/credentials/rows';
import { buildModelMap, inactiveRoutes } from '@/features/models/modelMap';
import { aliasTags, findAlias } from '@/features/models/scopes';
import type { ProviderResource } from '@/features/providers/types';
import { apiClient } from '@/services/api/client';
import { canSetPriority, routingApi, type RoutingCredential } from '@/services/api/routing';
import type { QuotaFileEntry } from '@/features/quota/logic';
import type { QuotaCardState } from '@/features/quota/providers';
import type { AuthFileItem } from '@/types';

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

const credential = (overrides: Partial<RoutingCredential>): RoutingCredential => ({
  id: 'id',
  authIndex: 'idx',
  fileName: '',
  provider: 'claude',
  label: '',
  kind: 'apikey',
  source: 'config',
  priority: 0,
  disabled: false,
  status: 'active',
  statusMessage: '',
  unavailable: false,
  nextRetryAfter: null,
  models: [],
  recentRequests: [],
  ...overrides,
});

describe('routing API', () => {
  test('normalizes credentials and defaults upstream to the model itself', async () => {
    spies.push(
      spyOn(apiClient, 'get').mockResolvedValue({
        credentials: [
          {
            id: 'codex-a.json',
            auth_index: 'a1',
            name: 'codex-a.json',
            provider: 'codex',
            source: 'file',
            priority: 3,
            models: [{ id: 'claude-opus-5-5', upstream: ['gpt-6.1-sol'] }, { id: 'gpt-5.5' }],
          },
          { auth_index: 'missing-id' },
        ],
      } as never)
    );
    const [item, ...rest] = await routingApi.listCredentials();
    expect(rest).toEqual([]);
    expect(item).toMatchObject({ id: 'codex-a.json', authIndex: 'a1', priority: 3 });
    expect(item.models).toEqual([
      { id: 'claude-opus-5-5', upstream: ['gpt-6.1-sol'] },
      { id: 'gpt-5.5', upstream: ['gpt-5.5'] },
    ]);
  });

  test('writes key priorities per family, group priority for OpenAI-compatible, fields for files', async () => {
    spies.push(
      spyOn(apiClient, 'get').mockResolvedValue({
        'api-keys': {
          claude: [
            { name: 'claude-1', keys: [{ 'api-key': 'k1', auth_index: 'c1' }] },
            { name: 'claude-2', keys: [{ 'api-key': 'k2', auth_index: 'c2' }] },
          ],
          'openai-compatibility': [
            { name: 'router', priority: 9, keys: [{ 'api-key': 'k3', auth_index: 'o1' }] },
          ],
          gemini: [{ keys: [{ 'api-key': 'k4', auth_index: 'g1' }] }],
        },
      } as never)
    );
    const put = spyOn(apiClient, 'put').mockResolvedValue({} as never);
    const patch = spyOn(apiClient, 'patch').mockResolvedValue({} as never);
    spies.push(put, patch);

    await routingApi.setPriorities([
      { credential: credential({ authIndex: 'c2' }), priority: 4 },
      { credential: credential({ authIndex: 'o1' }), priority: 2 },
      {
        credential: credential({ authIndex: 'f1', source: 'file', fileName: 'a.json' }),
        priority: 1,
      },
    ]);

    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledWith('/config/api-keys/claude', [
      { name: 'claude-1', keys: [{ 'api-key': 'k1' }] },
      { name: 'claude-2', keys: [{ 'api-key': 'k2', priority: 4 }] },
    ]);
    expect(put).toHaveBeenCalledWith('/config/api-keys/openai-compatibility', [
      { name: 'router', priority: 2, keys: [{ 'api-key': 'k3' }] },
    ]);
    expect(patch).toHaveBeenCalledWith('/credentials/fields', { name: 'a.json', priority: 1 });
  });
});

describe('credential order', () => {
  const a = credential({ id: 'a', priority: 2 });
  const b = credential({ id: 'b', priority: 2 });
  const c = credential({ id: 'c', priority: 0, source: 'memory' });
  const d = credential({ id: 'd', priority: 0, source: 'file', fileName: 'd.json' });

  test('pins a new order with distinct priorities, skipping credentials that cannot hold one', () => {
    const changes = priorityChanges(moveItem([a, b, c, d], 3, 0));
    expect(changes.map(({ credential: item, priority }) => [item.id, priority])).toEqual([
      ['d', 3],
      ['b', 1],
    ]);
  });

  test('ranks every credential under fill-first and shares ranks across ties otherwise', () => {
    expect(pickRanks([a, b, c], 'fill-first')).toEqual([1, 2, 3]);
    const codex = credential({ id: 'x', priority: 2, provider: 'codex' });
    expect(pickRanks([a, codex, b, c], 'fill-first')).toEqual([1, 1, 1, 2]);
    expect(pickRanks([a, b, c], 'round-robin')).toEqual([1, 1, 2]);
    expect(pickRanks([a, b, c], undefined)).toEqual([1, 1, 2]);
  });

  test('leaves disabled rows out of line without shifting the others', () => {
    const rows = [a, b, c].map((item, index) => ({ credential: item, disabled: index === 1 }));
    expect(lineRanks(rows, 'fill-first')).toEqual([1, null, 2]);
  });
});

describe('credential rows and model map', () => {
  const resource = (overrides: Partial<ProviderResource>) =>
    ({
      id: 'r',
      brand: 'claude',
      name: null,
      authIndex: null,
      baseUrl: 'https://api.example.com/v1',
      apiKeyPreview: 'sk***1',
      disabled: false,
      raw: {},
      ...overrides,
    }) as ProviderResource;

  test('joins config keys, OpenAI-compatible keys and files by auth index', () => {
    const rows = buildCredentialRows(
      [
        credential({ id: 'k', authIndex: 'c1' }),
        credential({ id: 'o', authIndex: 'o2' }),
        credential({ id: 'f', authIndex: 'f1', source: 'file', fileName: 'f.json' }),
      ],
      [
        resource({ authIndex: 'c1', raw: { source: { group: { name: 'claude-1' } } } }),
        resource({
          brand: 'openaiCompatibility',
          name: 'Router',
          raw: { apiKeyEntries: [{ authIndex: 'o1' }, { authIndex: 'o2' }] },
        }),
      ],
      [{ name: 'f.json', authIndex: 'f1', email: 'me@example.com' } as AuthFileItem]
    );
    expect(rows.map((row) => [row.title, row.detail])).toEqual([
      ['claude-1', 'api.example.com · sk***1'],
      ['Router', 'api.example.com · sk***1'],
      ['me@example.com', 'f.json'],
    ]);
    expect(rows[2].file?.name).toBe('f.json');
  });

  test('joins sponsor keys to their bundle and keeps disabled providers the backend left out', () => {
    const sponsor = resource({
      id: 'kimi',
      brand: 'kimi',
      name: 'Kimi',
      raw: {
        openai: [{ index: 0, config: { apiKeyEntries: [{ authIndex: 's1' }] } }],
        claude: [{ index: 2, config: { authIndex: 's2' } }],
        codex: [],
        gemini: [],
      },
    });
    const off = resource({
      id: 'off',
      brand: 'openaiCompatibility',
      name: 'Router',
      disabled: true,
      raw: { apiKeyEntries: [{ authIndex: 'o1' }] },
    });
    const rows = buildCredentialRows(
      [credential({ id: 'a', authIndex: 's1' }), credential({ id: 'b', authIndex: 's2' })],
      [sponsor, off],
      []
    );
    expect(rows.map((row) => [row.credential.id, row.resource?.id, row.disabled])).toEqual([
      ['a', 'kimi', false],
      ['b', 'kimi', false],
      ['config:off', 'off', true],
    ]);
    expect(isEditable(rows[2])).toBe(true);
    expect(canSetPriority(rows[2].credential)).toBe(false);
  });

  test('removes single OpenAI-compatible keys and leaves other resources whole', () => {
    const router = resource({
      brand: 'openaiCompatibility',
      raw: { apiKeyEntries: [{ authIndex: 'o1' }, { authIndex: 'o2' }, { authIndex: 'o3' }] },
    });
    expect(keysLeft(router, new Set(['o1', 'o3'])).map((entry) => entry.authIndex)).toEqual(['o2']);
    expect(keysLeft(router, new Set(['o1', 'o2', 'o3']))).toEqual([]);
    expect(keysLeft(resource({ authIndex: 'c1' }), new Set(['c1']))).toEqual([]);
  });

  test('leaves runtime-only auth files without an editor', () => {
    const rows = buildCredentialRows(
      [credential({ id: 'f', authIndex: 'f1', source: 'file', fileName: 'f.json' })],
      [],
      [{ name: 'f.json', authIndex: 'f1', runtime_only: true } as AuthFileItem]
    );
    expect(isEditable(rows[0])).toBe(false);
  });

  test("names an exhausted quota limit's return after the backend's own states", () => {
    const t = ((key: string, values?: { time?: string }) =>
      values?.time ? `${key}:${values.time}` : key) as unknown as TFunction;
    const [row] = buildCredentialRows(
      [credential({ models: [{ id: 'm', upstream: ['m'] }] })],
      [],
      []
    );
    expect(credentialStatus(row, '46m', t)).toEqual(['warn', 'credentials.status.limited:46m']);
    expect(credentialStatus(row, null, t)).toEqual(['ok', 'credentials.status.active']);
    const unavailable = { ...row, credential: { ...row.credential, unavailable: true } };
    expect(credentialStatus(unavailable, '46m', t)[1]).toBe('credentials.status.unavailable');
  });

  test('lists each model with its credentials in pick order and flags renames', () => {
    const rows = buildCredentialRows(
      [
        credential({ id: 'one', models: [{ id: 'opus', upstream: ['opus'] }] }),
        credential({ id: 'two', models: [{ id: 'opus', upstream: ['gpt'] }] }),
        credential({ id: 'three', models: [{ id: 'gpt', upstream: ['gpt'] }] }),
      ],
      [],
      []
    );
    const map = buildModelMap(rows, 'fill-first');
    expect(map.map((entry) => [entry.id, entry.renamed])).toEqual([
      ['gpt', false],
      ['opus', true],
    ]);
    expect(map[1].routes.map((route) => [route.row.credential.id, route.rank])).toEqual([
      ['one', 1],
      ['two', 2],
    ]);
  });
});

describe('inactive routes', () => {
  const codexFile = { name: 'codex.json', authIndex: 'f1' } as AuthFileItem;
  const resource = { authIndex: 'k1', models: ['opus'], raw: {} } as unknown as ProviderResource;
  const rows = buildCredentialRows(
    [
      credential({
        id: 'codex.json',
        authIndex: 'f1',
        kind: 'oauth',
        source: 'file',
        fileName: 'codex.json',
        provider: 'codex',
        models: [{ id: 'opus', upstream: ['gpt'] }],
      }),
      credential({ id: 'k', authIndex: 'k1', models: [] }),
    ],
    [resource],
    [codexFile]
  );
  const disabledKey = { ...rows[1], disabled: true };
  const channelAlias = {
    scope: { kind: 'channel' as const, channel: 'codex' },
    alias: 'opus',
    upstream: 'gpt',
    fork: true,
    forceMapping: false,
  };
  const keyAlias = {
    scope: { kind: 'key' as const, authIndex: 'k1' },
    alias: 'fable',
    upstream: 'opus',
    fork: false,
    forceMapping: false,
  };

  test("adds a disabled key's list and aliases an account doesn't serve, not served ones", () => {
    const routes = inactiveRoutes(
      [rows[0], disabledKey],
      [channelAlias, { ...channelAlias, alias: 'haiku' }, keyAlias],
      [
        { authIndex: 'k1', id: 'opus', upstream: 'opus' },
        { authIndex: 'k1', id: 'fable', upstream: 'opus' },
      ]
    );
    expect(routes.map((route) => [route.row.credential.id, route.id, route.reason])).toEqual([
      ['k', 'opus', 'disabled'],
      ['k', 'fable', 'disabled'],
      ['codex.json', 'haiku', 'not-served'],
    ]);

    const map = buildModelMap([rows[0], disabledKey], 'fill-first', routes);
    const fable = map.find((entry) => entry.id === 'fable');
    expect(fable?.live).toBe(false);
    expect(fable?.routes[0]).toMatchObject({ rank: 0, inactive: 'disabled' });
  });

  test('tags an alias with where it applies, its names and its replies', () => {
    const t = ((key: string, values?: { provider?: string }) =>
      values?.provider ? `${key}:${values.provider}` : key) as unknown as TFunction;
    expect(aliasTags(channelAlias, t)).toEqual([
      'models_page.tags.channel:Codex',
      'models_page.tags.both_names',
    ]);
    const fileAlias = {
      ...channelAlias,
      scope: { kind: 'file' as const, name: 'codex.json' },
      fork: false,
      forceMapping: true,
    };
    expect(aliasTags(fileAlias, t)).toEqual([
      'models_page.tags.file',
      'models_page.tags.alias_only',
      'models_page.tags.force_mapping',
    ]);
    expect(aliasTags(keyAlias, t)).toEqual(['models_page.tags.key']);
  });

  test('finds the definition behind a renamed route', () => {
    expect(findAlias([channelAlias, keyAlias], rows, rows[0], 'opus', 'gpt')).toBe(channelAlias);
    expect(findAlias([channelAlias, keyAlias], rows, rows[1], 'fable', 'opus')).toBe(keyAlias);
    expect(findAlias([channelAlias, keyAlias], rows, rows[1], 'opus', 'gpt')).toBeNull();
  });
});

describe('credential quota', () => {
  const entry = (type: string) => ({ type, file: { name: 'f.json' } }) as unknown as QuotaFileEntry;
  const state = (fields: Record<string, unknown>) =>
    ({ status: 'success', windows: [], ...fields }) as unknown as QuotaCardState;

  test('gives every limit its reset and finds when an exhausted one returns', () => {
    const limits = quotaLimits(
      entry('claude'),
      state({
        windows: [
          { id: 'five-hour', label: '5-hour limit', usedPercent: 100, resetAtMs: 2_000 },
          { id: 'seven-day', label: '7-day limit', usedPercent: 40, resetAtMs: 9_000 },
          { id: 'seven-day-opus', label: '7-day Opus', usedPercent: 81, resetAtMs: 9_000 },
        ],
      })
    );
    expect(limits.map((limit) => [limit.label, limit.remaining, limit.resetAtMs])).toEqual([
      ['5-hour limit', 0, 2_000],
      ['7-day limit', 60, 9_000],
      ['7-day Opus', 19, 9_000],
    ]);
    expect(limitedUntil(limits)).toBe(2_000);
    expect(limitedUntil(limits.slice(1))).toBeNull();
  });

  test('names the plan as the quota card does', () => {
    const labels: Record<string, string> = {
      'codex_quota.plan_prolite': 'Pro 100',
      'claude_quota.plan_max': 'Max',
    };
    const t = ((key: string, options?: { defaultValue?: string }) =>
      labels[key] ?? options?.defaultValue ?? key) as unknown as TFunction;
    const renewal = '2026-11-13T19:15:00Z';
    expect(
      quotaPlan(
        entry('codex'),
        state({ planType: 'pro_lite', subscriptionActiveUntil: renewal }),
        t
      )
    ).toEqual({ label: 'Pro 100', renewsAtMs: Date.parse(renewal) });
    expect(quotaPlan(entry('claude'), state({ planType: 'plan_max' }), t)).toEqual({
      label: 'Max',
      renewsAtMs: null,
    });
    expect(quotaPlan(entry('codex'), state({ planType: 'enterprise' }), t)?.label).toBe(
      'enterprise'
    );
    expect(quotaPlan(entry('codex'), state({}), t)).toBeNull();
  });

  test('counts down in the coarsest whole unit', () => {
    expect(formatCountdown(46 * 60_000 + 5, 0, 'en')).toBe('46m');
    expect(formatCountdown(5 * 86_400_000, 0, 'en')).toBe('5d');
  });
});
