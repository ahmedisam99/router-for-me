import type { i18n as I18n } from 'i18next';
import en from './en.json';
import ko from './ko.json';
import ru from './ru.json';
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
};

/** Merges this fork's strings into upstream's bundles, so upstream locale files stay untouched. */
export function addForkTranslations(i18n: I18n) {
  Object.entries(forkBundles).forEach(([language, bundle]) => {
    i18n.addResourceBundle(language, 'translation', bundle, true, false);
  });
}
