import { defineStore } from 'pinia'
import { ref } from 'vue'

export type Theme = 'light' | 'dark' | 'system'
export type Accent =
  | 'ink'
  | 'coral'
  | 'blue'
  | 'green'
  | 'gold'
  | 'violet'
  | 'slate'
  | 'teal'
  | 'lime'
  | 'rose'
  | 'amber'

export const SIDEBAR_WIDTH_MIN = 160
export const SIDEBAR_WIDTH_MAX = 520
export const SIDEBAR_WIDTH_DEFAULT = 232
export const RAIL_WIDTH_MIN = 220
export const RAIL_WIDTH_MAX = 640
export const RAIL_WIDTH_DEFAULT = 300
export const NOTELIST_WIDTH_MIN = 200
export const NOTELIST_WIDTH_MAX = 520
export const NOTELIST_WIDTH_DEFAULT = 280

export type UiFontId = 'system' | 'inter' | 'serif' | 'rounded'
export type EditorFontId = 'system' | 'serif' | 'sans' | 'reading'
export type MonoFontId = 'mono' | 'cascadia' | 'jetbrains'

export const UI_FONTS: Record<UiFontId, string> = {
  system: 'Inter, "PingFang SC", "Microsoft YaHei", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  inter: '"Inter", "PingFang SC", "Microsoft YaHei", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'Georgia, "Songti SC", "Noto Serif SC", "Source Han Serif SC", "Times New Roman", serif',
  rounded: '"Nunito", ui-rounded, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
}

export const EDITOR_FONTS: Record<EditorFontId, string> = {
  system: 'var(--app-font)',
  serif: 'Georgia, "Songti SC", "Noto Serif SC", "Source Han Serif SC", "Times New Roman", serif',
  sans: 'Inter, "PingFang SC", "Microsoft YaHei", ui-sans-serif, system-ui, sans-serif',
  reading: '"Literata", "Source Serif 4", Georgia, "Songti SC", serif',
}

export const MONO_FONTS: Record<MonoFontId, string> = {
  mono: '"SFMono-Regular", "Cascadia Code", "Roboto Mono", Menlo, Monaco, Consolas, "PingFang SC", "Microsoft YaHei", ui-monospace, monospace',
  cascadia: '"Cascadia Code", "Cascadia Mono", "SFMono-Regular", Consolas, "PingFang SC", ui-monospace, monospace',
  jetbrains: '"JetBrains Mono", "Cascadia Code", "SFMono-Regular", Menlo, Monaco, Consolas, ui-monospace, monospace',
}

export const WORD_GOAL_MAX = 100000

interface AppearanceSettings {
  theme: Theme
  accent: Accent
  bodyFontSize: number
  lineHeight: number
  sidebarWidth: number
  railWidth: number
  notelistWidth: number
  uiFont: UiFontId
  editorFont: EditorFontId
  monoFont: MonoFontId
  focusMode: boolean
  wordGoal: number
  spellCheckEnabled: boolean
  softWrap: boolean
  lineNumbers: boolean
  autosaveOnBlur: boolean
  statusBarWords: boolean
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
  uiFont: 'system',
  editorFont: 'system',
  monoFont: 'mono',
  focusMode: false,
  wordGoal: 0,
  spellCheckEnabled: true,
  softWrap: true,
  lineNumbers: true,
  autosaveOnBlur: true,
  statusBarWords: true,
}

const UI_FONT_IDS: UiFontId[] = ['system', 'inter', 'serif', 'rounded']
const EDITOR_FONT_IDS: EditorFontId[] = ['system', 'serif', 'sans', 'reading']
const MONO_FONT_IDS: MonoFontId[] = ['mono', 'cascadia', 'jetbrains']
const ACCENTS: Accent[] = ['ink', 'coral', 'blue', 'green', 'gold', 'violet', 'slate', 'teal', 'lime', 'rose', 'amber']

function pickFont<T extends string>(value: unknown, valid: T[], fallback: T): T {
  return typeof value === 'string' && (valid as string[]).includes(value) ? (value as T) : fallback
}

function readBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
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
      theme:
        parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'system'
          ? parsed.theme
          : DEFAULTS.theme,
      accent: typeof parsed.accent === 'string' && ACCENTS.includes(parsed.accent as Accent)
        ? (parsed.accent as Accent)
        : DEFAULTS.accent,
      bodyFontSize: parsed.bodyFontSize ?? DEFAULTS.bodyFontSize,
      lineHeight: parsed.lineHeight ?? DEFAULTS.lineHeight,
      sidebarWidth: clampInt(parsed.sidebarWidth ?? DEFAULTS.sidebarWidth, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX, DEFAULTS.sidebarWidth),
      railWidth: clampInt(parsed.railWidth ?? DEFAULTS.railWidth, RAIL_WIDTH_MIN, RAIL_WIDTH_MAX, DEFAULTS.railWidth),
      notelistWidth: clampInt(parsed.notelistWidth ?? DEFAULTS.notelistWidth, NOTELIST_WIDTH_MIN, NOTELIST_WIDTH_MAX, DEFAULTS.notelistWidth),
      uiFont: pickFont(parsed.uiFont, UI_FONT_IDS, DEFAULTS.uiFont),
      editorFont: pickFont(parsed.editorFont, EDITOR_FONT_IDS, DEFAULTS.editorFont),
      monoFont: pickFont(parsed.monoFont, MONO_FONT_IDS, DEFAULTS.monoFont),
      focusMode: readBool(parsed.focusMode, DEFAULTS.focusMode),
      wordGoal: clampInt(parsed.wordGoal ?? DEFAULTS.wordGoal, 0, WORD_GOAL_MAX, DEFAULTS.wordGoal),
      spellCheckEnabled: readBool(parsed.spellCheckEnabled, DEFAULTS.spellCheckEnabled),
      softWrap: readBool(parsed.softWrap, DEFAULTS.softWrap),
      lineNumbers: readBool(parsed.lineNumbers, DEFAULTS.lineNumbers),
      autosaveOnBlur: readBool(parsed.autosaveOnBlur, DEFAULTS.autosaveOnBlur),
      statusBarWords: readBool(parsed.statusBarWords, DEFAULTS.statusBarWords),
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
  const uiFont = ref<UiFontId>(stored.uiFont)
  const editorFont = ref<EditorFontId>(stored.editorFont)
  const monoFont = ref<MonoFontId>(stored.monoFont)
  const focusMode = ref<boolean>(stored.focusMode)
  const wordGoal = ref<number>(stored.wordGoal)
  const spellCheckEnabled = ref<boolean>(stored.spellCheckEnabled)
  const softWrap = ref<boolean>(stored.softWrap)
  const lineNumbers = ref<boolean>(stored.lineNumbers)
  const autosaveOnBlur = ref<boolean>(stored.autosaveOnBlur)
  const statusBarWords = ref<boolean>(stored.statusBarWords)
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
        uiFont: uiFont.value,
        editorFont: editorFont.value,
        monoFont: monoFont.value,
        focusMode: focusMode.value,
        wordGoal: wordGoal.value,
        spellCheckEnabled: spellCheckEnabled.value,
        softWrap: softWrap.value,
        lineNumbers: lineNumbers.value,
        autosaveOnBlur: autosaveOnBlur.value,
        statusBarWords: statusBarWords.value,
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

  function setUiFont(f: UiFontId): void {
    uiFont.value = f
    persist()
  }

  function setEditorFont(f: EditorFontId): void {
    editorFont.value = f
    persist()
  }

  function setMonoFont(f: MonoFontId): void {
    monoFont.value = f
    persist()
  }

  function setFocusMode(v: boolean): void {
    focusMode.value = v
    persist()
  }

  function setWordGoal(n: number): void {
    wordGoal.value = clampInt(n, 0, WORD_GOAL_MAX, DEFAULTS.wordGoal)
    persist()
  }

  function setSpellCheckEnabled(v: boolean): void {
    spellCheckEnabled.value = v
    persist()
  }

  function setSoftWrap(v: boolean): void {
    softWrap.value = v
    persist()
  }

  function setLineNumbers(v: boolean): void {
    lineNumbers.value = v
    persist()
  }

  function setAutosaveOnBlur(v: boolean): void {
    autosaveOnBlur.value = v
    persist()
  }

  function setStatusBarWords(v: boolean): void {
    statusBarWords.value = v
    persist()
  }

  function touchSystem(): void {
    systemRevision.value++
  }

  function uiFontFamily(): string {
    return UI_FONTS[uiFont.value] ?? UI_FONTS.system
  }

  function editorFontFamily(): string {
    return EDITOR_FONTS[editorFont.value] ?? EDITOR_FONTS.system
  }

  function monoFontFamily(): string {
    return MONO_FONTS[monoFont.value] ?? MONO_FONTS.mono
  }

  return {
    theme,
    accent,
    bodyFontSize,
    lineHeight,
    sidebarWidth,
    railWidth,
    notelistWidth,
    uiFont,
    editorFont,
    monoFont,
    focusMode,
    wordGoal,
    spellCheckEnabled,
    softWrap,
    lineNumbers,
    autosaveOnBlur,
    statusBarWords,
    systemRevision,
    effectiveTheme,
    setTheme,
    setAccent,
    setBodyFontSize,
    setLineHeight,
    setSidebarWidth,
    setRailWidth,
    setNotelistWidth,
    setUiFont,
    setEditorFont,
    setMonoFont,
    setFocusMode,
    setWordGoal,
    setSpellCheckEnabled,
    setSoftWrap,
    setLineNumbers,
    setAutosaveOnBlur,
    setStatusBarWords,
    touchSystem,
    uiFontFamily,
    editorFontFamily,
    monoFontFamily,
  }
})
