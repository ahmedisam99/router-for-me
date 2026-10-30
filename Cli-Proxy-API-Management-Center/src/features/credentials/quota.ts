import { useCallback, useEffect, useMemo } from 'react';
import { useQuotaBatchLoader } from '@/features/quota/hooks/useQuotaBatchLoader';
import { classifyQuotaFiles, type QuotaFileEntry } from '@/features/quota/logic';
import { getQuotaMap, QUOTA_ADAPTERS, type QuotaCardState } from '@/features/quota/providers';
import type { QuotaStore } from '@/features/quota/providers/types';
import { buildTimelineLane, laneHasWindow } from '@/features/quota/quotaTimelineModel';
import { useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';

/**
 * Quota-capable credentials among files, with their cached quota. Credentials never fetched in
 * this session load once; refreshing after that stays a deliberate action.
 */
export function useCredentialQuota(files: readonly AuthFileItem[]) {
  const entries = useMemo(() => classifyQuotaFiles([...files]), [files]);
  const store = useQuotaStore() as unknown as QuotaStore;
  const { loadQuota } = useQuotaBatchLoader();

  useEffect(() => {
    const missing = entries.filter(
      (entry) => !getQuotaMap(QUOTA_ADAPTERS[entry.type])[getQuotaCacheKey(entry.file)]
    );
    if (missing.length > 0) void loadQuota(missing);
  }, [entries, loadQuota]);

  const quotaFor = useCallback(
    (entry: QuotaFileEntry): QuotaCardState | undefined =>
      QUOTA_ADAPTERS[entry.type].storeSelector(store)[getQuotaCacheKey(entry.file)],
    [store]
  );

  return { entries, quotaFor };
}

const laneOf = (entry: QuotaFileEntry, quota: QuotaCardState | undefined) =>
  buildTimelineLane({
    name: entry.file.name,
    displayName: entry.file.name,
    provider: entry.type,
    quota,
  });

/** Whether the quota has a reset window the quota timeline can draw. */
export const quotaHasWindow = (entry: QuotaFileEntry, quota: QuotaCardState | undefined) =>
  laneHasWindow(laneOf(entry, quota));
