import { useCallback, useEffect, useMemo } from 'react';
import type { TFunction } from 'i18next';
import { useQuotaBatchLoader } from '@/features/quota/hooks/useQuotaBatchLoader';
import { classifyQuotaFiles, type QuotaFileEntry } from '@/features/quota/logic';
import { getQuotaMap, QUOTA_ADAPTERS, type QuotaCardState } from '@/features/quota/providers';
import type { QuotaStore } from '@/features/quota/providers/types';
import {
  buildTimelineLane,
  laneHasWindow,
  type TimelineLimit,
} from '@/features/quota/quotaTimelineModel';
import { useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { isRecord } from '@/utils/helpers';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { normalizePlanType } from '@/utils/quota/parsers';
import { relativeTimeParts } from '@/utils/quota/relativeTime';
import { resolveResetMs } from '@/utils/quota/resetInstants';

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

export interface QuotaLimit extends TimelineLimit {
  resetAtMs: number | null;
}

// Upstream's lane keeps a limit's label and remaining percent only; the reset instant is read back
// from the quota by label, so the lane and its tests stay untouched.
const resetsByLabel = (quota: QuotaCardState | undefined) => {
  const resets = new Map<string, number>();
  (['windows', 'buckets', 'rows'] as const).forEach((key) => {
    const items = (quota as Record<string, unknown> | undefined)?.[key];
    if (!Array.isArray(items)) return;
    items.forEach((item) => {
      if (!isRecord(item) || typeof item.label !== 'string') return;
      if (typeof item.resetAtMs === 'number' && !resets.has(item.label)) {
        resets.set(item.label, item.resetAtMs);
      }
    });
  });
  return resets;
};

/** Remaining percent and reset instant of each limit the provider reports, in its order. */
export const quotaLimits = (
  entry: QuotaFileEntry,
  quota: QuotaCardState | undefined
): QuotaLimit[] => {
  const resets = resetsByLabel(quota);
  return laneOf(entry, quota).limits.map((limit) => ({
    ...limit,
    resetAtMs: resets.get(limit.label) ?? null,
  }));
};

/** When the first exhausted limit resets, or null while every limit has some left. */
export const limitedUntil = (limits: readonly QuotaLimit[]): number | null => {
  const resets = limits.flatMap((limit) =>
    limit.remaining <= 0 && typeof limit.resetAtMs === 'number' ? [limit.resetAtMs] : []
  );
  return resets.length > 0 ? Math.min(...resets) : null;
};

// The Codex quota card's own labels for plan types that don't map to a key by name.
const CODEX_PLAN_KEYS: Record<string, string> = {
  'pro-lite': 'prolite',
  pro_lite: 'prolite',
  self_serve_business_prolite: 'business_premium',
};

/** The plan name the quota card shows, and when the subscription renews, if known. */
export const quotaPlan = (
  entry: QuotaFileEntry,
  quota: QuotaCardState | undefined,
  t: TFunction
): { label: string; renewsAtMs: number | null } | null => {
  if (quota?.status !== 'success') return null;
  const { planType, subscriptionActiveUntil } = quota as {
    planType?: unknown;
    subscriptionActiveUntil?: unknown;
  };
  const plan = normalizePlanType(planType);
  if (!plan) return null;
  // Claude stores the label key's suffix (plan_max); Codex stores the raw plan type.
  const key = plan.startsWith('plan_') ? plan : `plan_${CODEX_PLAN_KEYS[plan] ?? plan}`;
  const label = t(`${entry.type}_quota.${key}`, { defaultValue: '' }) || String(planType);
  return { label, renewsAtMs: resolveResetMs([subscriptionActiveUntil]) };
};

/** A short countdown such as "46m", "3h" or "4d", in the given locale. */
export const formatCountdown = (targetMs: number, nowMs: number, locale?: string) => {
  const { value, unit } = relativeTimeParts(targetMs, nowMs);
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(
    Math.max(value, 1)
  );
};

/** Whether the quota has a reset window the quota timeline can draw. */
export const quotaHasWindow = (entry: QuotaFileEntry, quota: QuotaCardState | undefined) =>
  laneHasWindow(laneOf(entry, quota));
