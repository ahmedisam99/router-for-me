import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  apiKeyHint,
  breakdown,
  rangeStart,
  sumRows,
  timeBuckets,
} from '@/features/stats/statsModel';
import { apiClient } from '@/services/api/client';
import { usageStatsApi, type UsageRow } from '@/services/api/usageStats';
import { useAuthStore } from '@/stores';

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

const row = (overrides: Partial<UsageRow>): UsageRow => ({
  hour: 0,
  model: 'm',
  upstreamModel: 'm',
  provider: 'p',
  authIndex: 'a',
  authId: 'a',
  apiKey: '',
  requests: 1,
  failed: 0,
  inputTokens: 10,
  outputTokens: 5,
  reasoningTokens: 0,
  cachedTokens: 0,
  totalTokens: 15,
  latencyMs: 100,
  ttftMs: 0,
  ttftCount: 0,
  ...overrides,
});

describe('usage stats API', () => {
  test('calls the plugin route outside the v8 prefix and normalizes rows', async () => {
    spies.push(
      spyOn(useAuthStore, 'getState').mockReturnValue({
        ...useAuthStore.getState(),
        apiBase: 'http://127.0.0.1:8317',
      })
    );
    const get = spyOn(apiClient, 'get').mockResolvedValue({
      rows: [{ hour: 3600, model: 'm', requests: 2, input_tokens: 7, latency_ms: 40 }, {}],
      failures: [{ time: '2026-10-20T12:00:00Z', status: 429, message: 'slow down' }],
    } as never);
    spies.push(get);

    const stats = await usageStatsApi.get(0, 7200);
    expect(get).toHaveBeenCalledWith('http://127.0.0.1:8317/v0/management/usage-stats', {
      params: { from: 0, to: 7200 },
    });
    expect(stats.rows).toHaveLength(1);
    expect(stats.rows[0]).toMatchObject({ hour: 3600, requests: 2, inputTokens: 7, latencyMs: 40 });
    expect(stats.failures[0]).toMatchObject({ status: 429, message: 'slow down' });
  });
});

describe('stats model', () => {
  test('sums rows and groups them busiest first', () => {
    const rows = [
      row({ model: 'a', requests: 1 }),
      row({ model: 'b', requests: 3, failed: 1 }),
      row({ model: 'a', requests: 1 }),
    ];
    expect(sumRows(rows)).toMatchObject({ requests: 5, failed: 1, totalTokens: 45 });
    expect(
      breakdown(rows, (item) => item.model).map((entry) => [entry.key, entry.totals.requests])
    ).toEqual([
      ['b', 3],
      ['a', 2],
    ]);
  });

  test('fills every bucket of the range and drops rows outside it', () => {
    const now = new Date(2026, 9, 20, 14, 30).getTime();
    const start = rangeStart('24h', now);
    expect(new Date(start).getMinutes()).toBe(0);
    const inside = row({
      hour: Math.floor(new Date(2026, 9, 20, 13).getTime() / 1000),
      requests: 4,
    });
    const outside = row({ hour: Math.floor((start - 3_600_000) / 1000), requests: 9 });
    const buckets = timeBuckets([inside, outside], '24h', now);
    expect(buckets).toHaveLength(24);
    expect(buckets.reduce((sum, bucket) => sum + bucket.totals.requests, 0)).toBe(4);
    expect(buckets[buckets.length - 2].totals.requests).toBe(4);
    expect(timeBuckets([], '7d', now)).toHaveLength(28);
    expect(timeBuckets([], '30d', now)).toHaveLength(30);
  });

  test('hints a client key the way the plugin does', () => {
    expect(apiKeyHint('sk-dev-client-key-0001')).toBe('sk-d…0001');
    expect(apiKeyHint('shortkey')).toBe('s…y');
    expect(apiKeyHint('')).toBe('');
  });
});
