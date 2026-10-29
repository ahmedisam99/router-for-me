import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconRefreshCw } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { getTypeLabel } from '@/features/authFiles/constants';
import { apiKeyNameFingerprint, readApiKeyNames } from '@/features/config/apiKeyNames';
import { credentialProviderLabel } from '@/features/credentials/rows';
import { useCredentialRows } from '@/features/credentials/useCredentialRows';
import { ThroughputChart } from '@/features/dashboard/components/ThroughputChart';
import type { TrafficWindow } from '@/features/dashboard/types';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import type { ApiError } from '@/types';
import { usageStatsApi, type UsageRow, type UsageStats } from '@/services/api/usageStats';
import { useAuthStore, useConfigStore } from '@/stores';
import { formatCompactNumber, formatPercent } from '@/utils/format';
import { TokensChart } from './components/TokensChart';
import {
  STATS_RANGES,
  apiKeyHint,
  breakdown,
  rangeStart,
  sumRows,
  timeBuckets,
  type StatsRange,
  type TimeBucket,
  type UsageTotals,
} from './statsModel';
import styles from './StatsPage.module.scss';

const POLL_INTERVAL_MS = 60_000;
const RANGES = Object.keys(STATS_RANGES) as StatsRange[];
const LABEL_FORMATS: Record<StatsRange, Intl.DateTimeFormatOptions> = {
  '24h': { hour: '2-digit', minute: '2-digit' },
  '7d': { weekday: 'short', hour: '2-digit' },
  '30d': { month: 'short', day: 'numeric' },
  '90d': { month: 'short', day: 'numeric' },
};
type Dimension = 'model' | 'provider' | 'credential' | 'apiKey';
const DIMENSIONS: Dimension[] = ['model', 'provider', 'credential', 'apiKey'];

