import { defineStore } from 'pinia'
import { ref } from 'vue'

export type Theme = 'light' | 'dark' | 'system'
export type Accent = 'ink' | 'coral' | 'blue' | 'green' | 'gold' | 'violet' | 'slate'

export const SIDEBAR_WIDTH_MIN = 160
export const SIDEBAR_WIDTH_MAX = 520
export const SIDEBAR_WIDTH_DEFAULT = 232
export const RAIL_WIDTH_MIN = 220
export const RAIL_WIDTH_MAX = 640
export const RAIL_WIDTH_DEFAULT = 300
export const NOTELIST_WIDTH_MIN = 200
export const NOTELIST_WIDTH_MAX = 520
export const NOTELIST_WIDTH_DEFAULT = 280

interface AppearanceSettings {
  theme: Theme
  accent: Accent
  bodyFontSize: number
  lineHeight: number
  sidebarWidth: number
  railWidth: number
  notelistWidth: number
}

const LS_KEY = 'nekowite.appearance'

const DEFAULTS: AppearanceSettings = {
  theme: 'system',
  accent: 'ink',
  bodyFontSize: 15,
  lineHeight: 1.8,
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  railWidth: RAIL_WIDTH_DEFAULT,
  notelistWidth: NOTELIST_WIDTH_DEFAULT,
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.round(Math.min(max, Math.max(min, numeric)))
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
      sidebarWidth: clampInt(parsed.sidebarWidth ?? DEFAULTS.sidebarWidth, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX, DEFAULTS.sidebarWidth),
      railWidth: clampInt(parsed.railWidth ?? DEFAULTS.railWidth, RAIL_WIDTH_MIN, RAIL_WIDTH_MAX, DEFAULTS.railWidth),
      notelistWidth: clampInt(parsed.notelistWidth ?? DEFAULTS.notelistWidth, NOTELIST_WIDTH_MIN, NOTELIST_WIDTH_MAX, DEFAULTS.notelistWidth),
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
  const sidebarWidth = ref<number>(stored.sidebarWidth)
  const railWidth = ref<number>(stored.railWidth)
  const notelistWidth = ref<number>(stored.notelistWidth)
  const systemRevision = ref(0)

  function persist(): void {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        theme: theme.value,
        accent: accent.value,
        bodyFontSize: bodyFontSize.value,
        lineHeight: lineHeight.value,
        sidebarWidth: sidebarWidth.value,
        railWidth: railWidth.value,
        notelistWidth: notelistWidth.value,
      }),
    )
  }

  function effectiveTheme(): 'light' | 'dark' {
    // Read systemRevision so any consumer wrapping this in a computed
    // re-evaluates when the OS theme flips (matchMedia itself is not reactive).
    void systemRevision.value
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
    bodyFontSize.value = Math.min(20, Math.max(12, Number.isFinite(n) ? n : DEFAULTS.bodyFontSize))
    persist()
  }

  function setLineHeight(n: number): void {
    lineHeight.value = Math.min(2.4, Math.max(1.2, Number.isFinite(n) ? n : DEFAULTS.lineHeight))
    persist()
  }

  function setSidebarWidth(n: number): void {
    sidebarWidth.value = clampInt(n, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX, DEFAULTS.sidebarWidth)
    persist()
  }

  function setRailWidth(n: number): void {
    railWidth.value = clampInt(n, RAIL_WIDTH_MIN, RAIL_WIDTH_MAX, DEFAULTS.railWidth)
    persist()
  }

  function setNotelistWidth(n: number): void {
    notelistWidth.value = clampInt(n, NOTELIST_WIDTH_MIN, NOTELIST_WIDTH_MAX, DEFAULTS.notelistWidth)
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
    sidebarWidth,
    railWidth,
    notelistWidth,
    systemRevision,
    effectiveTheme,
    setTheme,
    setAccent,
    setBodyFontSize,
    setLineHeight,
    setSidebarWidth,
    setRailWidth,
    setNotelistWidth,
    touchSystem,
  }
})
