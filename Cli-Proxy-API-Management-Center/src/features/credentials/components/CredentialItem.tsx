import type { DragEvent, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ProviderStatusBar } from '@/components/providers/ProviderStatusBar';
import { Button } from '@/components/ui/Button';
import statusBarStyles from '@/features/providers/components/providerStatusBar.module.scss';
import { AuthFileCooldownSection } from '@/features/authFiles/components/AuthFileCooldownSection';
import { formatModified } from '@/features/authFiles/constants';
import { AuthFileQuotaSection } from '@/features/authFiles/components/AuthFileQuotaSection';
import type { QuotaFileEntry } from '@/features/quota/logic';
import type { QuotaCardState } from '@/features/quota/providers';
import {
  IconChevronDown,
  IconDownload,
  IconRefreshCw,
  IconSettings,
  IconTrash2,
} from '@/components/ui/icons';
import { IconGripVertical } from '@/components/ui/extraIcons';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useNow } from '@/hooks/useNow';
import type { ResolvedTheme } from '@/types';
import { formatFileSize } from '@/utils/format';
import { formatInstantShort } from '@/utils/quota/relativeTime';
import { statusBarDataFromRecentRequests } from '@/utils/recentRequests';
import { formatCountdown, limitedUntil, quotaLimits, quotaPlan } from '../quota';
import {
  credentialProviderLabel,
  credentialStatus,
  isEditable,
  rowWarning,
  type CredentialRow,
} from '../rows';
import { CredentialLogo } from './CredentialLogo';
import styles from '../CredentialsPage.module.scss';

export type DropSide = 'before' | 'after';

interface CredentialItemProps {
  row: CredentialRow;
  /** Pick rank, or null when the credential is disabled and out of line. */
  rank: number | null;
  theme: ResolvedTheme;
  expanded: boolean;
  reorderable: boolean;
  controlsDisabled: boolean;
  dragging: boolean;
  dropSide: DropSide | null;
  quota: { entry: QuotaFileEntry; state: QuotaCardState | undefined } | null;
  /** Present in select mode: the row shows a checkbox in place of its drag handle. */
  selection: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void } | null;
  tokenRefreshing: boolean;
  cooldownResetting: boolean;
  onToggleExpanded: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onMove: (delta: -1 | 1) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (side: DropSide) => void;
  onDrop: () => void;
  /** Present only for auth files whose provider supports a manual token refresh. */
  onRefreshToken?: () => void;
  onDownload?: () => void;
  onResetCooldown?: () => void;
}

const limitTone = (remaining: number) =>
  remaining < 20 ? 'critical' : remaining < 50 ? 'warning' : 'good';

