/**
 * The persisted appearance document: its shape, its defaults, the bounds its
 * numbers are held to, and the validation that turns a stored blob back into
 * settings.
 *
 * This module owns the storage key and the schema version, so the store never
 * repeats them. Reading is total: a missing, corrupt or older blob resolves to
 * the defaults rather than throwing, because appearance is loaded while the
 * window is still coming up and a bad value must not be able to stop that.
 */

import { createDomainPersister, persistence } from '../services/persistence'
import { ACCENTS, COLOR_SCHEMES } from './appearance-palette'
import type { Accent, ColorScheme } from './appearance-palette'
import { EDITOR_FONT_IDS, MONO_FONT_IDS, UI_FONT_IDS } from './appearance-fonts'
import type { EditorFontId, MonoFontId, UiFontId } from './appearance-fonts'

export type Theme = 'light' | 'dark' | 'system'
export type ContentDirection = 'auto' | 'ltr' | 'rtl'

export const SIDEBAR_WIDTH_MIN = 160
export const SIDEBAR_WIDTH_MAX = 520
export const SIDEBAR_WIDTH_DEFAULT = 232
export const RAIL_WIDTH_MIN = 220
export const RAIL_WIDTH_MAX = 640
export const RAIL_WIDTH_DEFAULT = 300
export const NOTELIST_WIDTH_MIN = 200
export const NOTELIST_WIDTH_MAX = 520
export const NOTELIST_WIDTH_DEFAULT = 280

export const WORD_GOAL_MAX = 100000

/**
 * The range the body size is held to, declared once because **two doors read this setting**: the
 * Appearance control that sets it, and the stored blob read while the window is still coming up.
 *
 * The bounds belong to this module rather than to either door — it is the module that owns "the
 * bounds its numbers are held to" — and a bound written at one door only is a second answer to one
 * question. It was: `parseStored` accepted whatever the blob said while the control clamped to
 * 12..20, so a hand-edited or corrupted `99` was drawn by the app's own shell at 99px while the pet
 * window, applying this range to the size the app publishes, drew 20. One setting, two sizes, two
 * windows.
 */
export const BODY_FONT_SIZE_MIN = 12
export const BODY_FONT_SIZE_MAX = 20

/**
 * The range the leading is held to, declared here for the reason the body size's is: **two doors
 * read this setting** — the Appearance control and the stored blob — and a bound written at one door
 * only is a second answer to one question.
 *
 * It was one: `parseStored` did `parsed.lineHeight ?? default` while `setLineHeight` clamped to
 * 1.2..2.4, so a hand-edited or corrupted `9` was read as 9 and written to `--app-line-height` by the
 * app's own shell (`AppShell.vue:276` → `style.css:3`), which is the identical defect
 * `BODY_FONT_SIZE_MIN` was added for one setting above. The range is a **bound and not a step**, and
 * the fraction is the point: the control is `step="0.1"`, so `setLineHeight(1.85)` is a leading the
 * store has always kept and `clampInt`'s rounding is not this setting's rule.
 */
export const LINE_HEIGHT_MIN = 1.2
export const LINE_HEIGHT_MAX = 2.4

export interface AppearanceSettings {
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

/** The fresh-install values, and the fallback the setters clamp towards: a
 *  rejected value (NaN, a corrupt stored number) must land on the default this
 *  document declares, not on a second copy of it kept by the store. */
export const APPEARANCE_DEFAULTS: AppearanceSettings = {
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

const CONTENT_DIRECTIONS: ContentDirection[] = ['auto', 'ltr', 'rtl']

function pickFont<T extends string>(value: unknown, valid: T[], fallback: T): T {
  return typeof value === 'string' && (valid as string[]).includes(value) ? (value as T) : fallback
}

function readBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** The shared numeric guard for every bounded setting: a stored or set value
 *  that is not a finite number falls back to the default, and a finite one is
 *  rounded and clamped into range. */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.round(Math.min(max, Math.max(min, numeric)))
}

/** The body size a stored or set value is held to: a finite number clamped into range, and anything
 *  that is not a number at all is the schema's default — the same reading {@link clampInt} gives a
 *  bounded setting, minus the rounding.
 *
 *  Not `clampInt`: that one rounds, and the app's font sizes are the user's, so a fraction is a size
 *  the store has always kept (`setBodyFontSize(14.5)`); the range is a bound, not a step. Both doors
 *  call this — the control and {@link parseStored} — so the size a window draws and the size a blob
 *  is read back as are one rule applied twice rather than two rules that happen to agree today. */
export function clampBodyFontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return APPEARANCE_DEFAULTS.bodyFontSize
  }
  return Math.min(BODY_FONT_SIZE_MAX, Math.max(BODY_FONT_SIZE_MIN, value))
}

/** The leading a stored or set value is held to — {@link clampBodyFontSize}'s rule, applied to
 *  {@link LINE_HEIGHT_MIN}..{@link LINE_HEIGHT_MAX}. The same two readings: a finite number is
 *  clamped into range, and anything that is not a number at all is the schema's default.
 *
 *  Both doors call it, the control (`stores/appearance.ts`'s `setLineHeight`) and the stored blob, so
 *  the leading a window draws and the leading a blob is read back as are one rule applied twice
 *  rather than two rules that happened to agree about the numbers a user could reach. The pair it
 *  belongs to is the reason it is not `clampInt`: that one rounds, and a leading is a multiple —
 *  `setLineHeight(1.85)` is a value this store has always kept. */
