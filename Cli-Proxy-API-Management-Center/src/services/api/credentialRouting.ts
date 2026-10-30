import { isRecord } from '@/utils/helpers';
import { normalizeRecentRequestBuckets, type RecentRequestBucket } from '@/utils/recentRequests';
import { apiClient } from './client';

export interface RoutingModel {
  id: string;
  /** Upstream models the ID resolves to on this credential; several when it is a pool. */
  upstream: string[];
}

/** A runtime credential, config API key or auth file, as the router sees it. */
export interface RoutingCredential {
  id: string;
  authIndex: string;
  fileName: string;
  provider: string;
  label: string;
  kind: string;
  source: string;
  priority: number;
  disabled: boolean;
  status: string;
  statusMessage: string;
  unavailable: boolean;
  nextRetryAfter: string | null;
  models: RoutingModel[];
  /** A disabled credential's models when it was last seen enabled; it serves none now. */
  lastModels: RoutingModel[];
  recentRequests: RecentRequestBucket[];
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const normalizeModel = (value: unknown): RoutingModel | null => {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  if (!id) return null;
  const upstream = Array.isArray(value.upstream) ? value.upstream.map(text).filter(Boolean) : [];
  return { id, upstream: upstream.length > 0 ? upstream : [id] };
};

const normalizeModels = (value: unknown): RoutingModel[] =>
  (Array.isArray(value) ? value : [])
    .map(normalizeModel)
    .filter((model): model is RoutingModel => model !== null);

const normalizeCredential = (value: unknown): RoutingCredential | null => {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  if (!id) return null;
  const priority = Number(value.priority);
  return {
    id,
    authIndex: text(value.auth_index),
    fileName: text(value.name),
    provider: text(value.provider),
    label: text(value.label),
    kind: text(value.kind),
    source: text(value.source),
    priority: Number.isInteger(priority) ? priority : 0,
    disabled: value.disabled === true,
    status: text(value.status),
    statusMessage: text(value.status_message),
    unavailable: value.unavailable === true,
    nextRetryAfter: text(value.next_retry_after) || null,
    models: normalizeModels(value.models),
    lastModels: normalizeModels(value.last_models),
    recentRequests: normalizeRecentRequestBuckets(value.recent_requests),
  };
};

export const credentialRoutingApi = {
  listCredentials: async (): Promise<RoutingCredential[]> => {
    const raw = await apiClient.get('/routing/models');
    const list = isRecord(raw) && Array.isArray(raw.credentials) ? raw.credentials : [];
    return list.map(normalizeCredential).filter((item): item is RoutingCredential => item !== null);
  },
};
