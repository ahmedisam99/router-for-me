import type { i18n as I18n } from 'i18next';
import { isRecord } from '@/utils/helpers';
import en from './en.json';
import ko from './ko.json';
import ru from './ru.json';
import tr from './tr.json';
import vi from './vi.json';
import zhCN from './zh-CN.json';
import zhTW from './zh-TW.json';

export const forkBundles: Record<string, object> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  en,
  ru,
  vi,
  ko,
  tr,
};

/** A copy of base with every key of extra that base lacks, at any depth; base wins. */
const withMissing = (
  base: Record<string, unknown>,
  extra: Record<string, unknown>
): Record<string, unknown> => {
  const out = { ...base };
  Object.entries(extra).forEach(([key, value]) => {
    const current = out[key];
    if (isRecord(current) && isRecord(value)) out[key] = withMissing(current, value);
    else if (!(key in out)) out[key] = value;
  });
  return out;
};

/**
 * Adds this fork's strings to upstream's bundles, so upstream locale files stay untouched. It merges
 * into a copy: i18next's own deep merge writes into upstream's imported locale objects.
 */
export function addForkTranslations(i18n: I18n) {
  Object.entries(forkBundles).forEach(([language, bundle]) => {
    const upstream = i18n.getResourceBundle(language, 'translation') ?? {};
    const merged = withMissing(upstream, bundle as Record<string, unknown>);
    i18n.addResourceBundle(language, 'translation', merged, false, true);
  });
}
