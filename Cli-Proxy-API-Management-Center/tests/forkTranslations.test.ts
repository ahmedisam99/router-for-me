import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { forkBundles } from '@/i18n/fork';
import { isRecord } from '@/utils/helpers';

// Read from disk: once a test loads i18n, i18next has merged the fork into the imported bundles.
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

  // addForkTranslations never overwrites, so a key upstream also has would be silently ignored.
  test.each(Object.keys(forkBundles))('%s adds only keys upstream lacks', (language) => {
    const upstream = new Set(paths(upstreamBundle(language)));
    expect(paths(forkBundles[language]).filter((path) => upstream.has(path))).toEqual([]);
  });
});
