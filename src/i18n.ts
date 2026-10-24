import { es } from './l10n/es';

/**
 * English is the source language: every user-facing string is written in English and looked up
 * in a translation table by that text. Logs and problem reports stay in English on purpose, so
 * they read the same whoever sends them.
 */
export type Language = 'en' | 'es';

const TABLES: Record<Language, Record<string, string>> = { en: {}, es };

let current: Language = 'en';

/** `setting` is relevo.language ("auto", "en", "es"); "auto" follows VS Code's display language. */
export function resolveLanguage(setting: string | undefined, displayLanguage: string): Language {
  if (setting === 'en' || setting === 'es') {
    return setting;
  }
  return displayLanguage.toLowerCase().startsWith('es') ? 'es' : 'en';
}

export function setLanguage(language: Language): void {
  current = language;
}

export function language(): Language {
  return current;
}

/** The current language's table, for the webview (empty for English). */
export function translations(): Record<string, string> {
  return TABLES[current];
}

export function format(template: string, args: (string | number)[]): string {
  return template.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)] ?? ''));
}

/** `message` is the English text, with {0}, {1}… for the arguments. */
export function t(message: string, ...args: (string | number)[]): string {
  return format(TABLES[current][message] ?? message, args);
}
