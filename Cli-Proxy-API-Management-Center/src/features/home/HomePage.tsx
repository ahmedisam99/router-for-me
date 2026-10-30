import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { Button } from '@/components/ui/Button';
import { IconRefreshCw } from '@/components/ui/icons';
import { quotaHasWindow, useCredentialQuota } from '@/features/credentials/quota';
import { credentialProviderLabel } from '@/features/credentials/rows';
import { useCredentialRows } from '@/features/credentials/useCredentialRows';
import { Sparkline } from '@/features/dashboard/components/Sparkline';
import dashboard from '@/features/dashboard/dashboard.module.scss';
import { QuotaTimeline } from '@/features/quota/components/QuotaTimeline';
import { rangeStart, sumRows, timeBuckets } from '@/features/stats/statsModel';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { usageStatsApi, type UsageStats } from '@/services/api/usageStats';
import { useAuthStore, useConfigStore, useThemeStore } from '@/stores';
import type { ApiError } from '@/types';
import { formatCompactNumber, formatDateValue, formatPercent } from '@/utils/format';
import styles from './HomePage.module.scss';

const DASH = '—';
const RECENT_FAILURES = 5;

const formatDuration = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s` : `${Math.round(ms)}ms`;

export function HomePage() {
  const { t, i18n } = useTranslation();
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const apiBase = useAuthStore((state) => state.apiBase);
  const serverVersion = useAuthStore((state) => state.serverVersion);
  const serverBuildDate = useAuthStore((state) => state.serverBuildDate);
  const config = useConfigStore((state) => state.config);
  const theme = useThemeStore((state) => state.resolvedTheme);
  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.status === 'current' : true;

  const { rows, error: credentialsError, refresh: refreshCredentials } = useCredentialRows();
  const files = useMemo(() => (rows ?? []).flatMap((row) => (row.file ? [row.file] : [])), [rows]);
  const { entries: quotaEntries, quotaFor } = useCredentialQuota(files);

  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [usageMissing, setUsageMissing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  const requestRef = useRef(0);

  const loadUsage = useCallback(async () => {
    const request = ++requestRef.current;
    if (!connected) return;
    const now = Date.now();
    try {
      const next = await usageStatsApi.get(
        Math.floor(rangeStart('24h', now) / 1000),
        Math.ceil(now / 1000)
      );
      if (request !== requestRef.current) return;
      setUsage(next);
      setFetchedAt(now);
      setUsageMissing(false);
    } catch (err) {
      if (request !== requestRef.current) return;
      setUsageMissing((err as ApiError).status === 404);
    }
  }, [connected]);

  useEffect(() => {
    void loadUsage();
  }, [apiBase, loadUsage]);

  const refresh = useCallback(async () => {
    await Promise.allSettled([loadUsage(), refreshCredentials()]);
  }, [loadUsage, refreshCredentials]);
  useHeaderRefresh(refresh, isCurrentLayer);

  const totals = useMemo(() => sumRows(usage?.rows ?? []), [usage]);
  const hours = useMemo(
    () => timeBuckets(usage?.rows ?? [], '24h', fetchedAt).map((bucket) => bucket.totals),
    [fetchedAt, usage]
  );
  const successRate =
    totals.requests > 0 ? ((totals.requests - totals.failed) / totals.requests) * 100 : null;

  const tiles = [
    {
      key: 'requests',
      label: t('stats_page.requests'),
      value: formatCompactNumber(totals.requests),
      hint: t('stats_page.failed_count', { count: totals.failed }),
      points: hours.map((hour) => hour.requests),
      color: 'var(--viz-success)',
    },
    {
      key: 'success',
      label: t('stats_page.success_rate'),
      value: successRate === null ? DASH : formatPercent(successRate),
      hint: t('home.last_24h'),
      points: hours.map((hour) => (hour.requests > 0 ? hour.requests - hour.failed : 0)),
      color: 'var(--viz-success)',
      accent:
        successRate === null
          ? undefined
          : successRate >= 95
            ? 'var(--viz-success)'
            : successRate >= 80
              ? 'var(--amber-color)'
              : 'var(--viz-failure)',
    },
    {
      key: 'tokens',
      label: t('stats_page.tokens'),
      value: formatCompactNumber(totals.totalTokens),
      hint: t('stats_page.tokens_detail', {
        input: formatCompactNumber(totals.inputTokens),
        output: formatCompactNumber(totals.outputTokens),
      }),
      points: hours.map((hour) => hour.totalTokens),
      color: 'var(--viz-tokens)',
    },
    {
      key: 'latency',
      label: t('stats_page.latency'),
      value: totals.requests > 0 ? formatDuration(totals.latencyMs / totals.requests) : DASH,
      hint:
        totals.ttftCount > 0
          ? t('stats_page.ttft', { value: formatDuration(totals.ttftMs / totals.ttftCount) })
          : t('home.last_24h'),
      points: hours.map((hour) => (hour.requests > 0 ? hour.latencyMs / hour.requests : 0)),
      color: 'var(--text-tertiary)',
    },
  ];

  const health = useMemo(() => {
    const list = rows ?? [];
    const byType = new Map<string, number>();
    list.forEach((row) => {
      const label = credentialProviderLabel(row, t);
      byType.set(label, (byType.get(label) ?? 0) + 1);
    });
    const disabled = list.filter((row) => row.disabled).length;
    const unavailable = list.filter(
      (row) => !row.disabled && (row.credential.unavailable || row.credential.status === 'error')
    ).length;
    return {
      total: list.length,
      active: list.length - disabled - unavailable,
      unavailable,
      disabled,
      byType: Array.from(byType.entries()).sort((a, b) => b[1] - a[1]),
    };
  }, [rows, t]);

  const strategy = config?.routingStrategy?.trim() ?? '';
  const runtimeRows: Array<{ label: string; value: string; mono?: boolean }> = [
    {
      label: t('dashboard.runtime_routing'),
      value: strategy ? t(`credentials.strategy.${strategy}`, { defaultValue: strategy }) : DASH,
    },
    { label: t('dashboard.runtime_retry'), value: String(config?.requestRetry ?? 0) },
    { label: t('home.client_keys'), value: String(config?.apiKeys?.length ?? 0) },
    { label: t('dashboard.runtime_version'), value: serverVersion?.trim() || DASH },
    {
      label: t('dashboard.runtime_build'),
      value: formatDateValue(serverBuildDate, i18n.language) || DASH,
    },
    { label: t('dashboard.runtime_proxy'), value: config?.proxyUrl?.trim() || DASH, mono: true },
  ];
  const runtimeToggles = config
    ? [
        { label: t('dashboard.runtime_debug'), on: Boolean(config.debug) },
        { label: t('dashboard.runtime_file_logging'), on: Boolean(config.loggingToFile) },
        { label: t('dashboard.runtime_request_log'), on: Boolean(config.requestLog) },
        { label: t('dashboard.runtime_ws_auth'), on: Boolean(config.wsAuth) },
        { label: t('dashboard.runtime_model_prefix'), on: Boolean(config.forceModelPrefix) },
      ]
    : [];

  const labelForAuthIndex = (authIndex: string, fallback: string) => {
    const row = rows?.find((candidate) => candidate.credential.authIndex === authIndex);
    return row ? row.title : fallback;
  };
  const displayNameFor = (name: string) => {
    const row = rows?.find((candidate) => candidate.file?.name === name);
    return row?.title ?? name;
  };
  const failures = (usage?.failures ?? []).slice(0, RECENT_FAILURES);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.pageTitle}>{t('nav.dashboard')}</h1>
        <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={!connected}>
          <IconRefreshCw size={16} />
          {t('common.refresh')}
        </Button>
      </header>

      <section className={dashboard.section}>
        <div className={styles.sectionBar}>
          <span className={dashboard.eyebrow}>{t('home.last_24h')}</span>
          <Link to="/stats" className={dashboard.panelLink}>
            {t('home.open_stats')}{' '}
            <span className={dashboard.linkArrow} aria-hidden="true">
              →
            </span>
          </Link>
        </div>
        {usageMissing ? (
          <p className={styles.note}>{t('stats_page.plugin_missing')}</p>
        ) : (
          <div className={dashboard.statsRow}>
            {tiles.map((tile) => (
              <article
                key={tile.key}
                className={dashboard.statTile}
                style={{ '--tile-accent': tile.accent ?? 'var(--border-hover)' } as CSSProperties}
              >
                <span className={dashboard.statLabel}>{tile.label}</span>
                <strong className={dashboard.statValue}>{usage ? tile.value : DASH}</strong>
                <Sparkline
                  points={tile.points}
                  color={tile.color}
                  ariaLabel={tile.label}
                  className={styles.spark}
                />
                <span className={dashboard.statHint}>{tile.hint}</span>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className={dashboard.detailGrid}>
        <div className={dashboard.panel}>
          <header className={dashboard.panelHead}>
            <span className={dashboard.eyebrow}>{t('dashboard.health_eyebrow')}</span>
            <h2 className={dashboard.panelTitle}>{t('dashboard.health_title')}</h2>
          </header>
          {health.total === 0 ? (
            <p className={dashboard.emptyNote}>{credentialsError ?? t('dashboard.health_empty')}</p>
          ) : (
            <>
              <div className={dashboard.healthBar}>
                {(
                  [
                    ['active', health.active, dashboard.healthActive],
                    ['unavailable', health.unavailable, dashboard.healthUnavailable],
                    ['disabled', health.disabled, dashboard.healthDisabled],
                  ] as const
                ).map(([key, count, className]) =>
                  count > 0 ? (
                    <span
                      key={key}
                      className={`${dashboard.healthSegment} ${className}`}
                      style={{ flexGrow: count }}
                    />
                  ) : null
                )}
              </div>
              <ul className={dashboard.healthLegend}>
                <li>
                  <i
                    className={`${dashboard.healthKey} ${dashboard.healthActive}`}
                    aria-hidden="true"
                  />
                  {t('dashboard.health_active')}
                  <b>{health.active}</b>
                </li>
                <li>
                  <i
                    className={`${dashboard.healthKey} ${dashboard.healthUnavailable}`}
                    aria-hidden="true"
                  />
                  {t('dashboard.health_unavailable')}
                  <b>{health.unavailable}</b>
                </li>
                <li>
                  <i
                    className={`${dashboard.healthKey} ${dashboard.healthDisabled}`}
                    aria-hidden="true"
                  />
                  {t('dashboard.health_disabled')}
                  <b>{health.disabled}</b>
                </li>
              </ul>
              <div className={dashboard.typeBreakdown}>
                <span className={dashboard.typeBreakdownLabel}>
                  {t('dashboard.health_by_type')}
                </span>
                <ul className={dashboard.typeList}>
                  {health.byType.map(([label, count]) => (
                    <li key={label} className={dashboard.typeChip}>
                      {label}
                      <b>{count}</b>
                    </li>
                  ))}
                </ul>
              </div>
              <Link to="/auth-files" className={dashboard.panelLink}>
                {t('dashboard.health_link')}{' '}
                <span className={dashboard.linkArrow} aria-hidden="true">
                  →
                </span>
              </Link>
            </>
          )}
        </div>

        <div className={dashboard.panel}>
          <header className={dashboard.panelHead}>
            <span className={dashboard.eyebrow}>{t('dashboard.runtime_eyebrow')}</span>
            <h2 className={dashboard.panelTitle}>{t('dashboard.runtime_title')}</h2>
          </header>
          <dl className={dashboard.specList}>
            {runtimeRows.map((row) => (
              <div key={row.label} className={dashboard.specRow}>
                <dt className={dashboard.specLabel}>{row.label}</dt>
                <dd className={`${dashboard.specValue} ${row.mono ? dashboard.specMono : ''}`}>
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
          {runtimeToggles.length > 0 ? (
            <ul className={dashboard.toggleList}>
              {runtimeToggles.map((toggle) => (
                <li
                  key={toggle.label}
                  className={`${dashboard.togglePill} ${toggle.on ? dashboard.toggleOn : dashboard.toggleOff}`}
                >
                  {toggle.label}
                  <b>{toggle.on ? t('common.yes') : t('common.no')}</b>
                </li>
              ))}
            </ul>
          ) : null}
          <Link to="/config" className={dashboard.panelLink}>
            {t('dashboard.runtime_link')}{' '}
            <span className={dashboard.linkArrow} aria-hidden="true">
              →
            </span>
          </Link>
        </div>
      </section>

      {quotaEntries.some((entry) => quotaHasWindow(entry, quotaFor(entry))) ? (
        <section className={dashboard.panel}>
          <header className={dashboard.panelHead}>
            <span className={dashboard.eyebrow}>{t('home.quota_eyebrow')}</span>
            <h2 className={dashboard.panelTitle}>{t('home.quota_title')}</h2>
          </header>
          <QuotaTimeline
            entries={quotaEntries}
            quotaFor={quotaFor}
            displayNameFor={displayNameFor}
            resolvedTheme={theme}
          />
        </section>
      ) : null}

      {usage && failures.length > 0 ? (
        <section className={dashboard.panel}>
          <header className={dashboard.panelHead}>
            <span className={dashboard.eyebrow}>{t('home.last_24h')}</span>
            <h2 className={dashboard.panelTitle}>{t('stats_page.failures')}</h2>
          </header>
          <ul className={styles.failures}>
            {failures.map((failure, index) => (
              <li key={`${failure.time}-${index}`} className={styles.failure}>
                <span className={styles.failureStatus}>{failure.status || DASH}</span>
                <span className={styles.failureWhat}>
                  <span className={styles.failureModel}>{failure.model}</span>
                  <span className={styles.failureCredential}>
                    {labelForAuthIndex(failure.authIndex, failure.authId || failure.provider)}
                  </span>
                </span>
                <span className={styles.failureMessage} title={failure.message}>
                  {failure.message}
                </span>
                <time className={styles.failureTime} dateTime={failure.time}>
                  {new Date(failure.time).toLocaleTimeString(i18n.language, {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              </li>
            ))}
          </ul>
          <Link to="/stats" className={dashboard.panelLink}>
            {t('home.open_stats')}{' '}
            <span className={dashboard.linkArrow} aria-hidden="true">
              →
            </span>
          </Link>
        </section>
      ) : null}
    </div>
  );
}