export function clampLineHeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return APPEARANCE_DEFAULTS.lineHeight
  }
  return Math.min(LINE_HEIGHT_MAX, Math.max(LINE_HEIGHT_MIN, value))
}

/** Parse a stored appearance blob with field-by-field validation, returning null
 *  when it is corrupt (the domain persister then falls back to `defaults`). */
function parseStored(raw: string): AppearanceSettings | null {
  const parsed = JSON.parse(raw) as Partial<AppearanceSettings>
  return {
    theme:
      parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'system'
        ? parsed.theme
        : APPEARANCE_DEFAULTS.theme,
    accent: typeof parsed.accent === 'string' && ACCENTS.includes(parsed.accent as Accent)
      ? (parsed.accent as Accent)
      : APPEARANCE_DEFAULTS.accent,
    colorScheme: typeof parsed.colorScheme === 'string' && COLOR_SCHEMES.includes(parsed.colorScheme as ColorScheme)
      ? (parsed.colorScheme as ColorScheme)
      : APPEARANCE_DEFAULTS.colorScheme,
    bodyFontSize: clampBodyFontSize(parsed.bodyFontSize),
    lineHeight: clampLineHeight(parsed.lineHeight),
    sidebarWidth: clampInt(parsed.sidebarWidth ?? APPEARANCE_DEFAULTS.sidebarWidth, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX, APPEARANCE_DEFAULTS.sidebarWidth),
    railWidth: clampInt(parsed.railWidth ?? APPEARANCE_DEFAULTS.railWidth, RAIL_WIDTH_MIN, RAIL_WIDTH_MAX, APPEARANCE_DEFAULTS.railWidth),
    notelistWidth: clampInt(parsed.notelistWidth ?? APPEARANCE_DEFAULTS.notelistWidth, NOTELIST_WIDTH_MIN, NOTELIST_WIDTH_MAX, APPEARANCE_DEFAULTS.notelistWidth),
    uiFont: pickFont(parsed.uiFont, UI_FONT_IDS, APPEARANCE_DEFAULTS.uiFont),
    editorFont: pickFont(parsed.editorFont, EDITOR_FONT_IDS, APPEARANCE_DEFAULTS.editorFont),
    monoFont: pickFont(parsed.monoFont, MONO_FONT_IDS, APPEARANCE_DEFAULTS.monoFont),
    focusMode: readBool(parsed.focusMode, APPEARANCE_DEFAULTS.focusMode),
    wordGoal: clampInt(parsed.wordGoal ?? APPEARANCE_DEFAULTS.wordGoal, 0, WORD_GOAL_MAX, APPEARANCE_DEFAULTS.wordGoal),
    spellCheckEnabled: readBool(parsed.spellCheckEnabled, APPEARANCE_DEFAULTS.spellCheckEnabled),
    softWrap: readBool(parsed.softWrap, APPEARANCE_DEFAULTS.softWrap),
    lineNumbers: readBool(parsed.lineNumbers, APPEARANCE_DEFAULTS.lineNumbers),
    autosaveOnBlur: readBool(parsed.autosaveOnBlur, APPEARANCE_DEFAULTS.autosaveOnBlur),
    statusBarWords: readBool(parsed.statusBarWords, APPEARANCE_DEFAULTS.statusBarWords),
    followSystemAccent: readBool(parsed.followSystemAccent, APPEARANCE_DEFAULTS.followSystemAccent),
    renderTaskChecklist: readBool(parsed.renderTaskChecklist, APPEARANCE_DEFAULTS.renderTaskChecklist),
    autoSyncScroll: readBool(parsed.autoSyncScroll, APPEARANCE_DEFAULTS.autoSyncScroll),
    confirmBeforeDelete: readBool(parsed.confirmBeforeDelete, APPEARANCE_DEFAULTS.confirmBeforeDelete),
    highContrast: readBool(parsed.highContrast, APPEARANCE_DEFAULTS.highContrast),
    contentDirection:
      typeof parsed.contentDirection === 'string' &&
      (CONTENT_DIRECTIONS as string[]).includes(parsed.contentDirection)
        ? (parsed.contentDirection as ContentDirection)
        : APPEARANCE_DEFAULTS.contentDirection,
  }
}

/** Versioned appearance domain (schema `version: 1`). A corrupt/missing blob
 *  yields `defaults`; a future schema bump registers a `migrations` chain that
 *  runs on load before parsing. */
const appearanceDomain = createDomainPersister<AppearanceSettings>(persistence, {
  key: LS_KEY,
  version: 1,
  // A fresh object per load: the caller's settings must never alias the
  // defaults table, or one edited field would rewrite the defaults for the
  // whole session.
  defaults: () => ({ ...APPEARANCE_DEFAULTS }),
  parse: (raw) => {
    try {
      return parseStored(raw)
    } catch {
      return null
    }
  },
  serialize: (value) => JSON.stringify(value),
})

/** The stored settings, or the defaults when nothing valid was stored. */
export function readStoredAppearance(): AppearanceSettings {
  return appearanceDomain.load()
}

/** Write the settings; a storage that refuses (quota, unavailable webview) is
 *  swallowed by the domain persister, since losing a preference is not worth
 *  breaking the interaction that set it. */
export function saveStoredAppearance(value: AppearanceSettings): void {
  appearanceDomain.save(value)
}
