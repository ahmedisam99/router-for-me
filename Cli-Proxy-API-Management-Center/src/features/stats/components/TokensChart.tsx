import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Collapsible } from '@/components/ui/Collapsible';
import chartStyles from '@/features/dashboard/components/ThroughputChart.module.scss';
import { axisMax } from '@/features/dashboard/utils';
import { formatCompactNumber } from '@/utils/format';
import type { TimeBucket } from '../statsModel';
import styles from '../StatsPage.module.scss';

const TICK_COUNT = 5;

interface TokensChartProps {
  buckets: TimeBucket[];
  label: (bucket: TimeBucket) => string;
}

/** Tokens per bucket, one series; mirrors the dashboard's ThroughputChart. */
export function TokensChart({ buckets, label }: TokensChartProps) {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const { peakIndex, peakTotal, total } = useMemo(() => {
    let peak = -1;
    let peakValue = 0;
    let sum = 0;
    buckets.forEach((bucket, index) => {
      sum += bucket.totals.totalTokens;
      if (bucket.totals.totalTokens > peakValue) {
        peakValue = bucket.totals.totalTokens;
        peak = index;
      }
    });
    return { peakIndex: peak, peakTotal: peakValue, total: sum };
  }, [buckets]);
  const scaleMax = useMemo(() => axisMax(peakTotal, TICK_COUNT - 1), [peakTotal]);
  const ticks = Array.from({ length: TICK_COUNT }, (_, index) => {
    const ratio = 1 - index / (TICK_COUNT - 1);
    return { ratio, value: scaleMax * ratio };
  });
  const xTicks = Array.from(new Set([0, Math.floor((buckets.length - 1) / 2), buckets.length - 1]));
  const active = activeIndex === null ? null : buckets[activeIndex];

  return (
    <figure className={chartStyles.chart}>
      <div className={chartStyles.plot}>
        <div className={chartStyles.yAxis} aria-hidden="true">
          {ticks.map((tick) => (
            <span
              key={tick.ratio}
              className={chartStyles.yTick}
              style={{ top: `${(1 - tick.ratio) * 100}%` }}
            >
              {formatCompactNumber(tick.value)}
            </span>
          ))}
        </div>
        <div className={chartStyles.canvas}>
          <div className={chartStyles.gridlines} aria-hidden="true">
            {ticks.map((tick) => (
              <span
                key={tick.ratio}
                className={chartStyles.gridline}
                style={{ top: `${(1 - tick.ratio) * 100}%` }}
              />
            ))}
          </div>
          <div
            className={chartStyles.columns}
            role="img"
            aria-label={t('stats_page.tokens_summary', { total: formatCompactNumber(total) })}
            onMouseLeave={() => setActiveIndex(null)}
          >
            {buckets.map((bucket, index) => {
              const value = bucket.totals.totalTokens;
              return (
                <div
                  key={bucket.start}
                  className={`${chartStyles.column} ${activeIndex === index ? chartStyles.columnActive : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => setActiveIndex((current) => (current === index ? null : index))}
                >
                  {index === peakIndex && peakTotal > 0 ? (
                    <span
                      className={chartStyles.peakLabel}
                      style={{ bottom: `${Math.min(100, (value / scaleMax) * 100)}%` }}
                    >
                      {formatCompactNumber(peakTotal)}
                    </span>
                  ) : null}
                  <div className={chartStyles.stack}>
                    {value > 0 ? (
                      <span
                        className={`${chartStyles.segment} ${styles.segmentTokens}`}
                        style={{ height: `${(value / scaleMax) * 100}%` }}
                      />
                    ) : (
                      <span className={chartStyles.idleTick} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {active && activeIndex !== null ? (
            <div
              className={chartStyles.tooltip}
              style={{
                left: `${((activeIndex + 0.5) / buckets.length) * 100}%`,
                transform:
                  activeIndex < buckets.length * 0.15
                    ? 'translateX(-12%)'
                    : activeIndex > buckets.length * 0.85
                      ? 'translateX(-88%)'
                      : 'translateX(-50%)',
              }}
              role="status"
            >
              <span className={chartStyles.tooltipTime}>{label(active)}</span>
              <span className={chartStyles.tooltipRow}>
                {t('stats_page.tokens')}
                <b>{active.totals.totalTokens.toLocaleString()}</b>
              </span>
              <span className={chartStyles.tooltipRow}>
                {t('stats_page.input')}
                <b>{active.totals.inputTokens.toLocaleString()}</b>
              </span>
              <span className={chartStyles.tooltipRow}>
                {t('stats_page.output')}
                <b>{active.totals.outputTokens.toLocaleString()}</b>
              </span>
              <span className={chartStyles.tooltipRow}>
                {t('stats_page.cached')}
                <b>{active.totals.cachedTokens.toLocaleString()}</b>
              </span>
            </div>
          ) : null}
        </div>
      </div>
      <div className={chartStyles.xAxis} aria-hidden="true">
        {xTicks.map((index) => (
          <span
            key={index}
            className={chartStyles.xTick}
            style={{ left: `${((index + 0.5) / buckets.length) * 100}%` }}
          >
            {label(buckets[index])}
          </span>
        ))}
      </div>
      <Collapsible className={chartStyles.tableToggle} label={t('dashboard.traffic_table')}>
        <table className={chartStyles.table}>
          <thead>
            <tr>
              <th scope="col">{t('dashboard.traffic_table_window')}</th>
              <th scope="col">{t('stats_page.tokens')}</th>
              <th scope="col">{t('stats_page.input')}</th>
              <th scope="col">{t('stats_page.output')}</th>
              <th scope="col">{t('stats_page.cached')}</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <tr key={bucket.start}>
                <th scope="row">{label(bucket)}</th>
                <td>{bucket.totals.totalTokens.toLocaleString()}</td>
                <td>{bucket.totals.inputTokens.toLocaleString()}</td>
                <td>{bucket.totals.outputTokens.toLocaleString()}</td>
                <td>{bucket.totals.cachedTokens.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Collapsible>
    </figure>
  );
}
