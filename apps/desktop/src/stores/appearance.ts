import { defineStore } from 'pinia'
import { ref } from 'vue'

export type Theme = 'light' | 'dark' | 'system'
export type Accent = 'ink' | 'coral' | 'blue' | 'green' | 'gold' | 'violet' | 'slate'

interface AppearanceSettings {
  theme: Theme
  accent: Accent
  bodyFontSize: number
  lineHeight: number
}

const LS_KEY = 'nekowite.appearance'

const DEFAULTS: AppearanceSettings = {
  theme: 'system',
  accent: 'ink',
  bodyFontSize: 15,
  lineHeight: 1.8,
}

function readStored(): AppearanceSettings {
  const raw = localStorage.getItem(LS_KEY)
  if (!raw) return DEFAULTS
  try {
    const parsed = JSON.parse(raw) as Partial<AppearanceSettings>
    return {
      theme: parsed.theme ?? DEFAULTS.theme,
      accent: parsed.accent ?? DEFAULTS.accent,
      bodyFontSize: parsed.bodyFontSize ?? DEFAULTS.bodyFontSize,
      lineHeight: parsed.lineHeight ?? DEFAULTS.lineHeight,
    }
  } catch {
    return DEFAULTS
  }
}

export const useAppearanceStore = defineStore('appearance', () => {
  const stored = readStored()
  const theme = ref<Theme>(stored.theme)
  const accent = ref<Accent>(stored.accent)
  const bodyFontSize = ref<number>(stored.bodyFontSize)
  const lineHeight = ref<number>(stored.lineHeight)
  const systemRevision = ref(0)

  function persist(): void {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        theme: theme.value,
        accent: accent.value,
        bodyFontSize: bodyFontSize.value,
        lineHeight: lineHeight.value,
      }),
    )
  }

  function effectiveTheme(): 'light' | 'dark' {
    if (theme.value !== 'system') return theme.value
    if (typeof window.matchMedia !== 'function') return 'light'
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  function setTheme(t: Theme): void {
    theme.value = t
    persist()
  }

  function setAccent(a: Accent): void {
    accent.value = a
    persist()
  }

  function setBodyFontSize(n: number): void {
    bodyFontSize.value = n
    persist()
  }

  function setLineHeight(n: number): void {
    lineHeight.value = n
    persist()
  }

  function touchSystem(): void {
    systemRevision.value++
  }

  return {
    theme,
    accent,
    bodyFontSize,
    lineHeight,
    systemRevision,
    effectiveTheme,
    setTheme,
    setAccent,
    setBodyFontSize,
    setLineHeight,
    touchSystem,
  }
})
