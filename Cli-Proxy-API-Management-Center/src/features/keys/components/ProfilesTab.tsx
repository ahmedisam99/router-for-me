import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconPlus, IconSettings, IconTrash2 } from '@/components/ui/icons';
import type { ClientKey, KeyProfile } from '@/services/api/clientKeys';
import { useNotificationStore } from '@/stores';
import { profileSummary } from '../keysModel';
import { ProfileSheet } from './ProfileSheet';
import styles from '../KeysPage.module.scss';

interface ProfilesTabProps {
  keys: ClientKey[];
  profiles: KeyProfile[];
  disabled: boolean;
  /** Replaces the whole list. */
  onSave: (profiles: KeyProfile[]) => Promise<void>;
}

type Editing = { profile: KeyProfile | null } | null;

export function ProfilesTab({ keys, profiles, disabled, onSave }: ProfilesTabProps) {
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useNotificationStore();
  const [editing, setEditing] = useState<Editing>(null);

  // Matched by id: a poll may have replaced the objects while the editor was open.
  const save = (original: KeyProfile | null, next: KeyProfile) =>
    onSave(
      original
        ? profiles.map((profile) => (profile.id === original.id ? next : profile))
        : [...profiles, next]
    );

  const remove = (target: KeyProfile) => {
    showConfirmation({
      title: t('keys_page.delete_profile'),
      message: t('keys_page.delete_profile_confirm', { name: target.name }),
      variant: 'danger',
      confirmText: t('common.delete'),
      onConfirm: async () => {
        try {
          await onSave(profiles.filter((profile) => profile.id !== target.id));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          showNotification(`${t('notification.delete_failed')}: ${message}`, 'error');
        }
      },
    });
  };

  const addButton = (
    <Button size="sm" onClick={() => setEditing({ profile: null })} disabled={disabled}>
      <IconPlus size={16} />
      {t('keys_page.add_profile')}
    </Button>
  );

  return (
    <>
      {profiles.length === 0 ? (
        <EmptyState title={t('keys_page.profiles_empty')} action={addButton} />
      ) : (
        <>
          <div className={styles.toolbar}>{addButton}</div>
          <ul className={styles.list}>
            {profiles.map((profile) => {
              const summary = profile.rules.length
                ? profileSummary(profile, t('keys_page.rule_blocked'))
                : t('keys_page.no_rules');
              const users = keys.filter((key) => key.profile === profile.id).length;
              return (
                <li key={profile.id || profile.name} className={styles.profileItem}>
                  <span className={styles.title}>{profile.name}</span>
                  <span className={styles.summary} title={summary}>
                    {summary}
                  </span>
                  <span className={styles.users}>{t('keys_page.used_by', { count: users })}</span>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.iconButton}
                      onClick={() => setEditing({ profile })}
                      disabled={disabled}
                      aria-label={t('keys_page.edit', { name: profile.name })}
                      title={t('keys_page.edit', { name: profile.name })}
                    >
                      <IconSettings size={16} />
                    </button>
                    <button
                      type="button"
                      className={`${styles.iconButton} ${styles.danger}`}
                      onClick={() => remove(profile)}
                      disabled={disabled}
                      aria-label={t('keys_page.delete', { name: profile.name })}
                      title={t('keys_page.delete', { name: profile.name })}
                    >
                      <IconTrash2 size={16} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {editing ? (
        <ProfileSheet
          profile={editing.profile}
          others={profiles.filter((profile) => profile.id !== editing.profile?.id)}
          onClose={() => setEditing(null)}
          onSave={(next) => save(editing.profile, next)}
        />
      ) : null}
    </>
  );
}
