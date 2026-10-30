import { useTranslation } from 'react-i18next';
import { IconCopy, IconSettings, IconTrash2 } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useNow } from '@/hooks/useNow';
import type { ClientKey, KeyProfile } from '@/services/api/clientKeys';
import { maskApiKey } from '@/utils/format';
import { formatRelativeInstant } from '@/utils/quota/relativeTime';
import { budgetBars, formatUsd } from '../keysModel';
import styles from '../KeysPage.module.scss';

interface KeyItemProps {
  item: ClientKey;
  /** The browser-stored name, else the masked key. */
  label: string;
  named: boolean;
  profiles: KeyProfile[];
  disabled: boolean;
  onCopy: () => void;
  onToggle: (enabled: boolean) => void;
  onProfile: (profile: string) => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function KeyItem({
  item,
  label,
  named,
  profiles,
  disabled,
  onCopy,
  onToggle,
  onProfile,
  onEdit,
  onDelete,
}: KeyItemProps) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const bars = budgetBars(item);
  const usd = (value: number) => formatUsd(value, i18n.language);
  const lastUsed =
    item.lastUsed === null
      ? t('keys_page.never_used')
      : t('keys_page.last_used', {
          time: formatRelativeInstant(item.lastUsed, now, i18n.language),
        });
  const profileOptions = [
    { value: '', label: t('keys_page.no_profile') },
    ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
  ];
  const exceeded = item.exceeded.map((window) => t(`keys_page.windows.${window}`)).join(', ');

  return (
    <li className={`${styles.item} ${item.enabled ? '' : styles.itemDisabled}`.trim()}>
      <div className={styles.identity}>
        <span className={`${styles.title} ${named ? '' : styles.mono}`.trim()}>{label}</span>
        <span className={styles.detail}>
          {named ? (
            <>
              <span className={styles.mono}>{maskApiKey(item.key)}</span> ·{' '}
            </>
          ) : null}
          <span
            title={
              item.lastUsed === null
                ? undefined
                : new Date(item.lastUsed).toLocaleString(i18n.language)
            }
          >
            {lastUsed}
          </span>
        </span>
      </div>
      {item.exceeded.length > 0 ? (
        <span
          className={`${styles.status} ${item.overBudget === 'block' ? styles.status_error : styles.status_warn}`}
          title={exceeded}
        >
          {item.overBudget === 'block' ? t('keys_page.blocked') : t('keys_page.over_budget')}
        </span>
      ) : (
        <span />
      )}
      <div className={styles.limits}>
        {bars.length === 0 ? (
          <div className={styles.limit}>
            <span className={styles.limitLabel}>{t('keys_page.windows.month')}</span>
            <span className={styles.limitValue}>{usd(item.spend.month)}</span>
          </div>
        ) : (
          bars.map((bar) => (
            <div key={bar.window} className={styles.limit}>
              <span className={styles.limitLabel}>{t(`keys_page.windows.${bar.window}`)}</span>
              <span className={styles.limitValue}>
                {usd(bar.spend)} / {usd(bar.budget)}
              </span>
              <span className={styles.limitTrack}>
                <span
                  className={`${styles.limitFill} ${styles[`limit_${bar.tone}`]}`}
                  style={{ width: `${bar.percent}%` }}
                />
              </span>
            </div>
          ))
        )}
      </div>
      <Select
        className={styles.profileSelect}
        value={item.profile}
        options={profileOptions}
        onChange={onProfile}
        disabled={disabled}
        ariaLabel={t('keys_page.profile_of', { name: label })}
        size="sm"
      />
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onCopy}
          aria-label={t('keys_page.copy', { name: label })}
          title={t('keys_page.copy', { name: label })}
        >
          <IconCopy size={16} />
        </button>
        <ToggleSwitch
          checked={item.enabled}
          onChange={onToggle}
          disabled={disabled}
          ariaLabel={t('keys_page.enabled', { name: label })}
        />
        <button
          type="button"
          className={styles.iconButton}
          onClick={onEdit}
          disabled={disabled}
          aria-label={t('keys_page.edit', { name: label })}
          title={t('keys_page.edit', { name: label })}
        >
          <IconSettings size={16} />
        </button>
        <button
          type="button"
          className={`${styles.iconButton} ${styles.danger}`}
          onClick={onDelete}
          disabled={disabled}
          aria-label={t('keys_page.delete', { name: label })}
          title={t('keys_page.delete', { name: label })}
        >
          <IconTrash2 size={16} />
        </button>
      </div>
    </li>
  );
}