export function CredentialItem({
  row,
  rank,
  theme,
  expanded,
  reorderable,
  controlsDisabled,
  dragging,
  dropSide,
  quota,
  selection,
  tokenRefreshing,
  cooldownResetting,
  onToggleExpanded,
  onToggleEnabled,
  onEdit,
  onDelete,
  onMove,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onRefreshToken,
  onDownload,
  onResetCooldown,
}: CredentialItemProps) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const { credential } = row;
  const editable = isEditable(row);
  const limits = quota ? quotaLimits(quota.entry, quota.state) : [];
  const plan = quota ? quotaPlan(quota.entry, quota.state, t) : null;
  const countdown = (ms: number) => formatCountdown(ms, now, i18n.language);
  const limitedAt = limitedUntil(limits);

  const warning = rowWarning(row);
  const [tone, statusLabel] = credentialStatus(
    row,
    limitedAt === null ? null : countdown(limitedAt),
    t
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      onMove(event.key === 'ArrowUp' ? -1 : 1);
    }
  };

  const handleDragOver = (event: DragEvent<HTMLLIElement>) => {
    if (!reorderable) return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    onDragOver(event.clientY < box.top + box.height / 2 ? 'before' : 'after');
  };

  const itemClassName = [
    styles.item,
    row.disabled ? styles.itemDisabled : '',
    dragging ? styles.itemDragging : '',
    dropSide === 'before' ? styles.dropBefore : '',
    dropSide === 'after' ? styles.dropAfter : '',
  ]
    .filter(Boolean)
    .join(' ');

  const renderLimits = () => {
    if (!quota) return null;
    if (!quota.state || quota.state.status === 'loading') {
      return <span className={styles.limitsNote}>…</span>;
    }
    if (limits.length === 0) {
      return (
        <span className={styles.limitsNote} title={quota.state.error}>
          —
        </span>
      );
    }
    return limits.map((limit) => (
      <div
        key={limit.label}
        className={styles.limit}
        title={`${limit.label} ${Math.round(limit.remaining)}%`}
      >
        <span className={styles.limitLabel}>{limit.label}</span>
        <span className={styles.limitValue}>
          {Math.round(limit.remaining)}%
          {typeof limit.resetAtMs === 'number' ? (
            <span className={styles.limitReset}> · {countdown(limit.resetAtMs)}</span>
          ) : null}
        </span>
        <span className={styles.limitTrack}>
          <span
            className={`${styles.limitFill} ${styles[`limit_${limitTone(limit.remaining)}`]}`}
            style={{ width: `${limit.remaining}%` }}
          />
        </span>
      </div>
    ));
  };

  return (
    <li
      className={itemClassName}
      draggable={reorderable && !controlsDisabled}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={handleDragOver}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
    >
      <div className={styles.itemMain}>
        {selection ? (
          <SelectionCheckbox
            className={styles.select}
            checked={selection.checked}
            disabled={selection.disabled}
            onChange={selection.onChange}
            ariaLabel={t('auth_files.card_select', { name: row.title })}
          />
        ) : (
          <button
            type="button"
            className={styles.handle}
            disabled={!reorderable}
            onKeyDown={handleKeyDown}
            aria-label={t('credentials.move', { name: row.title })}
            title={t('credentials.move', { name: row.title })}
          >
            <IconGripVertical size={16} />
          </button>
        )}
        <span className={styles.rank}>{rank ?? '–'}</span>
        <CredentialLogo row={row} theme={theme} className={styles.logo} />
        <div className={styles.identity}>
          <div className={styles.titleLine}>
            <span className={styles.title}>{row.title}</span>
            <span
              className={styles.kind}
              title={
                plan?.renewsAtMs
                  ? `${t('codex_quota.expires_label')} ${formatInstantShort(plan.renewsAtMs)}`
                  : undefined
              }
            >
              {credentialProviderLabel(row, t)}
              {plan
                ? ` · ${plan.label}`
                : credential.kind === 'oauth'
                  ? ` · ${t('credentials.kind.oauth')}`
                  : credential.kind === 'apikey'
                    ? ` · ${t('credentials.kind.apikey')}`
                    : ''}
            </span>
          </div>
          {row.detail ? <div className={styles.detail}>{row.detail}</div> : null}
          {warning ? (
            <div className={styles.warning} title={warning}>
              {warning}
            </div>
          ) : null}
        </div>
        <span className={`${styles.status} ${styles[`status_${tone}`]}`}>{statusLabel}</span>
        <div className={styles.limits}>{renderLimits()}</div>
        <div className={styles.health}>
          <ProviderStatusBar
            statusData={statusBarDataFromRecentRequests(credential.recentRequests)}
            styles={statusBarStyles}
          />
        </div>
        <div className={styles.actions}>
          <ToggleSwitch
            checked={!row.disabled}
            onChange={onToggleEnabled}
            disabled={!editable || controlsDisabled}
            ariaLabel={t('credentials.enabled', { name: row.title })}
          />
          <button
            type="button"
            className={styles.iconButton}
            onClick={onEdit}
            disabled={!editable || controlsDisabled}
            aria-label={t('common.edit')}
            title={t('common.edit')}
          >
            <IconSettings size={16} />
          </button>
          <button
            type="button"
            className={`${styles.iconButton} ${styles.danger}`}
            onClick={onDelete}
            disabled={!editable || controlsDisabled}
            aria-label={t('common.delete')}
            title={t('common.delete')}
          >
            <IconTrash2 size={16} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            aria-label={t('credentials.details', { name: row.title })}
            title={t('credentials.details', { name: row.title })}
          >
            <IconChevronDown size={16} className={expanded ? styles.chevronOpen : styles.chevron} />
          </button>
        </div>
      </div>
      {expanded ? (
        <div className={styles.details}>
          {row.file ? (
            <div className={styles.detailsAccount}>
              {quota ? (
                <AuthFileQuotaSection
                  file={row.file}
                  quotaType={quota.entry.type}
                  disableControls={controlsDisabled}
                />
              ) : null}
              <AuthFileCooldownSection
                snapshot={row.file.cooldownSnapshot}
                resetting={cooldownResetting}
                resetDisabled={controlsDisabled}
                onReset={onResetCooldown}
              />
              <div className={styles.fileMeta}>
                <span title={t('auth_files.file_size')}>
                  {row.file.size ? formatFileSize(row.file.size) : '-'}
                </span>
                <span title={t('auth_files.file_modified')}>{formatModified(row.file)}</span>
                <span>
                  {t('stats.success')} {row.file.successCount ?? 0}
                </span>
                <span>
                  {t('stats.failure')} {row.file.failureCount ?? 0}
                </span>
              </div>
              {onRefreshToken || onDownload ? (
                <div className={styles.detailsActions}>
                  {onRefreshToken ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={onRefreshToken}
                      loading={tokenRefreshing}
                      disabled={controlsDisabled}
                    >
                      <IconRefreshCw size={14} />
                      {t('credentials.refresh_token')}
                    </Button>
                  ) : null}
                  {onDownload ? (
                    <Button variant="secondary" size="sm" onClick={onDownload}>
                      <IconDownload size={14} />
                      {t('credentials.download')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          <div className={styles.detailsModels}>
            <div className={styles.detailsHeading}>
              {t('credentials.models', { count: credential.models.length })}
            </div>
            <ul className={styles.models}>
              {credential.models.map((model) => {
                const upstream = model.upstream.filter((name) => name !== model.id);
                return (
                  <li key={model.id} className={styles.model}>
                    <span>{model.id}</span>
                    {upstream.length > 0 ? (
                      <span className={styles.upstream}>→ {upstream.join(', ')}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : null}
    </li>
  );
}
