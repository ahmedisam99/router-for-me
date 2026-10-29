import type { UsageRow } from '@/services/api/usageStats';

export type StatsRange = '24h' | '7d' | '30d' | '90d';

type BucketUnit = 'hour' | 'day';

export const STATS_RANGES: Record<StatsRange, { hours: number; unit: BucketUnit; step: number }> = {
  '24h': { hours: 24, unit: 'hour', step: 1 },
  '7d': { hours: 24 * 7, unit: 'hour', step: 6 },
  '30d': { hours: 24 * 30, unit: 'day', step: 1 },
  '90d': { hours: 24 * 90, unit: 'day', step: 1 },
};

export interface UsageTotals {
  requests: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  latencyMs: number;
  ttftMs: number;
  ttftCount: number;
}

const TOTAL_FIELDS = [
  'requests',
  'failed',
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cachedTokens',
  'totalTokens',
  'latencyMs',
  'ttftMs',
  'ttftCount',
] as const satisfies ReadonlyArray<keyof UsageTotals>;

export const emptyTotals = (): UsageTotals => ({
  requests: 0,
  failed: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
  latencyMs: 0,
  ttftMs: 0,
  ttftCount: 0,
});

const addRow = (totals: UsageTotals, row: UsageRow) => {
  TOTAL_FIELDS.forEach((field) => {
    totals[field] += row[field];
  });
};

export const sumRows = (rows: readonly UsageRow[]): UsageTotals => {
  const totals = emptyTotals();
  rows.forEach((row) => addRow(totals, row));
  return totals;
};

/** Start, in local time, of the bucket holding the instant. */
const bucketStart = (ms: number, unit: BucketUnit, step: number): number => {
  const date = new Date(ms);
  if (unit === 'day') {
    date.setHours(0, 0, 0, 0);
  } else {
    date.setMinutes(0, 0, 0);
    date.setHours(date.getHours() - (date.getHours() % step));
  }
  return date.getTime();
};

const nextBucket = (ms: number, unit: BucketUnit, step: number): number => {
  const date = new Date(ms);
  if (unit === 'day') date.setDate(date.getDate() + 1);
  else date.setHours(date.getHours() + step);
  return date.getTime();
};

/** Start of the oldest bucket; the range is a whole number of buckets ending with the current one. */
export const rangeStart = (range: StatsRange, now: number): number => {
  const { hours, unit, step } = STATS_RANGES[range];
  const date = new Date(bucketStart(now, unit, step));
  if (unit === 'day') date.setDate(date.getDate() - (hours / 24 - 1));
  else date.setHours(date.getHours() - (hours - step));
  return date.getTime();
};

export interface TimeBucket {
  start: number;
  totals: UsageTotals;
}

/** Every bucket from the range start to now, empty ones included, oldest first. */
export const timeBuckets = (
  rows: readonly UsageRow[],
  range: StatsRange,
  now: number
): TimeBucket[] => {
  const { unit, step } = STATS_RANGES[range];
  const buckets = new Map<number, TimeBucket>();
  for (let start = rangeStart(range, now); start <= now; start = nextBucket(start, unit, step)) {
    buckets.set(start, { start, totals: emptyTotals() });
  }
  rows.forEach((row) => {
    const bucket = buckets.get(bucketStart(row.hour * 1000, unit, step));
    if (bucket) addRow(bucket.totals, row);
  });
  return Array.from(buckets.values());
};

export interface BreakdownEntry {
  key: string;
  totals: UsageTotals;
}

/** Totals grouped by a row key, busiest first. */
export const breakdown = (
  rows: readonly UsageRow[],
  keyOf: (row: UsageRow) => string
): BreakdownEntry[] => {
  const groups = new Map<string, BreakdownEntry>();
  rows.forEach((row) => {
    const key = keyOf(row);
    let entry = groups.get(key);
    if (!entry) {
      entry = { key, totals: emptyTotals() };
      groups.set(key, entry);
    }
    addRow(entry.totals, row);
  });
  return Array.from(groups.values()).sort(
    (a, b) => b.totals.requests - a.totals.requests || a.key.localeCompare(b.key)
  );
};

/** The plugin's hint for a client key: first and last four characters, one each when short. */
export const apiKeyHint = (key: string): string => {
  const chars = Array.from(key.trim());
  if (chars.length === 0) return '';
  const visible = chars.length <= 8 ? 1 : 4;
  return `${chars.slice(0, visible).join('')}…${chars.slice(-visible).join('')}`;
};
