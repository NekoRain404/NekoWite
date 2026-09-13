import { defineStore } from 'pinia'
import { ref } from 'vue'
import { createDomainPersister, persistence } from '../services/persistence'
import { readSystemAccentColor } from '../platform/systemAccent'

export type Theme = 'light' | 'dark' | 'system'
export type ColorScheme = 'default' | 'sunset' | 'forest' | 'ocean' | 'sakura' | 'mist' | 'graphite' | 'midnight' | 'lavender' | 'desert' | 'mint' | 'coffee' | 'plum' | 'dusk' | 'crimson'
export type ContentDirection = 'auto' | 'ltr' | 'rtl'
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
  | 'orange'
  | 'pink'
  | 'cyan'
  | 'cocoa'

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
  colorScheme: ColorScheme
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
  followSystemAccent: boolean
  renderTaskChecklist: boolean
  autoSyncScroll: boolean
  confirmBeforeDelete: boolean
  highContrast: boolean
  contentDirection: ContentDirection
}

const LS_KEY = 'nekowite.appearance'

const DEFAULTS: AppearanceSettings = {
  theme: 'system',
  colorScheme: 'default',
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
  followSystemAccent: false,
  renderTaskChecklist: true,
  autoSyncScroll: true,
  confirmBeforeDelete: true,
  highContrast: false,
  contentDirection: 'auto',
}

const UI_FONT_IDS: UiFontId[] = ['system', 'inter', 'serif', 'rounded']
const CONTENT_DIRECTIONS: ContentDirection[] = ['auto', 'ltr', 'rtl']
const EDITOR_FONT_IDS: EditorFontId[] = ['system', 'serif', 'sans', 'reading']
const MONO_FONT_IDS: MonoFontId[] = ['mono', 'cascadia', 'jetbrains']
/** Every accent the app can apply, in palette order. Exported because the
 *  settings panel renders one swatch per entry and the system-accent mapping
 *  below measures its distances against exactly this list. */
export const ACCENTS: Accent[] = ['ink', 'coral', 'blue', 'green', 'gold', 'violet', 'slate', 'teal', 'lime', 'rose', 'amber', 'orange', 'pink', 'cyan', 'cocoa']

/** The colour behind each swatch. This is the single source of truth for both
 *  the settings palette and the system-accent mapping, so following the system
 *  accent can only ever select a colour the app already has - it never invents
 *  an accent out of whatever value the OS happens to report. */
export const ACCENT_COLORS: Record<Accent, string> = {
  ink: '#343532',
  coral: '#d65f4d',
  blue: '#3f7edb',
  green: '#3e9b73',
  gold: '#b98b09',
  violet: '#8a65d1',
  slate: '#607287',
  teal: '#2e9e8f',
  lime: '#7aa816',
  rose: '#e05c76',
  amber: '#d98c1f',
  orange: '#e9782e',
  pink: '#e85c9e',
  cyan: '#1e9cc4',
  cocoa: '#8c5a3c',
}

/** An opaque 8-bit RGB triple, as the backend reports the OS accent. */
export interface Rgb {
  r: number
  g: number
  b: number
}

/** How far the OS accent read got. `unavailable` is a normal outcome on a
 *  platform without such a colour (or a registry the app may not read), and the
 *  settings panel says so rather than implying the system colour was used. */
export type SystemAccentState = 'unknown' | 'read' | 'unavailable'

/** CIE L*a*b*: a space where the plain Euclidean distance between two colours
 *  is a decent stand-in for how different they look to a person, which is what
 *  "the closest palette colour" has to mean. */
interface Lab {
  l: number
  a: number
  b: number
}

/** `#rgb`/`#rrggbb` -> rgb, or `null` for anything else. The table above is
 *  ours, so this guards a typo, not hostile input. */
function parseHexColor(hex: string): Rgb | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  const digits = match?.[1]
  if (!digits) return null
  const full = digits.length === 3 ? digits.replace(/./g, (c) => c + c) : digits
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  }
}

