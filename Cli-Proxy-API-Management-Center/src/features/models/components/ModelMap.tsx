import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconSearch } from '@/components/ui/icons';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { CredentialLogo } from '@/features/credentials/components/CredentialLogo';
import type { ModelAlias } from '@/services/api/modelAliases';
import type { ResolvedTheme } from '@/types';
import type { ModelEntry, ModelRoute } from '../modelMap';
import styles from '../ModelsPage.module.scss';

interface ModelMapProps {
  entries: ModelEntry[];
  theme: ResolvedTheme;
  /** The alias definition behind a renamed route, when one can be edited. */
  aliasFor: (route: ModelRoute, modelId: string) => ModelAlias | null;
  onEditAlias: (alias: ModelAlias) => void;
}

/** Every model clients can request, with the credentials serving it in pick order. */
export function ModelMap({ entries, theme, aliasFor, onEditAlias }: ModelMapProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [aliasesOnly, setAliasesOnly] = useState(false);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter(
      (entry) =>
        (!aliasesOnly || entry.renamed) &&
        (!needle ||
          entry.id.toLowerCase().includes(needle) ||
          entry.routes.some((route) =>
            route.upstream.some((name) => name.toLowerCase().includes(needle))
          ))
    );
  }, [aliasesOnly, entries, query]);

  const renderRoute = (modelId: string, route: ModelRoute, index: number) => {
    const renamedTo = route.upstream.filter((name) => name !== modelId);
    const alias = renamedTo.length > 0 ? aliasFor(route, modelId) : null;
    const dimmed =
      Boolean(route.inactive) || route.row.disabled || route.row.credential.unavailable;
    const className = [
      styles.route,
      dimmed ? styles.routeInactive : '',
      alias ? styles.routeAlias : '',
    ]
      .filter(Boolean)
      .join(' ');
    const content = (
      <>
        <span className={styles.rank}>{route.inactive ? '–' : route.rank}</span>
        <CredentialLogo row={route.row} theme={theme} className={styles.logo} />
        <span className={styles.routeName}>{route.row.title}</span>
        {renamedTo.length > 0 ? (
          <span className={styles.upstream}>→ {renamedTo.join(', ')}</span>
        ) : null}
        {route.inactive ? (
          <span className={styles.statusTag}>{t(`models_page.status.${route.inactive}`)}</span>
        ) : null}
      </>
    );
    return (
      <li key={`${route.row.credential.id}|${index}`}>
        {alias ? (
          <button
            type="button"
            className={className}
            title={route.row.detail || undefined}
            onClick={() => onEditAlias(alias)}
          >
            {content}
          </button>
        ) : (
          <span className={className} title={route.row.detail || undefined}>
            {content}
          </span>
        )}
      </li>
    );
  };

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <label className={styles.search}>
          <IconSearch size={16} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('model_map.search')}
            aria-label={t('model_map.search')}
          />
        </label>
        <ToggleSwitch
          checked={aliasesOnly}
          onChange={setAliasesOnly}
          label={t('model_map.aliases_only')}
        />
      </div>

      {visible.length === 0 ? (
        <EmptyState title={entries.length === 0 ? t('model_map.empty') : t('model_map.no_match')} />
      ) : (
        <ul className={styles.list}>
          {visible.map((entry) => (
            <li
              key={entry.id}
              className={`${styles.entry} ${entry.live ? '' : styles.entryInactive}`.trim()}
            >
              <div className={styles.modelCell}>
                <span className={styles.modelId}>{entry.id}</span>
                {entry.renamed ? (
                  <span className={styles.aliasTag}>{t('model_map.alias')}</span>
                ) : null}
              </div>
              <ol className={styles.routes}>
                {entry.routes.map((route, index) => renderRoute(entry.id, route, index))}
              </ol>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
