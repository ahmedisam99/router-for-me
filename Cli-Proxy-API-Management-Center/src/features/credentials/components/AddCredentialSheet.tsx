import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import iconVertex from '@/assets/icons/vertex.svg';
import { Sheet } from '@/components/ui/Sheet';
import { IconUpload } from '@/components/ui/icons';
import { OAuthFlowDialog } from '@/features/oauth/components/OAuthFlowDialog';
import { ProviderTile } from '@/features/oauth/components/ProviderTile';
import { VertexImportDialog } from '@/features/oauth/components/VertexImportDialog';
import { useOAuthFlows, usePluginOAuthProviders } from '@/features/oauth/hooks/useOAuthFlows';
import { useVertexImport } from '@/features/oauth/hooks/useVertexImport';
import {
  isSponsor,
  OAUTH_PROVIDERS,
  resolveThemedIcon,
  supportsManualCallback,
  type OAuthProviderCard,
} from '@/features/oauth/providers';
import { PROVIDER_LOGOS } from '@/features/providers/brandLogos';
import type { ProviderBrand } from '@/features/providers/types';
import { useAuthStore } from '@/stores';
import type { ResolvedTheme } from '@/types';
import styles from '../CredentialsPage.module.scss';

const VERTEX_DIALOG_ID = '__vertex__';

type DialogTarget = { kind: 'oauth'; id: string } | { kind: 'vertex' };

interface AddCredentialSheetProps {
  open: boolean;
  brands: ProviderBrand[];
  theme: ResolvedTheme;
  onClose: () => void;
  onUpload: (files: File[]) => void;
  onApiKey: (brand: ProviderBrand) => void;
}

