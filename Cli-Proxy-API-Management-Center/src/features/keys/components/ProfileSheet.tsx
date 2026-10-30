import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { IconPlus } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { Sheet } from '@/components/ui/Sheet';
import { useCredentialRows } from '@/features/credentials/useCredentialRows';
import { buildModelMap } from '@/features/models/modelMap';
import type { KeyProfile, ProfileRule } from '@/services/api/clientKeys';
import { cleanProfile, profileProblem } from '../keysModel';
import { RuleEditor } from './RuleEditor';
import styles from '../KeysPage.module.scss';

interface ProfileSheetProps {
  /** Null adds a new profile. */
  profile: KeyProfile | null;
  /** The other profiles, whose names this one can't reuse. */
  others: KeyProfile[];
  onClose: () => void;
  onSave: (profile: KeyProfile) => Promise<void>;
}

// Rules carry an id while edited, so moving one keeps focus and field state with it.
type RuleDraft = ProfileRule & { uid: number };
let lastUid = 0;
const withUid = (rule: ProfileRule): RuleDraft => ({ ...rule, uid: ++lastUid });

const emptyRule = (): ProfileRule => ({
  models: [''],
  efforts: [],
  action: 'block',
  redirectModel: '',
  redirectEffort: '',
});

export function ProfileSheet({ profile, others, onClose, onSave }: ProfileSheetProps) {
  const { t } = useTranslation();
  const formId = useId();
  const [name, setName] = useState(profile?.name ?? '');
  const [rules, setRules] = useState<RuleDraft[]>(() => (profile?.rules ?? []).map(withUid));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);
  // The rule list can push the error below the fold.
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  const { rows } = useCredentialRows();
  const modelIds = useMemo(
    () => (rows ? buildModelMap(rows, undefined).map((entry) => entry.id) : []),
    [rows]
  );

  const updateRule = (uid: number, rule: ProfileRule) =>
    setRules((prev) => prev.map((item) => (item.uid === uid ? { ...rule, uid } : item)));
  const moveRule = (index: number, delta: -1 | 1) =>
    setRules((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const cleaned = cleanProfile({ id: profile?.id ?? '', name, rules });
    const problem = profileProblem(cleaned, others);
    if (problem) {
      setError(t(`keys_page.profile_errors.${problem.key}`, { rule: problem.rule }));
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave(cleaned);
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
      size="lg"
      title={profile ? t('keys_page.edit_profile') : t('keys_page.add_profile')}
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
          <legend className={styles.legend}>{t('keys_page.rules')}</legend>
          {rules.length > 0 ? (
            <ol className={styles.rules}>
              {rules.map((rule, index) => (
                <RuleEditor
                  key={rule.uid}
                  rule={rule}
                  index={index}
                  count={rules.length}
                  modelIds={modelIds}
                  onChange={(next) => updateRule(rule.uid, next)}
                  onMove={(delta) => moveRule(index, delta)}
                  onDelete={() => setRules((prev) => prev.filter((item) => item.uid !== rule.uid))}
                />
              ))}
            </ol>
          ) : null}
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setRules((prev) => [...prev, withUid(emptyRule())])}
            >
              <IconPlus size={14} />
              {t('keys_page.add_rule')}
            </Button>
          </div>
        </fieldset>
        {error ? (
          <div ref={errorRef} className="error-box">
            {error}
          </div>
        ) : null}
      </form>
    </Sheet>
  );
}
