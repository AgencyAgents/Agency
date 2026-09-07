import { en, type MessageKey } from "./en.ts";

export type { MessageKey };

const catalogs = { en } as const;
export type Locale = keyof typeof catalogs;

let activeLocale: Locale = "en";

export function setLocale(locale: Locale): void {
  activeLocale = locale;
}

export function getLocale(): Locale {
  return activeLocale;
}

/** Resolves a message key to its localized, interpolated string. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = catalogs[activeLocale][key] ?? catalogs.en[key];
  if (!params) return template;

  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
