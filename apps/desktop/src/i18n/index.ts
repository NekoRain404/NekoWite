import { createI18n } from 'vue-i18n'
import { zh } from './zh'
import { en } from './en'

export type Locale = 'zh' | 'en'

export const messages = { zh, en } as const
export const LOCALE_KEY = 'nekowite.locale'

function storedLocale(): Locale {
  try {
    const v = localStorage.getItem(LOCALE_KEY)
    return v === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: storedLocale(),
  fallbackLocale: 'zh',
  messages,
})

export function getLocale(): Locale {
  return i18n.global.locale.value as Locale
}

export function setLocale(locale: Locale): void {
  i18n.global.locale.value = locale
  try {
    localStorage.setItem(LOCALE_KEY, locale)
  } catch {
    // storage unavailable (e.g. tests) — the in-memory locale still switches
  }
}

/** Translate a message key, interpolating `{name}` placeholders.
 *  Reads the shared i18n singleton, so it is reactive to locale changes and
 *  safe to call from non-component code (services, catalog data, …). */
export function t(key: string, params?: Record<string, unknown>): string {
  return i18n.global.t(key, params ?? {})
}
