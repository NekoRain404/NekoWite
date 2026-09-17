import { computed, type ComputedRef } from 'vue'
import { t } from '../../../i18n'
import {
  ACCENTS,
  ACCENT_COLORS,
  COLOR_SCHEMES,
  COLOR_SCHEME_PREVIEW,
} from '../../../stores/appearance-palette'
import type { Accent, ColorScheme, ColorSchemePreview } from '../../../stores/appearance-palette'
import type { ContentDirection, Theme } from '../../../stores/appearance-schema'
import {
  EDITOR_FONT_IDS,
  MONO_FONT_IDS,
  UI_FONT_IDS,
} from '../../../stores/appearance-fonts'
import type { EditorFontId, MonoFontId, UiFontId } from '../../../stores/appearance-fonts'
import { useAppearanceStore } from '../../../stores/appearance'

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
