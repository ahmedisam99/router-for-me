import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconPlus, IconRefreshCw, IconSearch } from '@/components/ui/icons';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { Skeleton } from '@/components/ui/Skeleton';
import { notifyAuthFilesChanged } from '@/features/authFiles/authFilesEvents';
import { AuthFileDetailsSheet } from '@/features/authFiles/components/AuthFileDetailsSheet';
import { useAuthFilesPrefixProxyEditor } from '@/features/authFiles/hooks/useAuthFilesPrefixProxyEditor';
import {
  normalizeProviderKey,
  supportsAuthFileManualRefresh,
} from '@/features/authFiles/constants';
import {
  ProviderSheet,
  type ProviderSheetHandle,
  type ProviderSheetState,
} from '@/features/providers/sheets/ProviderSheet';
import type { ProviderBrand, ProviderResource } from '@/features/providers/types';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { authFilesApi } from '@/services/api/authFiles';
import { providersApi } from '@/services/api/providers';
import { canSetPriority, routingApi } from '@/services/api/routing';
import { useAuthStore, useConfigStore, useNotificationStore, useThemeStore } from '@/stores';
import type { OpenAIProviderConfig } from '@/types';
import { copyToClipboard } from '@/utils/clipboard';
import { MAX_AUTH_FILE_SIZE } from '@/utils/constants';
import { downloadBlob } from '@/utils/download';
import { formatFileSize } from '@/utils/format';
import { AddCredentialSheet } from './components/AddCredentialSheet';
import { CredentialItem, type DropSide } from './components/CredentialItem';
import { lineRanks, moveItem, priorityChanges } from './order';
import { formatCountdown, limitedUntil, quotaLimits, quotaPlan, useCredentialQuota } from './quota';
import {
  credentialProviderLabel,
  credentialStatus,
  isEditable,
  keysLeft,
  type CredentialRow,
} from './rows';
import { useCredentialRows } from './useCredentialRows';
import styles from './CredentialsPage.module.scss';

const POLL_INTERVAL_MS = 60_000;
const CONFIG_SETTLE_MS = 1_000;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// The backend reloads credentials only after it has answered a config save, so the change is
// announced again once that reload has had time to land.
const announceSettled = () => window.setTimeout(notifyAuthFilesChanged, CONFIG_SETTLE_MS);
const announceChange = () => {
  notifyAuthFilesChanged();
  announceSettled();
};

type Failure = { name: string; message: string };

/** Runs the actions one after another, collecting failures instead of stopping at the first. */
const runEach = async <T,>(
  items: readonly T[],
  nameOf: (item: T) => string,
  action: (item: T) => Promise<unknown>
): Promise<Failure[]> => {
  const failures: Failure[] = [];
  for (const item of items) {
    try {
      await action(item);
    } catch (err) {
      failures.push({ name: nameOf(item), message: errorText(err) });
    }
  }
  return failures;
};

const failureText = (failures: readonly Failure[]) =>
  failures.map((failure) => `${failure.name}: ${failure.message}`).join('; ');