/** sRGB channel (0..255) -> linear light, the transfer function Lab expects. */
function linearize(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** sRGB (D65) -> CIE L*a*b*. */
function srgbToLab({ r, g, b }: Rgb): Lab {
  const lr = linearize(r)
  const lg = linearize(g)
  const lb = linearize(b)
  const x = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / 0.95047
  const y = lr * 0.2126729 + lg * 0.7151522 + lb * 0.072175
  const z = (lr * 0.0193339 + lg * 0.119192 + lb * 0.9503041) / 1.08883
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29)
  const fx = f(x)
  const fy = f(y)
  const fz = f(z)
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

/** ΔE*ab (CIE76) between two Lab colours. */
function colourDistance(a: Lab, b: Lab): number {
  return Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b)
}

const ACCENT_LAB = (() => {
  const table = {} as Record<Accent, Lab>
  for (const accent of ACCENTS) {
    const rgb = parseHexColor(ACCENT_COLORS[accent])
    // A malformed swatch would be a typo in the table above; treating it as
    // black keeps the mapping working instead of throwing at module load.
    table[accent] = rgb ? srgbToLab(rgb) : { l: 0, a: 0, b: 0 }
  }
  return table
})()

/** The palette accent closest to a colour the OS reported.
 *
 *  "Follow the system accent" cannot mean "apply the system colour": the app's
 *  accents are a fixed palette of theme variables, and that palette is not ours
 *  to repaint. It means "select the swatch that looks closest to the colour the
 *  user chose in Windows", which is a nearest-neighbour search in Lab - a
 *  saturated blue accent lands on `blue`, a greyscale one on `slate` or `ink`
 *  depending on how dark it is. Every palette colour is closest to itself, so a
 *  colour that happens to be a swatch keeps that swatch. */
export function accentFromSystemColor(rgb: Rgb): Accent {
  const source = srgbToLab(rgb)
  let best: Accent = 'ink'
  let bestDistance = Number.POSITIVE_INFINITY
  for (const accent of ACCENTS) {
    const distance = colourDistance(source, ACCENT_LAB[accent])
    if (distance < bestDistance) {
      bestDistance = distance
      best = accent
    }
  }
  return best
}
export const COLOR_SCHEMES: ColorScheme[] = ['default', 'sunset', 'forest', 'ocean', 'sakura', 'mist', 'graphite', 'midnight', 'lavender', 'desert', 'mint', 'coffee', 'plum', 'dusk', 'crimson']

export interface ColorSchemePreview {
  light: { canvas: string; panel: string; elevated: string; border: string; text: string; muted: string }
  dark: { canvas: string; panel: string; elevated: string; border: string; text: string; muted: string }
}

