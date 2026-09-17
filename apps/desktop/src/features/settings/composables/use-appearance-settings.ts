import { computed, type ComputedRef } from 'vue'
import { t } from '../../../i18n'
import {
  ACCENTS,
  ACCENT_COLORS,
  COLOR_SCHEMES,
  COLOR_SCHEME_PREVIEW,
} from '../../../stores/appearance-palette'
import type { Accent, ColorScheme, ColorSchemePreview } from '../../../stores/appearance-palette'
import {
  APPEARANCE_DEFAULTS,
  BODY_FONT_SIZE_MAX,
  BODY_FONT_SIZE_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
} from '../../../stores/appearance-schema'
import type { ContentDirection, Theme } from '../../../stores/appearance-schema'
import {
  EDITOR_FONT_IDS,
  MONO_FONT_IDS,
  UI_FONT_IDS,
} from '../../../stores/appearance-fonts'
import type { EditorFontId, MonoFontId, UiFontId } from '../../../stores/appearance-fonts'
import { useAppearanceStore } from '../../../stores/appearance'

/**
 * The three numbers a bounded number field needs: its two ends, and what an emptied one means.
 *
 * The ends come from `appearance-schema.ts`, which owns "the bounds its numbers are held to", and
 * the empty value is the schema's own default for that setting — so a control cannot offer a range
 * or a fallback the store would answer differently.
 */
export interface NumberField {
  min: number
  max: number
  /** What an emptied field means. Not a range end and not a step: the field's own widget rule,
   *  answered with the store's fallback for a value that is not a number, so clearing a field lands
   *  where `clampBodyFontSize` / `clampLineHeight` would put it rather than on a number spelled
   *  here. */
  empty: number
}

export interface AppearanceSettingsModel {
  theme: ComputedRef<Theme>
  setTheme: (theme: Theme) => void
  colorSchemes: ColorScheme[]
  colorScheme: ComputedRef<ColorScheme>
  setColorScheme: (s: ColorScheme) => void
  colorSchemePreview: (s: ColorScheme) => ColorSchemePreview['light']
  accents: Accent[]
  accentColors: Record<Accent, string>
  accent: ComputedRef<Accent>
  setAccent: (a: Accent) => void
  followSystemAccent: ComputedRef<boolean>
  setFollowSystemAccent: (on: boolean) => void
  /** Which of the two things actually happened when the OS accent was read. */
  followAccentNote: ComputedRef<string>
  uiFontOptions: readonly UiFontId[]
  editorFontOptions: readonly EditorFontId[]
  monoFontOptions: readonly MonoFontId[]
  uiFont: ComputedRef<UiFontId>
  editorFont: ComputedRef<EditorFontId>
  monoFont: ComputedRef<MonoFontId>
  setUiFont: (f: UiFontId) => void
  setEditorFont: (f: EditorFontId) => void
  setMonoFont: (f: MonoFontId) => void
  bodyFontSize: ComputedRef<number>
  lineHeight: ComputedRef<number>
  /** The typography fields' own bounds, so the section renders a control whose ends are the range
   *  the store holds the value to instead of a second copy of it. */
  bodyFontSizeField: NumberField
  lineHeightField: NumberField
  setBodyFontSize: (n: number) => void
  setLineHeight: (n: number) => void
  highContrast: ComputedRef<boolean>
  setHighContrast: (on: boolean) => void
  contentDirection: ComputedRef<ContentDirection>
  setContentDirection: (d: ContentDirection) => void
  focusMode: ComputedRef<boolean>
  setFocusMode: (on: boolean) => void
}

// The lists are the canonical ones, not a second copy of them. They used to be
// written out again here, which is how a picker ends up offering fewer fonts
// than the store knows about without anything failing: adding an id to
// `appearance-fonts.ts` would have left it unselectable here, silently.
const UI_FONT_OPTIONS: readonly UiFontId[] = UI_FONT_IDS
const EDITOR_FONT_OPTIONS: readonly EditorFontId[] = EDITOR_FONT_IDS
const MONO_FONT_OPTIONS: readonly MonoFontId[] = MONO_FONT_IDS

