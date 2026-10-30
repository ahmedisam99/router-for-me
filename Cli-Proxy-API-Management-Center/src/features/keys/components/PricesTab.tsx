import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconPencil, IconRefreshCw } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { useNow } from '@/hooks/useNow';
import {
  clientKeysApi,
  type ModelPrice,
  type PriceTable,
  type TokenPrices,
} from '@/services/api/clientKeys';
import { useNotificationStore } from '@/stores';
import { formatRelativeInstant } from '@/utils/quota/relativeTime';
import {
  effectivePrice,
  formatUsd,
  PRICE_FIELD_LABELS,
  PRICE_FIELDS,
  priceOrigin,
} from '../keysModel';
import { PriceModal } from './PriceModal';
import styles from '../KeysPage.module.scss';

interface PricesTabProps {
  prices: PriceTable | null;
  error: string | null;
  disabled: boolean;
  reload: () => Promise<void>;
}

export function PricesTab({ prices, error, disabled, reload }: PricesTabProps) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<ModelPrice | null>(null);

  const refreshList = async () => {
    setRefreshing(true);
    try {
      await clientKeysApi.refreshPrices();
    } catch (err) {
      showNotification(err instanceof Error ? err.message : String(err), 'error');
    }
    await reload();
    setRefreshing(false);
  };

  const saveOverride = async (model: string, override: TokenPrices | null) => {
    await clientKeysApi.setPriceOverride(model, override);
    await reload();
  };

  const header = (
    <div className={styles.toolbar}>
      {prices ? (
        <span className={prices.source.error ? styles.sourceError : styles.source}>
          {prices.source.fetchedAt === null
            ? prices.source.name
            : t('keys_page.price_source', {
                name: prices.source.name,
                time: formatRelativeInstant(prices.source.fetchedAt, now, i18n.language),
              })}
          {prices.source.error ? ` · ${prices.source.error}` : ''}
        </span>
      ) : null}
      {prices && prices.unpriced.length > 0 ? (
        <span className={styles.chip} title={prices.unpriced.join(', ')}>
          {t('keys_page.unpriced', { count: prices.unpriced.length })}
        </span>
      ) : null}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => void refreshList()}
        loading={refreshing}
        disabled={disabled}
      >
        <IconRefreshCw size={16} />
        {t('keys_page.refresh_prices')}
      </Button>
    </div>
  );

  if (!prices) {
    return error ? <div className="error-box">{error}</div> : <Skeleton height={240} />;
  }

  return (
    <>
      {header}
      {error ? <div className="error-box">{error}</div> : null}
      {prices.prices.length === 0 ? (
        <EmptyState title={t('keys_page.prices_empty')} />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.caption}>{t('keys_page.per_million')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('keys_page.model')}</th>
                {PRICE_FIELDS.map((field) => (
                  <th key={field} scope="col">
                    {t(PRICE_FIELD_LABELS[field])}
                  </th>
                ))}
                <th scope="col">{t('keys_page.origin')}</th>
                <th scope="col">
                  <span className={styles.srOnly}>{t('common.action')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {prices.prices.map((price) => {
                const effective = effectivePrice(price);
                const origin = priceOrigin(price);
                return (
                  <tr key={price.model}>
                    <th scope="row" className={styles.modelCell}>
                      {price.model}
                    </th>
                    {PRICE_FIELDS.map((field) => (
                      <td key={field}>
                        {effective ? formatUsd(effective[field], i18n.language, true) : '—'}
                      </td>
                    ))}
                    <td>
                      <span className={`${styles.origin} ${styles[`origin_${origin}`]}`}>
                        {t(`keys_page.origins.${origin}`)}
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className={styles.iconButton}
                        onClick={() => setEditing(price)}
                        disabled={disabled}
                        aria-label={t('keys_page.edit', { name: price.model })}
                        title={t('keys_page.edit', { name: price.model })}
                      >
                        <IconPencil size={16} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing ? (
        <PriceModal
          price={editing}
          onClose={() => setEditing(null)}
          onSave={(override) => saveOverride(editing.model, override)}
        />
      ) : null}
    </>
  );
}