export const COLOR_SCHEME_PREVIEW: Record<ColorScheme, ColorSchemePreview> = {
  default: {
    light: { canvas: '#fbfaf6', panel: '#f5f3ee', elevated: '#fffefb', border: '#e7e3db', text: '#292a27', muted: '#8c8982' },
    dark: { canvas: '#171714', panel: '#1d1d1a', elevated: '#24241f', border: '#37362f', text: '#f0eee8', muted: '#a5a198' },
  },
  sunset: {
    light: { canvas: '#fff7f0', panel: '#fbece1', elevated: '#fffdf8', border: '#edd7c4', text: '#3a261d', muted: '#9a7b68' },
    dark: { canvas: '#231713', panel: '#2c1d17', elevated: '#38251d', border: '#55392b', text: '#f6e4d6', muted: '#c09178' },
  },
  forest: {
    light: { canvas: '#f4f8f1', panel: '#e8f0e2', elevated: '#fdfefa', border: '#d6e2ca', text: '#22301f', muted: '#708366' },
    dark: { canvas: '#131b12', panel: '#1a2418', elevated: '#243020', border: '#3b4d36', text: '#e8f3e2', muted: '#a6bb9b' },
  },
  ocean: {
    light: { canvas: '#f2f8fc', panel: '#e5f0f7', elevated: '#fbfeff', border: '#cfe0ec', text: '#1c2e3d', muted: '#668094' },
    dark: { canvas: '#0f1a22', panel: '#16232d', elevated: '#1e303c', border: '#355366', text: '#e4f2fa', muted: '#9fb9c9' },
  },
  sakura: {
    light: { canvas: '#fdf3f5', panel: '#f8e8eb', elevated: '#fffafa', border: '#ecd2d8', text: '#3a232a', muted: '#9d7b83' },
    dark: { canvas: '#1f1417', panel: '#281a1e', elevated: '#352128', border: '#5b3842', text: '#f8e8ec', muted: '#c494a0' },
  },
  mist: {
    light: { canvas: '#f7f8fa', panel: '#eef0f4', elevated: '#fefeff', border: '#dfe3ea', text: '#2b303a', muted: '#8b95a3' },
    dark: { canvas: '#15171c', panel: '#1b1e25', elevated: '#242831', border: '#3c4350', text: '#eef1f6', muted: '#a7b0be' },
  },
  graphite: {
    light: { canvas: '#ececec', panel: '#e0e0e0', elevated: '#f6f6f6', border: '#c7c7c7', text: '#202020', muted: '#757575' },
    dark: { canvas: '#0d0d0d', panel: '#131313', elevated: '#1c1c1c', border: '#333333', text: '#f2f2f2', muted: '#9e9e9e' },
  },
  midnight: {
    light: { canvas: '#0f1220', panel: '#151a2c', elevated: '#1e2438', border: '#323c58', text: '#eef1fa', muted: '#a2acc5' },
    dark: { canvas: '#0a0c14', panel: '#10131f', elevated: '#181c2c', border: '#2c3450', text: '#f0f3fc', muted: '#a9b2c8' },
  },
  lavender: {
    light: { canvas: '#f7f4fb', panel: '#ece5f5', elevated: '#fefdff', border: '#d9cdea', text: '#2e253d', muted: '#897c9f' },
    dark: { canvas: '#16111f', panel: '#1e172a', elevated: '#2a2138', border: '#44375b', text: '#efeaf7', muted: '#b2a4c6' },
  },
  desert: {
    light: { canvas: '#fbf4e8', panel: '#f4e8d4', elevated: '#fffdf7', border: '#e6d3b6', text: '#3e2f1d', muted: '#9a8260' },
    dark: { canvas: '#1d1710', panel: '#282017', elevated: '#352b1f', border: '#594a34', text: '#f4ead8', muted: '#c0a987' },
  },
  mint: {
    light: { canvas: '#eef9f5', panel: '#e0f2ea', elevated: '#fcfffd', border: '#c8e6d9', text: '#1d3330', muted: '#6c9a8e' },
    dark: { canvas: '#0e1a17', panel: '#142521', elevated: '#1d332e', border: '#31554c', text: '#e3f5ef', muted: '#96c3b5' },
  },
  coffee: {
    light: { canvas: '#f5eeea', panel: '#ebe0d8', elevated: '#fffaf7', border: '#dcc8bc', text: '#33221a', muted: '#8b7063' },
    dark: { canvas: '#17110e', panel: '#201713', elevated: '#2e211b', border: '#4f3b30', text: '#f2e7df', muted: '#b79584' },
  },
  plum: {
    light: { canvas: '#f9f1f5', panel: '#f0e1ea', elevated: '#fffafd', border: '#e2c8d7', text: '#35202d', muted: '#976e87' },
    dark: { canvas: '#180e16', panel: '#221420', elevated: '#311c2b', border: '#533348', text: '#f6e6f1', muted: '#c18fa9' },
  },
  dusk: {
    light: { canvas: '#f0f2fa', panel: '#e4e7f5', elevated: '#fbfcff', border: '#ced4ea', text: '#252941', muted: '#7581a6' },
    dark: { canvas: '#101223', panel: '#171a31', elevated: '#222647', border: '#374069', text: '#e9ecfa', muted: '#9ba6ca' },
  },
  crimson: {
    light: { canvas: '#fbf1f2', panel: '#f4e0e2', elevated: '#fffafb', border: '#e8c7ca', text: '#3a2024', muted: '#99747a' },
    dark: { canvas: '#1a1012', panel: '#25161a', elevated: '#341e23', border: '#5a363e', text: '#f7e6e8', muted: '#c2939b' },
  },
}

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

