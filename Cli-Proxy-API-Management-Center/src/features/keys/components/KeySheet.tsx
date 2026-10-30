import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Sheet } from '@/components/ui/Sheet';
import {
  BUDGET_WINDOWS,
  keySettings,
  type ClientKey,
  type KeySettings,
  type OverBudget,
} from '@/services/api/clientKeys';
import { budgetDraft, parseAmount, parseBudgetDraft } from '../keysModel';
import styles from '../KeysPage.module.scss';

interface KeySheetProps {
  item: ClientKey;
  label: string;
  /** The browser-stored name, '' for none. */
  name: string;
  onClose: () => void;
  onSubmit: (name: string, settings: KeySettings) => Promise<void>;
}

/** Budgets, what happens past them, and the key's name in this browser. */
export function KeySheet({ item, label, name: initialName, onClose, onSubmit }: KeySheetProps) {
  const { t } = useTranslation();
  const formId = useId();
  const overLabelId = useId();
  const [name, setName] = useState(initialName);
  const [draft, setDraft] = useState(() => budgetDraft(item.budgets));
  const [overBudget, setOverBudget] = useState<OverBudget>(item.overBudget);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const budgets = parseBudgetDraft(draft);
    if (!budgets) {
      setError(t('keys_page.invalid_amount'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSubmit(name, { ...keySettings(item), budgets, overBudget });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      closeDisabled={saving}
      title={label}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.form} onSubmit={(event) => void submit(event)}>
        <Input
          label={t('keys_page.name')}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>{t('keys_page.budgets')}</legend>
          <div className={styles.budgetGrid}>
            {BUDGET_WINDOWS.map((window) => (
              <Input
                key={window}
                label={t(`keys_page.window_budgets.${window}`)}
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={draft[window]}
                aria-invalid={parseAmount(draft[window]) === null}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, [window]: event.target.value }))
                }
              />
            ))}
          </div>
        </fieldset>
        <div className="form-group">
          <label id={overLabelId}>{t('keys_page.when_over')}</label>
          <Select
            value={overBudget}
            options={[
              { value: 'block', label: t('keys_page.over_block') },
              { value: 'warn', label: t('keys_page.over_warn') },
            ]}
            onChange={(value) => setOverBudget(value === 'warn' ? 'warn' : 'block')}
            ariaLabelledBy={overLabelId}
          />
        </div>
        {error ? <div className="error-box">{error}</div> : null}
      </form>
    </Sheet>
  );
}