/** Every way to add a credential: OAuth sign-in and imports mirror the old OAuth page. */
export function AddCredentialSheet({
  open,
  brands,
  theme,
  onClose,
  onUpload,
  onApiKey,
}: AddCredentialSheetProps) {
  const { t } = useTranslation();
  const apiBase = useAuthStore((state) => state.apiBase);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const focusedRef = useRef<string | null>(null);
  const [dialog, setDialog] = useState<DialogTarget | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const pluginProviders = usePluginOAuthProviders(apiBase);
  const providerCards = useMemo<OAuthProviderCard[]>(
    () => [...OAUTH_PROVIDERS, ...pluginProviders],
    [pluginProviders]
  );
  const flows = useOAuthFlows({
    providerCards,
    isFocused: (provider) => focusedRef.current === provider,
  });
  const vertexImport = useVertexImport({
    isFocused: () => focusedRef.current === VERTEX_DIALOG_ID,
    onCredentialAdded: flows.recordCredentialAdded,
  });

  const labelOf = (card: OAuthProviderCard) =>
    card.kind === 'plugin'
      ? card.title
      : typeof card.label === 'string'
        ? card.label
        : t(card.label.key);
  const captionOf = (card: OAuthProviderCard) => {
    if (card.kind === 'plugin') return t('auth_login.method_plugin');
    const method = t(
      card.flow === 'device' ? 'auth_login.method_device' : 'auth_login.method_browser'
    );
    return card.domain ? `${card.domain} · ${method}` : method;
  };
  const iconOf = (card: OAuthProviderCard) =>
    card.kind === 'plugin' ? card.icon : resolveThemedIcon(card.icon, theme);
  const statusLabel = (card: OAuthProviderCard) => {
    const status = flows.states[card.id]?.status;
    return status === 'waiting'
      ? t('auth_login.tile_waiting')
      : status === 'success'
        ? t('auth_login.tile_success')
        : status === 'error'
          ? t('auth_login.tile_error')
          : undefined;
  };

  const openProvider = (card: OAuthProviderCard) => {
    focusedRef.current = card.id;
    setDialog({ kind: 'oauth', id: card.id });
    setDialogOpen(true);
    if (!flows.states[card.id]?.status) void flows.startAuth(card.id);
  };
  const openVertex = () => {
    focusedRef.current = VERTEX_DIALOG_ID;
    setDialog({ kind: 'vertex' });
    setDialogOpen(true);
  };
  const closeDialog = () => {
    if (dialog?.kind === 'oauth') flows.dismissSuccess(dialog.id);
    if (dialog?.kind === 'vertex' && vertexImport.vertex.result) vertexImport.resetForAnother();
    focusedRef.current = null;
    setDialogOpen(false);
  };
  const showCredentials = () => {
    closeDialog();
    onClose();
  };

  const dialogCard =
    dialog?.kind === 'oauth' ? providerCards.find((card) => card.id === dialog.id) : undefined;

  return (
    <>
      <Sheet open={open} onClose={onClose} size="lg" title={t('credentials.add_title')}>
        <section className={styles.addSection}>
          <h3 className={styles.addHeading}>{t('credentials.add_oauth')}</h3>
          <div className={styles.addTiles}>
            {providerCards.map((card, index) => (
              <ProviderTile
                key={card.id}
                label={labelOf(card)}
                caption={captionOf(card)}
                icon={iconOf(card)}
                index={index}
                status={flows.states[card.id]?.status}
                statusLabel={statusLabel(card)}
                onOpen={() => openProvider(card)}
              />
            ))}
          </div>
        </section>

        <section className={styles.addSection}>
          <h3 className={styles.addHeading}>{t('credentials.add_import')}</h3>
          <div className={styles.addGrid}>
            <button
              type="button"
              className={styles.addOption}
              onClick={() => fileInputRef.current?.click()}
            >
              <IconUpload size={18} />
              <span>{t('credentials.add_upload')}</span>
            </button>
            <button type="button" className={styles.addOption} onClick={openVertex}>
              <img src={iconVertex} alt="" aria-hidden="true" className={styles.addLogo} />
              <span>{t('vertex_import.title')}</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = '';
                if (files.length > 0) onUpload(files);
              }}
            />
          </div>
        </section>

        <section className={styles.addSection}>
          <h3 className={styles.addHeading}>{t('credentials.add_api_key')}</h3>
          <div className={styles.addGrid}>
            {brands.map((brand) => {
              const logo = PROVIDER_LOGOS[brand];
              const src = theme === 'dark' && logo?.darkSrc ? logo.darkSrc : logo?.src;
              return (
                <button
                  key={brand}
                  type="button"
                  className={styles.addOption}
                  onClick={() => onApiKey(brand)}
                >
                  {src ? (
                    <img src={src} alt="" aria-hidden="true" className={styles.addLogo} />
                  ) : null}
                  <span>{t(`providersPage.providerNames.${brand}`)}</span>
                </button>
              );
            })}
          </div>
        </section>
      </Sheet>

      {dialogCard ? (
        <OAuthFlowDialog
          open={dialogOpen && dialog?.kind === 'oauth'}
          providerId={dialogCard.id}
          heading={{
            title:
              dialogCard.kind === 'plugin'
                ? t('auth_login.plugin_oauth_title', { name: dialogCard.title })
                : t(dialogCard.titleKey),
            caption: captionOf(dialogCard),
            icon: iconOf(dialogCard),
          }}
          state={flows.states[dialogCard.id] ?? {}}
          text={(suffix) => flows.providerText(dialogCard.id, suffix)}
          supportsCallback={supportsManualCallback(dialogCard)}
          sponsor={
            isSponsor(dialogCard)
              ? { url: dialogCard.sponsor.signUpUrl, label: t('auth_login.kimi_sign_up_button') }
              : undefined
          }
          onStart={() => void flows.startAuth(dialogCard.id)}
          onCancel={() => void flows.cancelAuth(dialogCard.id)}
          onCallbackChange={(value) => flows.setCallbackInput(dialogCard.id, value)}
          onCallbackSubmit={() => void flows.submitCallback(dialogCard.id)}
          onViewAuthFiles={showCredentials}
          onClose={closeDialog}
        />
      ) : null}

      <VertexImportDialog
        open={dialogOpen && dialog?.kind === 'vertex'}
        heading={{
          title: t('vertex_import.title'),
          caption: t('vertex_import.file_label'),
          icon: iconVertex,
        }}
        vertex={vertexImport.vertex}
        onPickFile={vertexImport.pickFile}
        onLocationChange={vertexImport.setLocation}
        onImport={() => void vertexImport.importCredential()}
        onImportAnother={vertexImport.resetForAnother}
        onViewAuthFiles={showCredentials}
        onClose={closeDialog}
      />
    </>
  );
}
