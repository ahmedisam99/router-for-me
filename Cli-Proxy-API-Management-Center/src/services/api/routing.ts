import { isRecord } from '@/utils/helpers';
import { normalizeRecentRequestBuckets, type RecentRequestBucket } from '@/utils/recentRequests';
import { apiClient } from './client';
import { authFilesApi } from './authFiles';
import { guardConfigConnection } from './configValue';

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
    models: (Array.isArray(value.models) ? value.models : [])
      .map(normalizeModel)
      .filter((model): model is RoutingModel => model !== null),
    recentRequests: normalizeRecentRequestBuckets(value.recent_requests),
  };
};

/** Config keys and auth files are the only credentials whose priority persists. */
export const canSetPriority = (credential: RoutingCredential) =>
  credential.source === 'config' || (credential.fileName !== '' && credential.source !== 'memory');

// OpenAI-compatible providers only take a group-level priority; other families take one per key.
const setConfigPriorities = async (priorities: Map<string, number>) => {
  const assertConnection = guardConfigConnection();
  const raw = await apiClient.get('/config');
  assertConnection();
  const families = isRecord(raw) && isRecord(raw['api-keys']) ? raw['api-keys'] : {};
  for (const [family, groups] of Object.entries(families)) {
    if (!Array.isArray(groups)) continue;
    let changed = false;
    const next = groups.map((group) => {
      if (!isRecord(group) || !Array.isArray(group.keys)) return group;
      let groupPriority: number | undefined;
      const keys = group.keys.map((key) => {
        if (!isRecord(key)) return key;
        const { auth_index: authIndex, ...rest } = key;
        const priority = priorities.get(text(authIndex));
        if (priority === undefined) return rest;
        changed = true;
        if (family !== 'openai-compatibility') return { ...rest, priority };
        groupPriority = Math.max(groupPriority ?? priority, priority);
        return rest;
      });
      return groupPriority === undefined
        ? { ...group, keys }
        : { ...group, keys, priority: groupPriority };
    });
    if (changed) await apiClient.put(`/config/api-keys/${family}`, next);
  }
};

export const routingApi = {
  listCredentials: async (): Promise<RoutingCredential[]> => {
    const raw = await apiClient.get('/routing/models');
    const list = isRecord(raw) && Array.isArray(raw.credentials) ? raw.credentials : [];
    return list.map(normalizeCredential).filter((item): item is RoutingCredential => item !== null);
  },

  setPriorities: async (changes: Array<{ credential: RoutingCredential; priority: number }>) => {
    const configPriorities = new Map<string, number>();
    const fileChanges: Array<{ name: string; priority: number }> = [];
    changes.forEach(({ credential, priority }) => {
      if (credential.source === 'config') configPriorities.set(credential.authIndex, priority);
      else if (canSetPriority(credential))
        fileChanges.push({ name: credential.fileName, priority });
    });
    if (configPriorities.size > 0) await setConfigPriorities(configPriorities);
    for (const { name, priority } of fileChanges) {
      await authFilesApi.patchFields(name, { priority });
    }
  },
};
