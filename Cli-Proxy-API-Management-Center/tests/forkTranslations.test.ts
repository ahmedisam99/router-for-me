import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createInstance } from 'i18next';
import { addForkTranslations, forkBundles } from '@/i18n/fork';
import { isRecord } from '@/utils/helpers';

// Read from disk, so the check sees upstream's files as shipped.
const upstreamBundle = (language: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../src/i18n/locales/${language}.json`, import.meta.url), 'utf8')
  );

const paths = (value: unknown, prefix = ''): string[] =>
  isRecord(value)
    ? Object.entries(value).flatMap(([key, child]) => paths(child, `${prefix}${key}.`))
    : [prefix.slice(0, -1)];

// Plural suffixes differ per language, so keys are compared without them.
const keys = (value: unknown): string[] =>
  paths(value).map((path) => path.replace(/_(zero|one|two|few|many|other)$/, ''));

describe('fork translations', () => {
  const english = new Set(keys(forkBundles.en));

  test.each(Object.keys(forkBundles))('%s covers every English key', (language) => {
    expect(new Set(keys(forkBundles[language]))).toEqual(english);
  });

  test('adds fork strings without writing into upstream bundles, upstream winning', async () => {
    const upstream = { nav: { dashboard: 'Dashboard', keys: 'Upstream keys' } };
    const i18n = createInstance();
    await i18n.init({ lng: 'en', resources: { en: { translation: upstream } } });
    addForkTranslations(i18n);
    expect(i18n.t('nav.models')).toBe('Models');
    expect(i18n.t('nav.keys')).toBe('Upstream keys');
    expect(upstream).toEqual({ nav: { dashboard: 'Dashboard', keys: 'Upstream keys' } });
  });

  // addForkTranslations never overwrites, so a key upstream also has would be silently ignored.
  test.each(Object.keys(forkBundles))('%s adds only keys upstream lacks', (language) => {
    const upstream = new Set(paths(upstreamBundle(language)));
    expect(paths(forkBundles[language]).filter((path) => upstream.has(path))).toEqual([]);
  });
});
