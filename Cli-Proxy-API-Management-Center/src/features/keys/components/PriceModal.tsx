import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import type { ModelPrice, TokenPrices } from '@/services/api/clientKeys';
import {
  effectivePrice,
  parseAmount,
  parsePriceDraft,
  PRICE_FIELD_LABELS,
  PRICE_FIELDS,
  priceDraft,
} from '../keysModel';
import styles from '../KeysPage.module.scss';

interface PriceModalProps {
  price: ModelPrice;
  onClose: () => void;
  /** Sets the model's override, or clears it with null. */
  onSave: (override: TokenPrices | null) => Promise<void>;
}

export function PriceModal({ price, onClose, onSave }: PriceModalProps) {
  const { t } = useTranslation();
  const formId = useId();
  const [draft, setDraft] = useState(() => priceDraft(effectivePrice(price)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async (override: TokenPrices | null) => {
    setSaving(true);
    setError('');
    try {
      await onSave(override);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const override = parsePriceDraft(draft);
    if (!override) {
      setError(t('keys_page.invalid_amount'));
      return;
    }
    void save(override);
  };

  return (
    <Modal
      open
      onClose={onClose}
      closeDisabled={saving}
      width={480}
      title={price.model}
      footer={
        <>
          {price.override ? (
            <Button
              variant="secondary"
              onClick={() => void save(null)}
              disabled={saving}
              className={styles.footerStart}
            >
              {t('keys_page.reset_price')}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.form} onSubmit={submit}>
        <p className={styles.caption}>{t('keys_page.per_million')}</p>
        <div className={styles.budgetGrid}>
          {PRICE_FIELDS.map((field) => (
            <Input
              key={field}
              label={t(PRICE_FIELD_LABELS[field])}
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={draft[field]}
              aria-invalid={parseAmount(draft[field]) === null}
              onChange={(event) => setDraft((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          ))}
        </div>
        {error ? <div className="error-box">{error}</div> : null}
      </form>
    </Modal>
  );
}
