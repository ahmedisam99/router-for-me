import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { authFilesApi } from '@/services/api/authFiles';
import { apiClient } from '@/services/api/client';
import {
  editAliasList,
  editKeyModels,
  keyAliasesFromConfig,
  keyModelsFromConfig,
  modelAliasesApi,
} from '@/services/api/modelAliases';

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

const config = () => ({
  'api-keys': {
    claude: [
      {
        name: 'claude-1',
        keys: [
          {
            'api-key': 'k1',
            auth_index: 'c1',
            models: [
              { name: 'opus' },
              { name: 'opus', alias: 'fable', thinking: { levels: ['high'] } },
            ],
          },
        ],
      },
    ],
    'openai-compatibility': [
      {
        name: 'router',
        models: [{ name: 'z-ai/glm', alias: 'glm' }],
        keys: [
          { 'api-key': 'k2', auth_index: 'o1' },
          { 'api-key': 'k3', auth_index: 'o2' },
        ],
      },
    ],
  },
});

describe('alias lists', () => {
  test('reads key aliases, reporting a list a group shares once', () => {
    expect(keyAliasesFromConfig(config())).toEqual([
      { scope: { kind: 'key', authIndex: 'c1' }, alias: 'fable', upstream: 'opus', fork: false },
      { scope: { kind: 'key', authIndex: 'o1' }, alias: 'glm', upstream: 'z-ai/glm', fork: false },
    ]);
  });

  test("lists every key's configured models, inherited ones per key", () => {
    expect(keyModelsFromConfig(config())).toEqual([
      { authIndex: 'c1', id: 'opus', upstream: 'opus' },
      { authIndex: 'c1', id: 'fable', upstream: 'opus' },
      { authIndex: 'o1', id: 'glm', upstream: 'z-ai/glm' },
      { authIndex: 'o2', id: 'glm', upstream: 'z-ai/glm' },
    ]);
  });

  test('adds, edits and removes one entry, keeping its other fields', () => {
    const list = [{ name: 'opus' }, { name: 'opus', alias: 'fable', thinking: 'high' }];
    expect(editAliasList(list, null, { alias: 'a', upstream: 'b', fork: true }, true)).toEqual([
      ...list,
      { name: 'b', alias: 'a', fork: true },
    ]);
    expect(
      editAliasList(
        list,
        { alias: 'fable', upstream: 'opus' },
        { alias: 'fable-2', upstream: 'opus', fork: true },
        false
      )
    ).toEqual([{ name: 'opus' }, { name: 'opus', alias: 'fable-2', thinking: 'high' }]);
    expect(editAliasList(list, { alias: 'fable', upstream: 'opus' }, null, false)).toEqual([
      { name: 'opus' },
    ]);
    expect(() => editAliasList(list, { alias: 'gone', upstream: 'x' }, null, false)).toThrow();
  });

  test('edits the list a key uses: its own, else its group', () => {
    const tree = config()['api-keys'];
    const add = (list: Record<string, unknown>[]) => [...list, { name: 'x', alias: 'y' }];
    expect(editKeyModels(tree, 'c1', add)).toBe('claude');
    expect(tree.claude[0].keys[0].models).toHaveLength(3);
    expect(editKeyModels(tree, 'o2', add)).toBe('openai-compatibility');
    expect(tree['openai-compatibility'][0].models).toHaveLength(2);
    expect(editKeyModels(tree, 'missing', add)).toBeNull();
  });
});

describe('model aliases API', () => {
  test('saves a key alias back to its family without auth indexes', async () => {
    spies.push(spyOn(apiClient, 'get').mockResolvedValue(config() as never));
    const put = spyOn(apiClient, 'put').mockResolvedValue({} as never);
    spies.push(put);

    await modelAliasesApi.save({ kind: 'key', authIndex: 'c1' }, null, {
      alias: 'sonnet',
      upstream: 'opus',
      fork: true,
    });

    expect(put).toHaveBeenCalledWith('/config/api-keys/claude', [
      {
        name: 'claude-1',
        keys: [
          {
            'api-key': 'k1',
            models: [
              { name: 'opus' },
              { name: 'opus', alias: 'fable', thinking: { levels: ['high'] } },
              { name: 'opus', alias: 'sonnet' },
            ],
          },
        ],
      },
    ]);
  });

  test('edits a channel alias, keeping fields of the others and other providers', async () => {
    spies.push(
      spyOn(apiClient, 'get').mockResolvedValue({
        Codex: [
          { name: 'gpt', alias: 'opus', fork: true },
          { name: 'gpt', alias: 'haiku', fork: true, 'display-name': 'Haiku via GPT' },
        ],
        'gemini-cli': [{ name: 'pro', alias: 'g' }],
      } as never)
    );
    const put = spyOn(apiClient, 'put').mockResolvedValue({} as never);
    spies.push(put);

    await modelAliasesApi.save(
      { kind: 'channel', channel: 'codex' },
      { scope: { kind: 'channel', channel: 'codex' }, alias: 'opus', upstream: 'gpt', fork: true },
      { alias: 'opus', upstream: 'gpt', fork: false }
    );
    expect(put).toHaveBeenCalledWith('/config/oauth/model-alias', {
      'gemini-cli': [{ name: 'pro', alias: 'g' }],
      codex: [
        { name: 'gpt', alias: 'opus' },
        { name: 'gpt', alias: 'haiku', fork: true, 'display-name': 'Haiku via GPT' },
      ],
    });
  });

  test('removing the last channel alias drops the channel', async () => {
    spies.push(
      spyOn(apiClient, 'get').mockResolvedValue({
        codex: [{ name: 'gpt', alias: 'opus', fork: true }],
      } as never)
    );
    const put = spyOn(apiClient, 'put').mockResolvedValue({} as never);
    spies.push(put);

    await modelAliasesApi.save(
      { kind: 'channel', channel: 'codex' },
      { scope: { kind: 'channel', channel: 'codex' }, alias: 'opus', upstream: 'gpt', fork: true },
      null
    );
    expect(put).toHaveBeenCalledWith('/config/oauth/model-alias', {});
  });

  test('writes a file alias through the credential fields patch', async () => {
    spies.push(
      spyOn(authFilesApi, 'downloadText').mockResolvedValue(
        JSON.stringify({ type: 'codex', model_aliases: [{ name: 'gpt', alias: 'opus' }] })
      )
    );
    const patch = spyOn(authFilesApi, 'patchFields').mockResolvedValue({} as never);
    spies.push(patch);

    await modelAliasesApi.save({ kind: 'file', name: 'a.json' }, null, {
      alias: 'haiku',
      upstream: 'gpt',
      fork: false,
    });
    expect(patch).toHaveBeenCalledWith('a.json', {
      model_aliases: [
        { name: 'gpt', alias: 'opus' },
        { name: 'gpt', alias: 'haiku' },
      ],
    });
  });
});
