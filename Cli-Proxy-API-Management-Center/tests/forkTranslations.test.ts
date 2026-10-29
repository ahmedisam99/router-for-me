import { describe, expect, test } from 'bun:test';
import { forkBundles } from '@/i18n/fork';
import { isRecord } from '@/utils/helpers';

// Plural suffixes differ per language, so keys are compared without them.
const keys = (value: unknown, prefix = ''): string[] =>
  isRecord(value)
    ? Object.entries(value).flatMap(([key, child]) => keys(child, `${prefix}${key}.`))
    : [prefix.slice(0, -1).replace(/_(zero|one|two|few|many|other)$/, '')];

describe('fork translations', () => {
  const english = new Set(keys(forkBundles.en));

  test.each(Object.keys(forkBundles))('%s covers every English key', (language) => {
    expect(new Set(keys(forkBundles[language]))).toEqual(english);
  });
});