/**
 * The two typography fields' bounds, declared the same way and for the same reason as the three
 * option lists above: they are the store's numbers, not a copy of them.
 *
 * The template used to write this range a third time — `min="12" max="20"` and a
 * `Math.min(20, Math.max(12, …))` around the value — so widening `BODY_FONT_SIZE_MAX` in the schema
 * would have left the control offering the old ceiling while `setBodyFontSize` accepted the new one.
 * Today the two cannot disagree, and this is what keeps that true when one of them moves.
 */
const BODY_FONT_SIZE_FIELD: NumberField = {
  min: BODY_FONT_SIZE_MIN,
  max: BODY_FONT_SIZE_MAX,
  empty: APPEARANCE_DEFAULTS.bodyFontSize,
}
const LINE_HEIGHT_FIELD: NumberField = {
  min: LINE_HEIGHT_MIN,
  max: LINE_HEIGHT_MAX,
  empty: APPEARANCE_DEFAULTS.lineHeight,
}

/**
 * State and commands for the Appearance section: theme, colour scheme, accent,
 * typography, direction and the reading-mode toggle.
 *
 * The palette constants are re-exported here so the section component renders
 * the swatches without importing the store module at all (§13.11).
 */
export function useAppearanceSettings(): AppearanceSettingsModel {
  const appearance = useAppearanceStore()

  function colorSchemePreview(s: ColorScheme): ColorSchemePreview['light'] {
    const mode = appearance.effectiveTheme() === 'dark' ? 'dark' : 'light'
    return COLOR_SCHEME_PREVIEW[s][mode]
  }

  /** The note under the accent checkbox has to say which of the two things
   *  actually happened: the OS colour was read and mapped onto the palette, or it
   *  could not be read and the accent is the theme-based pick. Claiming the system
   *  colour was applied when it was not is the lie this replaces. */
  const followAccentNote = computed(() => {
    if (appearance.systemAccentState === 'read') return t('settings.appearance.followAccentHintRead')
    if (appearance.systemAccentState === 'unavailable') return t('settings.appearance.followAccentHintUnavailable')
    return t('settings.appearance.followAccentHint')
  })

  return {
    theme: computed(() => appearance.theme),
    setTheme: appearance.setTheme,
    colorSchemes: COLOR_SCHEMES,
    colorScheme: computed(() => appearance.colorScheme),
    setColorScheme: appearance.setColorScheme,
    colorSchemePreview,
    accents: ACCENTS,
    accentColors: ACCENT_COLORS,
    accent: computed(() => appearance.accent),
    setAccent: appearance.setAccent,
    followSystemAccent: computed(() => appearance.followSystemAccent),
    setFollowSystemAccent: appearance.setFollowSystemAccent,
    followAccentNote,
    uiFontOptions: UI_FONT_OPTIONS,
    editorFontOptions: EDITOR_FONT_OPTIONS,
    monoFontOptions: MONO_FONT_OPTIONS,
    uiFont: computed(() => appearance.uiFont),
    editorFont: computed(() => appearance.editorFont),
    monoFont: computed(() => appearance.monoFont),
    setUiFont: appearance.setUiFont,
    setEditorFont: appearance.setEditorFont,
    setMonoFont: appearance.setMonoFont,
    bodyFontSize: computed(() => appearance.bodyFontSize),
    lineHeight: computed(() => appearance.lineHeight),
    bodyFontSizeField: BODY_FONT_SIZE_FIELD,
    lineHeightField: LINE_HEIGHT_FIELD,
    setBodyFontSize: appearance.setBodyFontSize,
    setLineHeight: appearance.setLineHeight,
    highContrast: computed(() => appearance.highContrast),
    setHighContrast: appearance.setHighContrast,
    contentDirection: computed(() => appearance.contentDirection),
    setContentDirection: appearance.setContentDirection,
    focusMode: computed(() => appearance.focusMode),
    setFocusMode: appearance.setFocusMode,
  }
}
