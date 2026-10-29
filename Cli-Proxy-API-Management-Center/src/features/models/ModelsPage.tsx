import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { Button } from '@/components/ui/Button';
import { IconPlus, IconRefreshCw } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { useCredentialRows } from '@/features/credentials/useCredentialRows';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import {
  modelAliasesApi,
  type AliasChange,
  type AliasScope,
  type KeyModel,
  type ModelAlias,
} from '@/services/api/modelAliases';
import { useAuthStore, useConfigStore, useThemeStore } from '@/stores';
import { AliasForm } from './components/AliasForm';
import { ModelMap } from './components/ModelMap';
import { buildModelMap, inactiveRoutes, type ModelRoute } from './modelMap';
import { aliasScopes, findAlias } from './scopes';
import styles from './ModelsPage.module.scss';

type FormState = { editing: ModelAlias | null } | null;

export function ModelsPage() {
  const { t } = useTranslation();
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const strategy = useConfigStore((state) => state.config?.routingStrategy);
  const theme = useThemeStore((state) => state.resolvedTheme);
  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.status === 'current' : true;

  const { rows, error, refresh: refreshRows, reload: reloadRows } = useCredentialRows();
  const [definitions, setDefinitions] = useState<{
    aliases: ModelAlias[];
    keyModels: KeyModel[];
  } | null>(null);
  const [form, setForm] = useState<FormState>(null);
  const requestRef = useRef(0);

  const fileKey = (rows ?? [])
    .flatMap((row) => (row.file && row.credential.kind === 'oauth' ? [row.file.name] : []))
    .join('\n');
  const loadDefinitions = useCallback(async () => {
    const request = ++requestRef.current;
    if (!connected) return;
    try {
      const next = await modelAliasesApi.load(fileKey ? fileKey.split('\n') : []);
      if (request === requestRef.current) setDefinitions(next);
    } catch {
      // The map still shows everything the router serves.
    }
  }, [connected, fileKey]);
  useEffect(() => {
    void loadDefinitions();
  }, [loadDefinitions]);

  const refresh = useCallback(async () => {
    await Promise.allSettled([refreshRows(), loadDefinitions()]);
  }, [loadDefinitions, refreshRows]);
  useHeaderRefresh(refresh, isCurrentLayer);

  const aliases = useMemo(() => definitions?.aliases ?? [], [definitions]);
  const entries = useMemo(() => {
    if (!rows) return null;
    const inactive = definitions ? inactiveRoutes(rows, aliases, definitions.keyModels) : [];
    return buildModelMap(rows, strategy, inactive);
  }, [aliases, definitions, rows, strategy]);

  const liveCount = entries?.filter((entry) => entry.live).length ?? 0;
  const inactiveCount = (entries?.length ?? 0) - liveCount;
  const aliasedCount =
    entries?.filter((entry) =>
      entry.routes.some(
        (route) => !route.inactive && route.upstream.some((name) => name !== entry.id)
      )
    ).length ?? 0;

  const channels = useMemo(
    () => aliases.flatMap((alias) => (alias.scope.kind === 'channel' ? [alias.scope.channel] : [])),
    [aliases]
  );
  const options = useMemo(() => aliasScopes(rows ?? [], channels, t), [channels, rows, t]);

  // The OAuth editors open a provider's saved settings when the URL names it, else an empty form.
  const oauthProviders = new Set(
    (rows ?? []).flatMap((row) =>
      row.credential.kind === 'oauth' ? [row.credential.provider] : []
    )
  );
  const editorQuery =
    oauthProviders.size === 1 ? `?provider=${encodeURIComponent([...oauthProviders][0])}` : '';

  const aliasFor = useCallback(
    (route: ModelRoute, modelId: string) =>
      findAlias(aliases, rows ?? [], route.row, modelId, route.upstream[0] ?? ''),
    [aliases, rows]
  );

  const save = async (
    scope: AliasScope,
    original: ModelAlias | null,
    change: AliasChange | null
  ) => {
    await modelAliasesApi.save(scope, original, change);
    await Promise.all([loadDefinitions(), reloadRows()]);
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h1 className={styles.pageTitle}>{t('model_map.title')}</h1>
          {entries ? (
            <div className={styles.chips}>
              <span className={styles.chip}>{t('model_map.count', { count: liveCount })}</span>
              <span className={styles.chip}>
                {t('model_map.alias_count', { count: aliasedCount })}
              </span>
              {inactiveCount > 0 ? (
                <span className={styles.chip}>
                  {t('model_map.inactive_count', { count: inactiveCount })}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className={styles.headerActions}>
          <Link
            className={styles.link}
            to={`/auth-files/oauth-model-alias${editorQuery}`}
            state={{ fromAuthFiles: true }}
          >
            {t('models_page.oauth_alias_editor')}
          </Link>
          <Link
            className={styles.link}
            to={`/auth-files/oauth-excluded${editorQuery}`}
            state={{ fromAuthFiles: true }}
          >
            {t('model_map.oauth_exclusions')}
          </Link>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void refresh()}
            disabled={!connected}
          >
            <IconRefreshCw size={16} />
            {t('common.refresh')}
          </Button>
          <Button
            size="sm"
            onClick={() => setForm({ editing: null })}
            disabled={!connected || options.length === 0}
          >
            <IconPlus size={16} />
            {t('models_page.add_alias')}
          </Button>
        </div>
      </header>

      {error ? <div className="error-box">{error}</div> : null}

      {!entries ? (
        <Skeleton height={320} />
      ) : (
        <ModelMap
          entries={entries}
          theme={theme}
          aliasFor={aliasFor}
          onEditAlias={(alias) => setForm({ editing: alias })}
        />
      )}

      {form ? (
        <AliasForm
          options={options}
          editing={form.editing}
          onClose={() => setForm(null)}
          onSubmit={(scope, change) => save(scope, form.editing, change)}
          onDelete={form.editing ? () => save(form.editing!.scope, form.editing, null) : undefined}
        />
      ) : null}
    </div>
  );
}
