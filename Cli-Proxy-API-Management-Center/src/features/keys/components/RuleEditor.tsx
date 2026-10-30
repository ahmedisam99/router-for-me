import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { AutocompleteInput } from '@/components/ui/AutocompleteInput';
import { Button } from '@/components/ui/Button';
import { IconChevronDown, IconChevronUp, IconPlus, IconTrash2, IconX } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { THINKING_LEVELS } from '@/features/providers/thinkingLevels';
import type { ProfileRule } from '@/services/api/clientKeys';
import styles from '../KeysPage.module.scss';

interface RuleEditorProps {
  rule: ProfileRule;
  index: number;
  count: number;
  /** Served model ids, offered as patterns and redirect targets. */
  modelIds: string[];
  onChange: (rule: ProfileRule) => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
}

export function RuleEditor({
  rule,
  index,
  count,
  modelIds,
  onChange,
  onMove,
  onDelete,
}: RuleEditorProps) {
  const { t } = useTranslation();
  const id = useId();
  const n = index + 1;
  const set = (change: Partial<ProfileRule>) => onChange({ ...rule, ...change });
  const setModel = (at: number, value: string) =>
    set({ models: rule.models.map((model, i) => (i === at ? value : model)) });
  const toggleEffort = (level: string) => {
    const chosen = new Set(rule.efforts);
    if (chosen.has(level)) chosen.delete(level);
    else chosen.add(level);
    set({ efforts: THINKING_LEVELS.filter((item) => chosen.has(item)) });
  };

  return (
    <li className={styles.rule}>
      <div className={styles.ruleHeader}>
        <span className={styles.ruleTitle}>{t('keys_page.rule', { n })}</span>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => onMove(-1)}
            disabled={index === 0}
            aria-label={t('keys_page.move_rule_up', { n })}
            title={t('keys_page.move_rule_up', { n })}
          >
            <IconChevronUp size={16} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => onMove(1)}
            disabled={index === count - 1}
            aria-label={t('keys_page.move_rule_down', { n })}
            title={t('keys_page.move_rule_down', { n })}
          >
            <IconChevronDown size={16} />
          </button>
          <button
            type="button"
            className={`${styles.iconButton} ${styles.danger}`}
            onClick={onDelete}
            aria-label={t('keys_page.delete_rule', { n })}
            title={t('keys_page.delete_rule', { n })}
          >
            <IconTrash2 size={16} />
          </button>
        </div>
      </div>

      <div className={styles.ruleField}>
        <span id={`${id}-models`} className={styles.fieldLabel}>
          {t('keys_page.models')}
        </span>
        <div role="group" aria-labelledby={`${id}-models`} className={styles.patterns}>
          {rule.models.map((model, at) => (
            <div key={at} className={styles.pattern}>
              <AutocompleteInput
                id={`${id}-model-${at}`}
                label={t('keys_page.model_n', { n: at + 1 })}
                wrapperClassName={styles.hiddenLabel}
                value={model}
                onChange={(value) => setModel(at, value)}
                options={modelIds}
              />
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => set({ models: rule.models.filter((_, i) => i !== at) })}
                aria-label={t('keys_page.remove_model', { n: at + 1 })}
                title={t('keys_page.remove_model', { n: at + 1 })}
              >
                <IconX size={16} />
              </button>
            </div>
          ))}
          <div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => set({ models: [...rule.models, ''] })}
            >
              <IconPlus size={14} />
              {t('keys_page.add_model')}
            </Button>
          </div>
        </div>
      </div>

      <div className={styles.ruleField}>
        <span id={`${id}-efforts`} className={styles.fieldLabel}>
          {t('keys_page.effort')}
        </span>
        <div role="group" aria-labelledby={`${id}-efforts`} className={styles.efforts}>
          <button
            type="button"
            className={styles.effort}
            aria-pressed={rule.efforts.length === 0}
            onClick={() => set({ efforts: [] })}
          >
            {t('keys_page.any_effort')}
          </button>
          {THINKING_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              className={styles.effort}
              aria-pressed={rule.efforts.includes(level)}
              onClick={() => toggleEffort(level)}
            >
              {level}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.ruleField}>
        <span id={`${id}-action`} className={styles.fieldLabel}>
          {t('keys_page.action')}
        </span>
        <Select
          className={styles.actionSelect}
          value={rule.action}
          options={[
            { value: 'block', label: t('keys_page.action_block') },
            { value: 'redirect', label: t('keys_page.action_redirect') },
          ]}
          onChange={(value) => set({ action: value === 'redirect' ? 'redirect' : 'block' })}
          ariaLabelledBy={`${id}-action`}
          fullWidth={false}
          size="sm"
        />
      </div>

      {rule.action === 'redirect' ? (
        <div className={styles.redirect}>
          <AutocompleteInput
            id={`${id}-redirect-model`}
            label={t('keys_page.redirect_model')}
            value={rule.redirectModel}
            onChange={(value) => set({ redirectModel: value })}
            options={modelIds}
          />
          <div className="form-group">
            <label id={`${id}-redirect-effort`}>{t('keys_page.redirect_effort')}</label>
            <Select
              value={rule.redirectEffort}
              options={[
                { value: '', label: t('keys_page.keep') },
                ...THINKING_LEVELS.map((level) => ({ value: level, label: level })),
              ]}
              onChange={(value) => set({ redirectEffort: value })}
              ariaLabelledBy={`${id}-redirect-effort`}
              size="sm"
            />
          </div>
        </div>
      ) : null}
    </li>
  );
}