export function CredentialsPage() {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const [searchParams, setSearchParams] = useSearchParams();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const strategy = useConfigStore((state) => state.config?.routingStrategy);
  const theme = useThemeStore((state) => state.resolvedTheme);
  const { showNotification, showConfirmation } = useNotificationStore();
  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.status === 'current' : true;

  const { rows, workbench, error, reload, refresh } = useCredentialRows();
  const [pendingOrder, setPendingOrder] = useState<CredentialRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [drop, setDrop] = useState<{ index: number; side: DropSide } | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // `/credentials?add=1` (where the old OAuth page now points) opens the add sheet.
  const [addOpen, setAddOpen] = useState(() => searchParams.has('add'));
  const [tokenRefreshing, setTokenRefreshing] = useState<ReadonlySet<string>>(new Set());
  const [cooldownResetting, setCooldownResetting] = useState<ReadonlySet<string>>(new Set());
  const [sheetState, setSheetState] = useState<ProviderSheetState>({
    open: false,
    brand: 'claude',
    mode: 'edit',
    resource: null,
  });
  const sheetRef = useRef<ProviderSheetHandle>(null);

  const connected = connectionStatus === 'connected';
  const controlsDisabled = !connected || saving || workbench.mutating;

  useHeaderRefresh(refresh, isCurrentLayer);
  useEffect(() => {
    if (searchParams.has('add')) setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);
  useEffect(() => {
    if (!isCurrentLayer || !connected) return;
    const timer = window.setInterval(() => void reload(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [connected, isCurrentLayer, reload]);

  const fileEditor = useAuthFilesPrefixProxyEditor({
    disableControls: !connected,
    loadFiles: reload,
  });

  const list = useMemo(() => pendingOrder ?? rows ?? [], [pendingOrder, rows]);
  const ranks = useMemo(() => lineRanks(list, strategy), [list, strategy]);
  const activeCount = list.filter((row) => !row.disabled).length;
  const files = useMemo(() => (rows ?? []).flatMap((row) => (row.file ? [row.file] : [])), [rows]);
  const { entries: quotaEntries, quotaFor } = useCredentialQuota(files);
  const quotaByFile = useMemo(
    () => new Map(quotaEntries.map((entry) => [entry.file.name, entry])),
    [quotaEntries]
  );
  const brands = useMemo(
    () =>
      (workbench.snapshot?.groups ?? [])
        .map((group) => group.id)
        .filter((brand) => brand !== 'apikeyFun'),
    [workbench.snapshot]
  );

  const commitOrder = async (next: CredentialRow[]) => {
    const changes = priorityChanges(next.map((row) => row.credential));
    if (changes.length === 0) return;
    setPendingOrder(next);
    setSaving(true);
    try {
      await routingApi.setPriorities(changes);
      await Promise.all([reload(), workbench.refetch()]);
      announceSettled();
    } catch (err) {
      showNotification(`${t('notification.update_failed')}: ${errorText(err)}`, 'error');
      await reload();
    } finally {
      setPendingOrder(null);
      setSaving(false);
    }
  };

  const moveBy = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (controlsDisabled || target < 0 || target >= list.length) return;
    void commitOrder(moveItem(list, index, target));
  };

  const handleDrop = () => {
    if (dragIndex === null || drop === null) return;
    const target = drop.side === 'before' ? drop.index : drop.index + 1;
    const to = dragIndex < target ? target - 1 : target;
    setDragIndex(null);
    setDrop(null);
    if (to !== dragIndex) void commitOrder(moveItem(list, dragIndex, to));
  };

  const quotaEntryFor = (row: CredentialRow) => {
    const entry = row.file ? quotaByFile.get(row.file.name) : undefined;
    return entry ? { entry, state: quotaFor(entry) } : null;
  };

  // Matches what a row shows: name, file or host, provider, plan and status.
  const searchText = (row: CredentialRow) => {
    const quota = quotaEntryFor(row);
    const limitedAt = quota ? limitedUntil(quotaLimits(quota.entry, quota.state)) : null;
    const [, status] = credentialStatus(
      row,
      limitedAt === null ? null : formatCountdown(limitedAt, now, i18n.language),
      t
    );
    const plan = quota ? (quotaPlan(quota.entry, quota.state, t)?.label ?? '') : '';
    return [row.title, row.detail, credentialProviderLabel(row, t), row.credential.provider]
      .concat(plan, status)
      .join(' ')
      .toLowerCase();
  };
  const needle = query.trim().toLowerCase();
  const visible = needle ? list.filter((row) => searchText(row).includes(needle)) : list;
  const selectable = visible.filter(isEditable);
  const chosen = list.filter((row) => selected.has(row.credential.id) && isEditable(row));
  const allSelected =
    selectable.length > 0 && selectable.every((row) => selected.has(row.credential.id));
  const rankById = new Map(list.map((row, index) => [row.credential.id, ranks[index]]));

  const setChecked = (ids: readonly string[], checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (checked ? next.add(id) : next.delete(id)));
      return next;
    });

  const toggleSelecting = () => {
    setSelecting((value) => !value);
    setSelected(new Set());
  };

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // A resource can back several rows (each key of an OpenAI-compatible provider), so it is set once.
  const setEnabled = async (targets: readonly CredentialRow[], enabled: boolean) => {
    const changing = targets.filter((row) => row.disabled === enabled);
    const resources = [...new Set(changing.flatMap((row) => (row.resource ? [row.resource] : [])))];
    const files = changing.flatMap((row) => (!row.resource && row.file ? [row] : []));
    const failures = [
      ...(await runEach(
        resources,
        (resource) => resource.name || resource.identifier,
        (resource) => workbench.toggleDisabled(resource, !enabled)
      )),
      ...(await runEach(
        files,
        (row) => row.title,
        (row) => authFilesApi.setStatus(row.file!.name, !enabled, row.credential.authIndex)
      )),
    ];
    if (failures.length > 0) {
      showNotification(`${t('notification.update_failed')}: ${failureText(failures)}`, 'error');
    }
    announceChange();
  };

  // The keys of one OpenAI-compatible provider go in one save, and the provider goes once no key
  // is left. Any other config resource, including a sponsor bundle, is deleted whole, like upstream.
  const removeRows = async (targets: readonly CredentialRow[]) => {
    const byResource = new Map<ProviderResource, Set<string>>();
    targets.forEach((row) => {
      if (!row.resource) return;
      const indexes = byResource.get(row.resource) ?? new Set<string>();
      byResource.set(row.resource, indexes.add(row.credential.authIndex));
    });
    const fileNames = targets.flatMap((row) => (!row.resource && row.file ? [row.file.name] : []));
    const failures = await runEach(
      [...byResource],
      ([resource]) => resource.name || resource.identifier,
      async ([resource, indexes]) => {
        const left = indexes.has('') ? [] : keysLeft(resource, indexes);
        if (left.length > 0 && resource.selector.brand === 'openaiCompatibility') {
          const { name, index } = resource.selector;
          const config = resource.raw as OpenAIProviderConfig;
          await providersApi.updateOpenAIProvider(name, index, { ...config, apiKeyEntries: left });
        } else {
          await workbench.deleteProvider(resource);
        }
      }
    );
    if (fileNames.length > 0) {
      try {
        const result = await authFilesApi.deleteFiles(fileNames);
        failures.push(...result.failed.map((item) => ({ name: item.name, message: item.error })));
      } catch (err) {
        failures.push({ name: fileNames.join(', '), message: errorText(err) });
      }
    }
    if (byResource.size > 0) await workbench.refetch();
    if (failures.length > 0) {
      showNotification(`${t('notification.delete_failed')}: ${failureText(failures)}`, 'error');
    }
    announceChange();
  };

  const toggleEnabled = (row: CredentialRow, enabled: boolean) => setEnabled([row], enabled);

  const editRow = (row: CredentialRow) => {
    if (row.resource) {
      setSheetState({
        open: true,
        brand: row.resource.brand,
        mode: 'edit',
        resource: row.resource,
      });
    } else if (row.file) {
      void fileEditor.openPrefixProxyEditor(row.file);
    }
  };

  const deleteRow = (row: CredentialRow) => {
    showConfirmation({
      title: t('credentials.delete_title'),
      message: t('credentials.delete_confirm', { name: row.title }),
      variant: 'danger',
      confirmText: t('common.delete'),
      onConfirm: () => removeRows([row]),
    });
  };

  const deleteChosen = () => {
    showConfirmation({
      title: t('credentials.delete_title'),
      message: t('credentials.delete_many_confirm', { count: chosen.length }),
      variant: 'danger',
      confirmText: t('common.delete'),
      onConfirm: async () => {
        await removeRows(chosen);
        setSelected(new Set());
      },
    });
  };

  const canRefreshToken = (row: CredentialRow) =>
    Boolean(
      row.file &&
      isEditable(row) &&
      supportsAuthFileManualRefresh(
        normalizeProviderKey(String(row.file.type ?? row.file.provider ?? ''))
      )
    );

  const refreshChosenTokens = async () => {
    const targets = chosen.filter(canRefreshToken);
    const failures = await runEach(
      targets,
      (row) => row.title,
      (row) =>
        authFilesApi.requestManualRefresh(row.file!.name, row.credential.authIndex || undefined)
    );
    showNotification(
      t('auth_files.refresh_all_summary', {
        success: targets.length - failures.length,
        failed: failures.length,
      }),
      failures.length > 0 ? 'warning' : 'success'
    );
    await reload();
  };

  const downloadChosen = async () => {
    const failures = await runEach(
      chosen.filter((row) => row.file),
      (row) => row.file!.name,
      async (row) => {
        downloadBlob({
          filename: row.file!.name,
          blob: await authFilesApi.download(row.file!.name),
        });
      }
    );
    if (failures.length > 0) {
      showNotification(`${t('notification.download_failed')}: ${failureText(failures)}`, 'error');
    }
  };

  // The same checks and messages as upstream's Auth Files upload.
  const uploadFiles = async (files: File[]) => {
    setAddOpen(false);
    const valid = files.filter(
      (file) => file.name.endsWith('.json') && file.size <= MAX_AUTH_FILE_SIZE
    );
    if (files.some((file) => !file.name.endsWith('.json'))) {
      showNotification(t('auth_files.upload_error_json'), 'error');
    }
    if (files.some((file) => file.name.endsWith('.json') && file.size > MAX_AUTH_FILE_SIZE)) {
      showNotification(
        t('auth_files.upload_error_size', { maxSize: formatFileSize(MAX_AUTH_FILE_SIZE) }),
        'error'
      );
    }
    if (valid.length === 0) return;
    try {
      const result = await authFilesApi.uploadFiles(valid);
      if (result.uploaded > 0) {
        const suffix = valid.length > 1 ? ` (${result.uploaded}/${valid.length})` : '';
        showNotification(
          `${t('auth_files.upload_success')}${suffix}`,
          result.failed.length > 0 ? 'warning' : 'success'
        );
      }
      if (result.failed.length > 0) {
        const details = result.failed.map((item) => `${item.name}: ${item.error}`).join('; ');
        showNotification(`${t('notification.upload_failed')}: ${details}`, 'error');
      }
      notifyAuthFilesChanged();
    } catch (err) {
      showNotification(`${t('notification.upload_failed')}: ${errorText(err)}`, 'error');
    }
  };

  const openApiKeyForm = (brand: ProviderBrand) => {
    setAddOpen(false);
    setSheetState({ open: true, brand, mode: 'create', resource: null });
  };

  const closeSheet = useCallback(() => setSheetState((state) => ({ ...state, open: false })), []);
  const handleSheetSaved = useCallback(() => {
    closeSheet();
    announceChange();
  }, [closeSheet]);

  const withPending = async (
    key: string,
    setPending: (update: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void,
    action: () => Promise<void>
  ) => {
    setPending((prev) => new Set(prev).add(key));
    try {
      await action();
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const refreshToken = (name: string, authIndex: string) =>
    withPending(name, setTokenRefreshing, async () => {
      try {
        await authFilesApi.requestManualRefresh(name, authIndex || undefined);
        showNotification(t('auth_files.manual_refresh_requested', { name }), 'info');
        await reload();
      } catch (err) {
        showNotification(
          t('auth_files.manual_refresh_failed', { name, message: errorText(err) }),
          'error'
        );
      }
    });

  const resetCooldown = (authIndex: string) =>
    withPending(authIndex, setCooldownResetting, async () => {
      try {
        await authFilesApi.resetCooldown(authIndex);
        await reload();
      } catch (err) {
        showNotification(`${t('notification.update_failed')}: ${errorText(err)}`, 'error');
      }
    });

  const download = async (name: string) => {
    try {
      downloadBlob({ filename: name, blob: await authFilesApi.download(name) });
    } catch (err) {
      showNotification(`${t('notification.download_failed')}: ${errorText(err)}`, 'error');
    }
  };

  const copyText = useCallback(
    async (text: string) => {
      const copied = await copyToClipboard(text);
      showNotification(
        copied ? t('notification.link_copied') : t('notification.copy_failed'),
        copied ? 'success' : 'error'
      );
    },
    [showNotification, t]
  );

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h1 className={styles.pageTitle}>{t('credentials.title')}</h1>
          {rows ? (
            <div className={styles.chips}>
              <span className={styles.chip}>
                {t('credentials.active_count', { active: activeCount, total: list.length })}
              </span>
              {strategy ? (
                <span className={styles.chip}>
                  {t(`credentials.strategy.${strategy}`, { defaultValue: strategy })}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className={styles.headerActions}>
          <Button
            variant="secondary"
            size="sm"
            onClick={toggleSelecting}
            disabled={!rows || list.length === 0}
          >
            {selecting ? t('credentials.select_done') : t('credentials.select_mode')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void refresh()}
            disabled={!connected}
          >
            <IconRefreshCw size={16} />
            {t('common.refresh')}
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)} disabled={!connected}>
            <IconPlus size={16} />
            {t('common.add')}
          </Button>
        </div>
      </header>

      {error ? <div className="error-box">{error}</div> : null}
      {workbench.errorMessage ? <div className="error-box">{workbench.errorMessage}</div> : null}

      {rows && list.length > 0 ? (
        <div className={styles.toolbar}>
          <label className={styles.search}>
            <IconSearch size={16} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('credentials.search')}
              aria-label={t('credentials.search')}
            />
          </label>
          {selecting ? (
            <div
              className={styles.bulk}
              role="toolbar"
              aria-label={t('auth_files.batch_toolbar_label')}
            >
              <SelectionCheckbox
                checked={allSelected}
                disabled={selectable.length === 0}
                onChange={(checked) =>
                  setChecked(
                    selectable.map((row) => row.credential.id),
                    checked
                  )
                }
                label={t('auth_files.batch_select_all')}
              />
              <span className={styles.bulkCount}>
                {t('auth_files.batch_selected', { count: chosen.length })}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void setEnabled(chosen, true)}
                disabled={controlsDisabled || chosen.length === 0}
              >
                {t('auth_files.batch_enable')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void setEnabled(chosen, false)}
                disabled={controlsDisabled || chosen.length === 0}
              >
                {t('auth_files.batch_disable')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void refreshChosenTokens()}
                disabled={controlsDisabled || !chosen.some(canRefreshToken)}
              >
                {t('credentials.refresh_tokens')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void downloadChosen()}
                disabled={!chosen.some((row) => row.file)}
              >
                {t('credentials.download')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={deleteChosen}
                disabled={controlsDisabled || chosen.length === 0}
              >
                {t('common.delete')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {!rows ? (
        <Skeleton height={320} />
      ) : list.length === 0 ? (
        <EmptyState
          title={t('credentials.empty')}
          action={
            <Button size="sm" onClick={() => setAddOpen(true)} disabled={!connected}>
              <IconPlus size={16} />
              {t('common.add')}
            </Button>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState title={t('credentials.no_match')} />
      ) : (
        <ol className={styles.list} onDragLeave={() => setDrop(null)}>
          {visible.map((row, index) => (
            <CredentialItem
              key={row.credential.id}
              row={row}
              rank={rankById.get(row.credential.id) ?? null}
              theme={theme}
              expanded={expanded.has(row.credential.id)}
              reorderable={!needle && !selecting && canSetPriority(row.credential)}
              controlsDisabled={controlsDisabled}
              dragging={dragIndex === index}
              dropSide={drop?.index === index && dragIndex !== null ? drop.side : null}
              quota={quotaEntryFor(row)}
              selection={
                selecting
                  ? {
                      checked: selected.has(row.credential.id),
                      disabled: !isEditable(row),
                      onChange: (checked) => setChecked([row.credential.id], checked),
                    }
                  : null
              }
              tokenRefreshing={Boolean(row.file && tokenRefreshing.has(row.file.name))}
              cooldownResetting={cooldownResetting.has(row.credential.authIndex)}
              onRefreshToken={
                canRefreshToken(row)
                  ? () => void refreshToken(row.file!.name, row.credential.authIndex)
                  : undefined
              }
              onDownload={
                row.file && isEditable(row) ? () => void download(row.file!.name) : undefined
              }
              onResetCooldown={
                row.credential.authIndex
                  ? () => void resetCooldown(row.credential.authIndex)
                  : undefined
              }
              onToggleExpanded={() => toggleExpanded(row.credential.id)}
              onToggleEnabled={(enabled) => void toggleEnabled(row, enabled)}
              onEdit={() => editRow(row)}
              onDelete={() => deleteRow(row)}
              onMove={(delta) => moveBy(index, delta)}
              onDragStart={() => setDragIndex(index)}
              onDragEnd={() => {
                setDragIndex(null);
                setDrop(null);
              }}
              onDragOver={(side) => setDrop({ index, side })}
              onDrop={handleDrop}
            />
          ))}
        </ol>
      )}

      <AddCredentialSheet
        open={addOpen}
        brands={brands}
        theme={theme}
        onClose={() => setAddOpen(false)}
        onUpload={(uploads) => void uploadFiles(uploads)}
        onApiKey={openApiKeyForm}
      />

      <ProviderSheet
        ref={sheetRef}
        state={sheetState}
        onClose={closeSheet}
        onSwitchToEdit={() =>
          setSheetState((state) => (state.resource ? { ...state, mode: 'edit' } : state))
        }
        workbench={workbench}
        onCreated={handleSheetSaved}
        onUpdated={handleSheetSaved}
        mutationDisabled={controlsDisabled}
      />

      <AuthFileDetailsSheet
        disableControls={!connected}
        editor={fileEditor.prefixProxyEditor}
        updatedText={fileEditor.prefixProxyUpdatedText}
        dirty={fileEditor.prefixProxyDirty}
        onClose={fileEditor.closePrefixProxyEditor}
        onCopyText={copyText}
        onSave={fileEditor.handlePrefixProxySave}
        onChange={fileEditor.handlePrefixProxyChange}
      />
    </div>
  );
}