const formatDuration = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s` : `${Math.round(ms)}ms`;

const averageLatency = (totals: UsageTotals) =>
  totals.requests > 0 ? formatDuration(totals.latencyMs / totals.requests) : '—';

const successRate = (totals: UsageTotals) =>
  totals.requests > 0
    ? formatPercent(((totals.requests - totals.failed) / totals.requests) * 100)
    : '—';

export function StatsPage() {
  const { t, i18n } = useTranslation();
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const apiBase = useAuthStore((state) => state.apiBase);
  const clientKeys = useConfigStore((state) => state.config?.apiKeys);
  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.status === 'current' : true;

  const [range, setRange] = useState<StatsRange>('24h');
  const [dimension, setDimension] = useState<Dimension>('model');
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const { rows: credentialRows, reload: reloadCredentials } = useCredentialRows();

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    if (!connected) return;
    const now = Date.now();
    setLoading(true);
    try {
      const next = await usageStatsApi.get(
        Math.floor(rangeStart(range, now) / 1000),
        Math.ceil(now / 1000)
      );
      if (request !== requestRef.current) return;
      setStats(next);
      setFetchedAt(now);
      setMissing(false);
      setError(null);
    } catch (err) {
      if (request !== requestRef.current) return;
      if ((err as ApiError).status === 404) setMissing(true);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [connected, range]);

  // Credential labels follow edits made while the page is open.
  const refresh = useCallback(async () => {
    await Promise.all([load(), reloadCredentials()]);
  }, [load, reloadCredentials]);

  useEffect(() => {
    void load();
  }, [apiBase, load]);
  useEffect(() => {
    if (!isCurrentLayer || !connected || missing) return;
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [connected, isCurrentLayer, missing, refresh]);
  useHeaderRefresh(refresh, isCurrentLayer);

  const usageRows = useMemo(() => stats?.rows ?? [], [stats]);
  const totals = useMemo(() => sumRows(usageRows), [usageRows]);
  const buckets = useMemo(
    () => timeBuckets(usageRows, range, fetchedAt),
    [fetchedAt, range, usageRows]
  );

  const bucketLabel = useCallback(
    (bucket: TimeBucket) =>
      new Intl.DateTimeFormat(i18n.language, LABEL_FORMATS[range]).format(bucket.start),
    [i18n.language, range]
  );

  const traffic = useMemo<TrafficWindow>(() => {
    let peakIndex = -1;
    let peakTotal = 0;
    for (let index = 0; index < buckets.length; index += 1) {
      if (buckets[index].totals.requests > peakTotal) {
        peakTotal = buckets[index].totals.requests;
        peakIndex = index;
      }
    }
    const trafficBuckets = buckets.map((bucket) => ({
      time: bucketLabel(bucket),
      success: bucket.totals.requests - bucket.totals.failed,
      failed: bucket.totals.failed,
    }));
    return {
      buckets: trafficBuckets,
      totalSuccess: totals.requests - totals.failed,
      totalFailure: totals.failed,
      total: totals.requests,
      successRate: null,
      peakTotal,
      peakIndex,
      windowMinutes: STATS_RANGES[range].hours * 60,
    };
  }, [bucketLabel, buckets, range, totals]);

  const credentialLabels = useMemo(() => {
    const labels = new Map<string, string>();
    (credentialRows ?? []).forEach((row) => {
      labels.set(row.credential.authIndex, `${row.title} · ${credentialProviderLabel(row, t)}`);
    });
    return labels;
  }, [credentialRows, t]);

  const keyLabels = useMemo(() => {
    const names = readApiKeyNames(apiBase);
    const labels = new Map<string, string>();
    (clientKeys ?? []).forEach((key) => {
      const name = names[apiKeyNameFingerprint(apiBase, key)];
      labels.set(apiKeyHint(key), name ? `${name} · ${apiKeyHint(key)}` : apiKeyHint(key));
    });
    return labels;
  }, [apiBase, clientKeys]);

  const label = (dim: Dimension, key: string, row?: UsageRow) => {
    if (dim === 'model') return key || '—';
    if (dim === 'provider') return key ? getTypeLabel(t, key) : '—';
    if (dim === 'credential') {
      return credentialLabels.get(key) ?? (row?.authId || row?.provider || key || '—');
    }
    return keyLabels.get(key) ?? (key || t('stats_page.no_key'));
  };

  const groups = useMemo(() => {
    const keyOf: Record<Dimension, (row: UsageRow) => string> = {
      model: (row) => row.model,
      provider: (row) => row.provider,
      credential: (row) => row.authIndex,
      apiKey: (row) => row.apiKey,
    };
    return breakdown(usageRows, keyOf[dimension]);
  }, [dimension, usageRows]);
  const firstRowByKey = useMemo(() => {
    const map = new Map<string, UsageRow>();
    usageRows.forEach((row) => {
      if (!map.has(row.authIndex)) map.set(row.authIndex, row);
    });
    return map;
  }, [usageRows]);
  const maxRequests = groups[0]?.totals.requests ?? 0;

  const tile = (title: string, value: string, detail?: ReactNode) => (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{title}</span>
      <span className={styles.tileValue}>{value}</span>
      {detail ? <span className={styles.tileDetail}>{detail}</span> : null}
    </div>
  );

  const header = (
    <header className={styles.header}>
      <h1 className={styles.pageTitle}>{t('stats_page.title')}</h1>
      <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={!connected}>
        <IconRefreshCw size={16} />
        {t('common.refresh')}
      </Button>
    </header>
  );

  if (missing) {
    return (
      <div className={styles.page}>
        {header}
        <EmptyState title={t('stats_page.plugin_missing')} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {header}

      <div className={styles.filters} role="group" aria-label={t('stats_page.range')}>
        {RANGES.map((option) => (
          <button
            key={option}
            type="button"
            className={`${styles.rangeButton} ${option === range ? styles.rangeActive : ''}`}
            aria-pressed={option === range}
            onClick={() => setRange(option)}
          >
            {t(`stats_page.ranges.${option}`)}
          </button>
        ))}
      </div>

      {error ? <div className="error-box">{error}</div> : null}

      {!stats ? (
        <Skeleton height={420} />
      ) : (
        <div className={`${styles.body} ${loading ? styles.refreshing : ''}`.trim()}>
          <div className={styles.tiles}>
            {tile(t('stats_page.requests'), formatCompactNumber(totals.requests))}
            {tile(
              t('stats_page.success_rate'),
              successRate(totals),
              t('stats_page.failed_count', { count: totals.failed })
            )}
            {tile(
              t('stats_page.tokens'),
              formatCompactNumber(totals.totalTokens),
              t('stats_page.tokens_detail', {
                input: formatCompactNumber(totals.inputTokens),
                output: formatCompactNumber(totals.outputTokens),
              })
            )}
            {tile(
              t('stats_page.latency'),
              averageLatency(totals),
              totals.ttftCount > 0
                ? t('stats_page.ttft', { value: formatDuration(totals.ttftMs / totals.ttftCount) })
                : undefined
            )}
          </div>

          <div className={styles.charts}>
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>{t('stats_page.requests')}</h2>
              <ThroughputChart traffic={traffic} />
            </section>
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>{t('stats_page.tokens')}</h2>
              <TokensChart buckets={buckets} label={bucketLabel} />
            </section>
          </div>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>{t('stats_page.breakdown')}</h2>
              <div className={styles.segmented} role="group">
                {DIMENSIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`${styles.rangeButton} ${option === dimension ? styles.rangeActive : ''}`}
                    aria-pressed={option === dimension}
                    onClick={() => setDimension(option)}
                  >
                    {t(`stats_page.dimensions.${option}`)}
                  </button>
                ))}
              </div>
            </div>
            {groups.length === 0 ? (
              <p className={styles.none}>{t('stats_page.no_requests')}</p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">{t(`stats_page.dimensions.${dimension}`)}</th>
                      <th scope="col">{t('stats_page.requests')}</th>
                      <th scope="col">{t('stats_page.success_rate')}</th>
                      <th scope="col">{t('stats_page.input')}</th>
                      <th scope="col">{t('stats_page.output')}</th>
                      <th scope="col">{t('stats_page.cached')}</th>
                      <th scope="col">{t('stats_page.latency')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((group) => (
                      <tr key={group.key}>
                        <th scope="row" className={styles.nameCell}>
                          {label(dimension, group.key, firstRowByKey.get(group.key))}
                        </th>
                        <td>
                          <span className={styles.share}>
                            <span
                              className={styles.shareBar}
                              style={{
                                width: `${maxRequests > 0 ? (group.totals.requests / maxRequests) * 100 : 0}%`,
                              }}
                            />
                          </span>
                          {group.totals.requests.toLocaleString()}
                        </td>
                        <td>{successRate(group.totals)}</td>
                        <td>{formatCompactNumber(group.totals.inputTokens)}</td>
                        <td>{formatCompactNumber(group.totals.outputTokens)}</td>
                        <td>{formatCompactNumber(group.totals.cachedTokens)}</td>
                        <td>{averageLatency(group.totals)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={styles.card}>
            <h2 className={styles.cardTitle}>{t('stats_page.failures')}</h2>
            {stats.failures.length === 0 ? (
              <p className={styles.none}>{t('stats_page.no_failures')}</p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={`${styles.table} ${styles.textTable}`}>
                  <thead>
                    <tr>
                      <th scope="col">{t('stats_page.time')}</th>
                      <th scope="col">{t('stats_page.dimensions.model')}</th>
                      <th scope="col">{t('stats_page.dimensions.credential')}</th>
                      <th scope="col">{t('stats_page.status')}</th>
                      <th scope="col">{t('stats_page.message')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.failures.map((failure, index) => (
                      <tr key={`${failure.time}-${index}`}>
                        <td className={styles.nowrap}>
                          {new Date(failure.time).toLocaleString(i18n.language)}
                        </td>
                        <td>{failure.model}</td>
                        <td>
                          {credentialLabels.get(failure.authIndex) ??
                            (failure.authId || failure.provider)}
                        </td>
                        <td>{failure.status || '—'}</td>
                        <td className={styles.message} title={failure.message}>
                          {failure.message}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