/** Parse a stored appearance blob with field-by-field validation, returning null
 *  when it is corrupt (the domain persister then falls back to `defaults`). */
function parseStored(raw: string): AppearanceSettings | null {
  const parsed = JSON.parse(raw) as Partial<AppearanceSettings>
  return {
    theme:
      parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'system'
        ? parsed.theme
        : DEFAULTS.theme,
    accent: typeof parsed.accent === 'string' && ACCENTS.includes(parsed.accent as Accent)
      ? (parsed.accent as Accent)
      : DEFAULTS.accent,
    colorScheme: typeof parsed.colorScheme === 'string' && COLOR_SCHEMES.includes(parsed.colorScheme as ColorScheme)
      ? (parsed.colorScheme as ColorScheme)
      : DEFAULTS.colorScheme,
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
    followSystemAccent: readBool(parsed.followSystemAccent, DEFAULTS.followSystemAccent),
    renderTaskChecklist: readBool(parsed.renderTaskChecklist, DEFAULTS.renderTaskChecklist),
    autoSyncScroll: readBool(parsed.autoSyncScroll, DEFAULTS.autoSyncScroll),
    confirmBeforeDelete: readBool(parsed.confirmBeforeDelete, DEFAULTS.confirmBeforeDelete),
    highContrast: readBool(parsed.highContrast, DEFAULTS.highContrast),
    contentDirection:
      typeof parsed.contentDirection === 'string' &&
      (CONTENT_DIRECTIONS as string[]).includes(parsed.contentDirection)
        ? (parsed.contentDirection as ContentDirection)
        : DEFAULTS.contentDirection,
  }
}

/** Versioned appearance domain (schema `version: 1`). A corrupt/missing blob
 *  yields `defaults`; a future schema bump registers a `migrations` chain that
 *  runs on load before parsing. */
const appearanceDomain = createDomainPersister<AppearanceSettings>(persistence, {
  key: LS_KEY,
  version: 1,
  defaults: () => ({ ...DEFAULTS }),
  parse: (raw) => {
    try {
      return parseStored(raw)
    } catch {
      return null
    }
  },
  serialize: (value) => JSON.stringify(value),
})

function readStored(): AppearanceSettings {
  return appearanceDomain.load()
}

