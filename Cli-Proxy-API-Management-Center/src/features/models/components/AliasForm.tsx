import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AutocompleteInput } from '@/components/ui/AutocompleteInput';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useNotificationStore } from '@/stores';
import {
  scopeKey,
  type AliasChange,
  type AliasScope,
  type ModelAlias,
} from '@/services/api/modelAliases';
import type { ScopeOption } from '../scopes';
import styles from '../ModelsPage.module.scss';

interface AliasFormProps {
  options: ScopeOption[];
  /** The alias being edited; its scope can't change. Null adds a new one. */
  editing: ModelAlias | null;
  onClose: () => void;
  onSubmit: (scope: AliasScope, change: AliasChange) => Promise<void>;
  /** Present when editing: removes the alias from where it's stored. */
  onDelete?: () => Promise<void>;
}

export function AliasForm({ options, editing, onClose, onSubmit, onDelete }: AliasFormProps) {
  const { t } = useTranslation();
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const formId = useId();
  const scopeLabelId = useId();
  const [selected, setSelected] = useState(() =>
    editing ? scopeKey(editing.scope) : (options[0]?.key ?? '')
  );
  const [alias, setAlias] = useState(editing?.alias ?? '');
  const [upstream, setUpstream] = useState(editing?.upstream ?? '');
  const [fork, setFork] = useState(editing?.fork ?? true);
  const [forceMapping, setForceMapping] = useState(editing?.forceMapping ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const option = options.find((candidate) => candidate.key === selected);
  const scope = editing?.scope ?? option?.scope;
  const valid = Boolean(
    scope && alias.trim() && upstream.trim() && alias.trim() !== upstream.trim()
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!scope || !valid) return;
    setSaving(true);
    setError('');
    try {
      await onSubmit(scope, { alias, upstream, fork, forceMapping });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const confirmDelete = () => {
    if (!editing || !onDelete) return;
    showConfirmation({
      title: t('models_page.delete_alias'),
      message: t('models_page.delete_alias_confirm', { alias: editing.alias }),
      variant: 'danger',
      confirmText: t('common.delete'),
      onConfirm: async () => {
        setSaving(true);
        try {
          await onDelete();
          onClose();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          setSaving(false);
        }
      },
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      closeDisabled={saving}
      width={520}
      title={editing ? t('models_page.edit_alias') : t('models_page.add_alias')}
      footer={
        <>
          {editing && onDelete ? (
            <Button
              variant="danger"
              onClick={confirmDelete}
              disabled={saving}
              className={styles.footerDelete}
            >
              {t('common.delete')}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={saving} disabled={!valid}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.form} onSubmit={(event) => void submit(event)}>
        <div className="form-group">
          <label id={scopeLabelId}>{t('models_page.applies_to')}</label>
          <Select
            value={selected}
            options={options.map((candidate) => ({ value: candidate.key, label: candidate.label }))}
            onChange={setSelected}
            disabled={Boolean(editing)}
            ariaLabelledBy={scopeLabelId}
            fullWidth
          />
        </div>
        <Input
          label={t('models_page.alias')}
          value={alias}
          onChange={(event) => setAlias(event.target.value)}
          autoFocus
        />
        <AutocompleteInput
          label={t('models_page.upstream')}
          value={upstream}
          onChange={setUpstream}
          options={option?.upstreams ?? []}
        />
        {scope && scope.kind !== 'key' ? (
          <ToggleSwitch checked={fork} onChange={setFork} label={t('models_page.keep_original')} />
        ) : null}
        <ToggleSwitch
          checked={forceMapping}
          onChange={setForceMapping}
          label={t('models_page.force_mapping')}
        />
        {!editing && option?.restrictsKey ? (
          <p className={styles.formNote}>{t('models_page.restricts_key')}</p>
        ) : null}
        {error ? <div className="error-box">{error}</div> : null}
      </form>
    </Modal>
  );
}
