import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconPlus, IconRefreshCw } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  apiKeyNameFingerprint,
  readApiKeyNames,
  saveApiKeyName,
} from '@/features/config/apiKeyNames';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import {
  clientKeysApi,
  keySettings,
  type ClientKey,
  type KeyProfile,
  type KeySettings,
} from '@/services/api/clientKeys';
import { useAuthStore, useConfigStore, useNotificationStore } from '@/stores';
import { copyToClipboard } from '@/utils/clipboard';
import { maskApiKey } from '@/utils/format';
import { AddKeyModal } from './components/AddKeyModal';
import { KeyItem } from './components/KeyItem';
import { KeySheet } from './components/KeySheet';
import { PricesTab } from './components/PricesTab';
import { ProfilesTab } from './components/ProfilesTab';
import { useClientKeys } from './useClientKeys';
import styles from './KeysPage.module.scss';

const POLL_INTERVAL_MS = 60_000;
const TABS = ['keys', 'profiles', 'prices'] as const;
type Tab = (typeof TABS)[number];

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function KeysPage() {
  const { t } = useTranslation();
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const apiBase = useAuthStore((state) => state.apiBase);
  const updateConfigValue = useConfigStore((state) => state.updateConfigValue);
  const { showNotification, showConfirmation } = useNotificationStore();
  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.status === 'current' : true;

  const { data, prices, error, pricesError, reload } = useClientKeys();
  const [tab, setTab] = useState<Tab>('keys');
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<ClientKey | null>(null);
  const [adding, setAdding] = useState(false);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const tabsId = useId();

  useHeaderRefresh(reload, isCurrentLayer);
  useEffect(() => {
    if (!isCurrentLayer || !connected) return;
    const timer = window.setInterval(() => void reload(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [connected, isCurrentLayer, reload]);

  const keys = useMemo(() => data?.keys ?? [], [data]);
  const profiles = useMemo(() => data?.profiles ?? [], [data]);
  // Every name edit is followed by a reload, so names are read again with the new data.
  const names = useMemo(() => {
    const stored = readApiKeyNames(apiBase);
    return new Map(
      keys.map((key) => [key.id, stored[apiKeyNameFingerprint(apiBase, key.key)] ?? ''])
    );
  }, [apiBase, keys]);
  const labelOf = (key: ClientKey) => names.get(key.id) || maskApiKey(key.key);
  const onCount = keys.filter((key) => key.enabled).length;

  const setKeyPending = (id: string, on: boolean) =>
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const saveKey = async (key: ClientKey, change: Partial<KeySettings>) => {
    setKeyPending(key.id, true);
    try {
      await clientKeysApi.updateKey(key.id, { ...keySettings(key), ...change });
      await reload();
    } catch (err) {
      showNotification(`${t('notification.update_failed')}: ${errorText(err)}`, 'error');
    } finally {
      setKeyPending(key.id, false);
    }
  };

  const submitKey = async (key: ClientKey, name: string, settings: KeySettings) => {
    if (!saveApiKeyName(apiBase, key.key, name)) throw new Error(t('keys_page.name_not_saved'));
    await clientKeysApi.updateKey(key.id, settings);
    await reload();
  };

  const addKey = async (key: string, name: string) => {
    const next = await clientKeysApi.addKey(key);
    updateConfigValue('api-keys', next);
    if (!saveApiKeyName(apiBase, key, name)) {
      showNotification(t('keys_page.name_not_saved'), 'error');
    }
    await reload();
  };

  const deleteKey = (key: ClientKey) => {
    showConfirmation({
      title: t('keys_page.delete_title'),
      message: t('keys_page.delete_confirm', { name: labelOf(key) }),
      variant: 'danger',
      confirmText: t('common.delete'),
      onConfirm: async () => {
        try {
          const next = await clientKeysApi.removeKey(key.key);
          updateConfigValue('api-keys', next);
          saveApiKeyName(apiBase, key.key, '');
        } catch (err) {
          showNotification(`${t('notification.delete_failed')}: ${errorText(err)}`, 'error');
        }
        await reload();
      },
    });
  };

  const saveProfiles = async (next: KeyProfile[]) => {
    await clientKeysApi.replaceProfiles(next);
    await reload();
  };

  const copyKey = async (key: ClientKey) => {
    const copied = await copyToClipboard(key.key);
    showNotification(
      copied ? t('notification.link_copied') : t('notification.copy_failed'),
      copied ? 'success' : 'error'
    );
  };

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.indexOf(tab);
    const next =
      event.key === 'ArrowRight'
        ? TABS[(index + 1) % TABS.length]
        : event.key === 'ArrowLeft'
          ? TABS[(index - 1 + TABS.length) % TABS.length]
          : event.key === 'Home'
            ? TABS[0]
            : event.key === 'End'
              ? TABS[TABS.length - 1]
              : null;
    if (!next) return;
    event.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  const renderKeys = () => {
    if (!data) return error ? null : <Skeleton height={240} />;
    if (keys.length === 0) {
      return (
        <EmptyState
          title={t('keys_page.empty')}
          action={
            <Button size="sm" onClick={() => setAdding(true)} disabled={!connected}>
              <IconPlus size={16} />
              {t('keys_page.add_key')}
            </Button>
          }
        />
      );
    }
    return (
      <ol className={styles.list}>
        {keys.map((key) => (
          <KeyItem
            key={key.id}
            item={key}
            label={labelOf(key)}
            named={Boolean(names.get(key.id))}
            profiles={profiles}
            disabled={!connected || pending.has(key.id)}
            onCopy={() => void copyKey(key)}
            onToggle={(enabled) => void saveKey(key, { enabled })}
            onProfile={(profile) => void saveKey(key, { profile })}
            onEdit={() => setEditing(key)}
            onDelete={() => deleteKey(key)}
          />
        ))}
      </ol>
    );
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h1 className={styles.pageTitle}>{t('keys_page.title')}</h1>
          {data ? (
            <div className={styles.chips}>
              <span className={styles.chip}>
                {t('keys_page.on_count', { on: onCount, total: keys.length })}
              </span>
            </div>
          ) : null}
        </div>
        <div className={styles.headerActions}>
          <Button variant="secondary" size="sm" onClick={() => void reload()} disabled={!connected}>
            <IconRefreshCw size={16} />
            {t('common.refresh')}
          </Button>
          <Button size="sm" onClick={() => setAdding(true)} disabled={!connected || !data}>
            <IconPlus size={16} />
            {t('keys_page.add_key')}
          </Button>
        </div>
      </header>

      <div className={styles.tabs} role="tablist" aria-label={t('keys_page.title')}>
        {TABS.map((id) => (
          <button
            key={id}
            ref={(node) => {
              tabRefs.current[id] = node;
            }}
            type="button"
            role="tab"
            id={`${tabsId}-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`${tabsId}-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className={`${styles.tab} ${tab === id ? styles.tabActive : ''}`}
            onClick={() => setTab(id)}
            onKeyDown={handleTabKey}
          >
            {t(`keys_page.tabs.${id}`)}
          </button>
        ))}
      </div>

      <div
        className={styles.panel}
        role="tabpanel"
        id={`${tabsId}-panel-${tab}`}
        aria-labelledby={`${tabsId}-tab-${tab}`}
      >
        {tab === 'prices' ? (
          <PricesTab prices={prices} error={pricesError} disabled={!connected} reload={reload} />
        ) : (
          <>
            {error ? <div className="error-box">{error}</div> : null}
            {tab === 'keys' ? (
              renderKeys()
            ) : data ? (
              <ProfilesTab
                keys={keys}
                profiles={profiles}
                disabled={!connected}
                onSave={saveProfiles}
              />
            ) : error ? null : (
              <Skeleton height={240} />
            )}
          </>
        )}
      </div>

      {adding ? (
        <AddKeyModal
          existing={keys.map((key) => key.key)}
          onClose={() => setAdding(false)}
          onSubmit={addKey}
        />
      ) : null}

      {editing ? (
        <KeySheet
          item={editing}
          label={labelOf(editing)}
          name={names.get(editing.id) ?? ''}
          onClose={() => setEditing(null)}
          onSubmit={(name, settings) => submitKey(editing, name, settings)}
        />
      ) : null}
    </div>
  );
}