export const useAppearanceStore = defineStore('appearance', () => {
  const stored = readStored()
  const theme = ref<Theme>(stored.theme)
  const colorScheme = ref<ColorScheme>(stored.colorScheme)
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
  const followSystemAccent = ref<boolean>(stored.followSystemAccent)
  const renderTaskChecklist = ref<boolean>(stored.renderTaskChecklist)
  const autoSyncScroll = ref<boolean>(stored.autoSyncScroll)
  const confirmBeforeDelete = ref<boolean>(stored.confirmBeforeDelete)
  const highContrast = ref<boolean>(stored.highContrast)
  const contentDirection = ref<ContentDirection>(stored.contentDirection)
  const systemRevision = ref(0)
  const systemAccent = ref<Rgb | null>(null)
  const systemAccentState = ref<SystemAccentState>('unknown')

  function persist(): void {
    appearanceDomain.save({
      theme: theme.value,
      colorScheme: colorScheme.value,
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
      followSystemAccent: followSystemAccent.value,
      renderTaskChecklist: renderTaskChecklist.value,
      autoSyncScroll: autoSyncScroll.value,
      confirmBeforeDelete: confirmBeforeDelete.value,
      highContrast: highContrast.value,
      contentDirection: contentDirection.value,
    })
  }

  function effectiveTheme(): 'light' | 'dark' {
    // Read systemRevision so any consumer wrapping this in a computed
    // re-evaluates when the OS theme flips (matchMedia itself is not reactive).
    void systemRevision.value
    if (theme.value !== 'system') return theme.value
    if (typeof window.matchMedia !== 'function') return 'light'
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  function setFollowSystemAccent(v: boolean): void {
    followSystemAccent.value = v
    persist()
    // Ask the OS straight away: the user switched this on to see the accent
    // change, and waiting for the next launch would look broken.
    if (v) void refreshSystemAccent()
  }

  /** Reads the OS accent colour into `systemAccent`. `effectiveAccent()` stays
   *  synchronous (the app shell reads it from a computed), so the answer is
   *  cached here; called when the option is switched on, and at startup when it
   *  is already on. A failed read is not an error state: it means the accent
   *  falls back to the theme, which `systemAccentState` lets the UI say. */
  async function refreshSystemAccent(): Promise<void> {
    let rgb: Rgb | null = null
    try {
      rgb = await readSystemAccentColor()
    } catch {
      // The adapter answers `null` for every failure it knows about, so a throw
      // here is a defect in it - but the call is fire-and-forget, and an
      // unhandled rejection would be worse than the honest 'unavailable'.
      rgb = null
    }
    systemAccent.value = rgb ? { r: rgb.r, g: rgb.g, b: rgb.b } : null
    systemAccentState.value = rgb ? 'read' : 'unavailable'
  }

  function setRenderTaskChecklist(v: boolean): void {
    renderTaskChecklist.value = v
    persist()
  }

  function setAutoSyncScroll(v: boolean): void {
    autoSyncScroll.value = v
    persist()
  }

  function setConfirmBeforeDelete(v: boolean): void {
    confirmBeforeDelete.value = v
    persist()
  }

  function setHighContrast(v: boolean): void {
    highContrast.value = v
    persist()
  }

  function setContentDirection(d: ContentDirection): void {
    contentDirection.value = d
    persist()
  }

  /** The accent actually applied. With "follow system accent" on, the user's own
   *  pick is ignored and the accent is the palette entry closest to the colour
   *  the OS reports (Windows; read through the backend). When no colour could be
   *  read the accent follows the effective light/dark theme instead - the same
   *  behaviour as before that read existed, and what the settings note explains. */
  function effectiveAccent(): Accent {
    if (!followSystemAccent.value) return accent.value
    if (systemAccent.value) return accentFromSystemColor(systemAccent.value)
    return effectiveTheme() === 'dark' ? 'violet' : 'coral'
  }

  function setTheme(t: Theme): void {
    theme.value = t
    persist()
  }

  function setColorScheme(c: ColorScheme): void {
    colorScheme.value = c
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

  // The option survives restarts, so the colour it depends on has to be read
  // again on this one: reading it only on toggle would leave a restarted app
  // sitting on the theme fallback while the checkbox says otherwise.
  if (followSystemAccent.value) void refreshSystemAccent()

  return {
    theme,
    colorScheme,
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
    followSystemAccent,
    renderTaskChecklist,
    autoSyncScroll,
    confirmBeforeDelete,
    highContrast,
    contentDirection,
    systemRevision,
    systemAccent,
    systemAccentState,
    effectiveTheme,
    effectiveAccent,
    refreshSystemAccent,
    setTheme,
    setColorScheme,
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
    setFollowSystemAccent,
    setRenderTaskChecklist,
    setAutoSyncScroll,
    setConfirmBeforeDelete,
    setHighContrast,
    setContentDirection,
    touchSystem,
    uiFontFamily,
    editorFontFamily,
    monoFontFamily,
  }
})














