import { describe, expect, test } from 'bun:test';
import { forkBundles } from '@/i18n/fork';
import en from '@/i18n/locales/en.json';
import ko from '@/i18n/locales/ko.json';
import ru from '@/i18n/locales/ru.json';
import vi from '@/i18n/locales/vi.json';
import zhCN from '@/i18n/locales/zh-CN.json';
import zhTW from '@/i18n/locales/zh-TW.json';
import { isRecord } from '@/utils/helpers';

const upstreamBundles: Record<string, object> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  en,
  ru,
  vi,
  ko,
};

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
    const upstream = new Set(paths(upstreamBundles[language]));
    expect(paths(forkBundles[language]).filter((path) => upstream.has(path))).toEqual([]);
  });
});
