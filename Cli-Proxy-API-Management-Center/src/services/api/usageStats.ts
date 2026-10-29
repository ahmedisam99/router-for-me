import { useAuthStore } from '@/stores';
import { normalizeApiBase } from '@/utils/connection';
import { isRecord } from '@/utils/helpers';
import { apiClient } from './client';

/** Usage of one (hour, model, upstream model, credential, client key) combination. */
export interface UsageRow {
  /** Unix seconds at the start of the UTC hour. */
  hour: number;
  model: string;
  upstreamModel: string;
  provider: string;
  authIndex: string;
  authId: string;
  /** Hint of the client key, first and last four characters. */
  apiKey: string;
  requests: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  /** Sum over the row's requests; divide by requests. */
  latencyMs: number;
  /** Sum over streamed requests; divide by ttftCount. */
  ttftMs: number;
  ttftCount: number;
}

export interface UsageFailure {
  time: string;
  model: string;
  upstreamModel: string;
  provider: string;
  authIndex: string;
  authId: string;
  apiKey: string;
  status: number;
  message: string;
}

export interface UsageStats {
  rows: UsageRow[];
  failures: UsageFailure[];
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const count = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

const normalizeRow = (value: unknown): UsageRow | null => {
  if (!isRecord(value)) return null;
  const hour = Number(value.hour);
  if (!Number.isFinite(hour)) return null;
  return {
    hour,
    model: text(value.model),
    upstreamModel: text(value.upstream_model),
    provider: text(value.provider),
    authIndex: text(value.auth_index),
    authId: text(value.auth_id),
    apiKey: text(value.api_key),
    requests: count(value.requests),
    failed: count(value.failed),
    inputTokens: count(value.input_tokens),
    outputTokens: count(value.output_tokens),
    reasoningTokens: count(value.reasoning_tokens),
    cachedTokens: count(value.cached_tokens),
    totalTokens: count(value.total_tokens),
    latencyMs: count(value.latency_ms),
    ttftMs: count(value.ttft_ms),
    ttftCount: count(value.ttft_count),
  };
};

const normalizeFailure = (value: unknown): UsageFailure | null => {
  if (!isRecord(value)) return null;
  return {
    time: text(value.time),
    model: text(value.model),
    upstreamModel: text(value.upstream_model),
    provider: text(value.provider),
    authIndex: text(value.auth_index),
    authId: text(value.auth_id),
    apiKey: text(value.api_key),
    status: count(value.status),
    message: text(value.message),
  };
};

// Plugin routes keep the path the plugin declares, outside the v8 prefix.
const pluginRoute = (path: string) =>
  `${normalizeApiBase(useAuthStore.getState().apiBase)}/v0/management${path}`;

export const usageStatsApi = {
  /** Usage between two unix-second instants, served by our usage-stats plugin. */
  get: async (from: number, to: number): Promise<UsageStats> => {
    const raw = await apiClient.get(pluginRoute('/usage-stats'), { params: { from, to } });
    const rows = isRecord(raw) && Array.isArray(raw.rows) ? raw.rows : [];
    const failures = isRecord(raw) && Array.isArray(raw.failures) ? raw.failures : [];
    return {
      rows: rows.map(normalizeRow).filter((row): row is UsageRow => row !== null),
      failures: failures
        .map(normalizeFailure)
        .filter((failure): failure is UsageFailure => failure !== null),
    };
  },
};
