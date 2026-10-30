import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { TFunction } from 'i18next';
import { pickRanks } from '@/features/credentials/order';
import { buildCredentialRows } from '@/features/credentials/rows';
import { buildModelMap, inactiveRoutes } from '@/features/models/modelMap';
import { aliasTags, findAlias } from '@/features/models/scopes';
import type { ProviderResource } from '@/features/providers/types';
import { apiClient } from '@/services/api/client';
import { credentialRoutingApi, type RoutingCredential } from '@/services/api/credentialRouting';
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
  lastModels: [],
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
            last_models: [{ id: 'gpt-6-luna' }],
          },
          { auth_index: 'missing-id' },
        ],
      } as never)
    );
    const [item, ...rest] = await credentialRoutingApi.listCredentials();
    expect(rest).toEqual([]);
    expect(item).toMatchObject({ id: 'codex-a.json', authIndex: 'a1', priority: 3 });
    expect(item.models).toEqual([
      { id: 'claude-opus-5-5', upstream: ['gpt-6.1-sol'] },
      { id: 'gpt-5.5', upstream: ['gpt-5.5'] },
    ]);
    expect(item.lastModels).toEqual([{ id: 'gpt-6-luna', upstream: ['gpt-6-luna'] }]);
  });
});

describe('credential order', () => {
  const a = credential({ id: 'a', priority: 2 });
  const b = credential({ id: 'b', priority: 2 });
  const c = credential({ id: 'c', priority: 0, source: 'memory' });

  test('ranks every credential under fill-first and shares ranks across ties otherwise', () => {
    expect(pickRanks([a, b, c], 'fill-first')).toEqual([1, 2, 3]);
    const codex = credential({ id: 'x', priority: 2, provider: 'codex' });
    expect(pickRanks([a, codex, b, c], 'fill-first')).toEqual([1, 1, 1, 2]);
    expect(pickRanks([a, b, c], 'round-robin')).toEqual([1, 1, 2]);
    expect(pickRanks([a, b, c], undefined)).toEqual([1, 1, 2]);
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

  test('lists what a disabled credential last served once, beside its aliases', () => {
    const disabledAccount = {
      ...rows[0],
      disabled: true,
      credential: {
        ...rows[0].credential,
        models: [],
        lastModels: [
          { id: 'gpt', upstream: ['gpt'] },
          { id: 'opus', upstream: ['gpt'] },
        ],
      },
    };
    const routes = inactiveRoutes([disabledAccount], [channelAlias], []);
    expect(routes.map((route) => [route.id, route.upstream, route.reason])).toEqual([
      ['gpt', ['gpt'], 'disabled'],
      ['opus', ['gpt'], 'disabled'],
    ]);
    const map = buildModelMap([disabledAccount], 'fill-first', routes);
    expect(map.map((entry) => [entry.id, entry.live, entry.renamed])).toEqual([
      ['gpt', false, false],
      ['opus', false, true],
    ]);
  });

  test("lists a disabled provider's configured models when the backend leaves it out", () => {
    const openRouter = {
      id: 'openai:0',
      name: 'OpenRouter',
      brand: 'openaiCompatibility',
      authIndex: null,
      disabled: true,
      models: [],
      raw: {
        apiKeyEntries: [],
        models: [{ name: 'z-ai/glm-5.3-flash' }, { name: 'openai/gpt-6.1-sol', alias: 'sol' }],
      },
    } as unknown as ProviderResource;
    const leftOut = buildCredentialRows([], [openRouter], []);
    const routes = inactiveRoutes(leftOut, [], []);
    expect(routes.map((route) => [route.id, route.upstream, route.reason])).toEqual([
      ['z-ai/glm-5.3-flash', ['z-ai/glm-5.3-flash'], 'disabled'],
      ['sol', ['openai/gpt-6.1-sol'], 'disabled'],
    ]);
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
