/**
 * The appearance store.
 *
 * This file owns the reactive settings state and the setters that write it. The
 * decisions behind them live in modules under stores/:
 *
 *   appearance-schema.ts         the persisted document: shape, defaults,
 *                                bounds, validation, storage key
 *   appearance-palette.ts        accents, colour schemes, and the nearest-colour
 *                                search over them (pure)
 *   appearance-fonts.ts          the font presets and family lookups (pure)
 *   appearance-system-accent.ts  the OS accent read and its cached state
 *
 * The wiring below is also the module graph: the store depends on all four, and
 * none of them depends on the store, so each is testable on its own.
 *
 * The public API is unchanged - every consumer keeps importing
 * `useAppearanceStore` plus the palette/schema constants. Those are re-exported
 * at the bottom of this file while callers migrate (§10.1.5); the re-exports go
 * away in the naming stage.
 */

import { ref } from 'vue'
import { defineStore } from 'pinia'
import { readSystemAccentColor } from '../platform/system-accent'
import { createSystemAccentReader } from './appearance-system-accent'
import {
  APPEARANCE_DEFAULTS,
  clampInt,
  NOTELIST_WIDTH_MAX,
  NOTELIST_WIDTH_MIN,
  RAIL_WIDTH_MAX,
  RAIL_WIDTH_MIN,
  readStoredAppearance,
  saveStoredAppearance,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  WORD_GOAL_MAX,
} from './appearance-schema'
import type { ContentDirection, Theme } from './appearance-schema'
import {
  editorFontFamily as resolveEditorFontFamily,
  monoFontFamily as resolveMonoFontFamily,
  uiFontFamily as resolveUiFontFamily,
} from './appearance-fonts'
import type { EditorFontId, MonoFontId, UiFontId } from './appearance-fonts'
import { accentFromSystemColor, themeFallbackAccent } from './appearance-palette'
import {
  ACCENTS,
  ACCENT_COLORS,
  COLOR_SCHEMES,
  COLOR_SCHEME_PREVIEW,
} from './appearance-palette'
import type { Accent, ColorScheme, ColorSchemePreview, Rgb } from './appearance-palette'
import type { SystemAccentState } from './appearance-system-accent'

export const useAppearanceStore = defineStore('appearance', () => {
  const stored = readStoredAppearance()
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
  const { accent: systemAccent, state: systemAccentState, refresh: refreshSystemAccent } =
    createSystemAccentReader({ read: readSystemAccentColor })

  function persist(): void {
    saveStoredAppearance({
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
    return themeFallbackAccent(effectiveTheme())
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
    bodyFontSize.value = Math.min(20, Math.max(12, Number.isFinite(n) ? n : APPEARANCE_DEFAULTS.bodyFontSize))
    persist()
  }

  function setLineHeight(n: number): void {
    lineHeight.value = Math.min(2.4, Math.max(1.2, Number.isFinite(n) ? n : APPEARANCE_DEFAULTS.lineHeight))
    persist()
  }

  function setSidebarWidth(n: number): void {
    sidebarWidth.value = clampInt(n, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX, APPEARANCE_DEFAULTS.sidebarWidth)
    persist()
  }

  function setRailWidth(n: number): void {
    railWidth.value = clampInt(n, RAIL_WIDTH_MIN, RAIL_WIDTH_MAX, APPEARANCE_DEFAULTS.railWidth)
    persist()
  }

  function setNotelistWidth(n: number): void {
    notelistWidth.value = clampInt(n, NOTELIST_WIDTH_MIN, NOTELIST_WIDTH_MAX, APPEARANCE_DEFAULTS.notelistWidth)
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
    wordGoal.value = clampInt(n, 0, WORD_GOAL_MAX, APPEARANCE_DEFAULTS.wordGoal)
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

  // The public methods keep their names; the lookups themselves are pure and
  // take the id, so the preset tables stay the single place a family is defined.
  function uiFontFamily(): string {
    return resolveUiFontFamily(uiFont.value)
  }

  function editorFontFamily(): string {
    return resolveEditorFontFamily(editorFont.value)
  }

  function monoFontFamily(): string {
    return resolveMonoFontFamily(monoFont.value)
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

// Compatibility surface: every name this module exported before the split is
// still exported here, so no consumer changes while they migrate (§10.1.5).
export {
  ACCENTS,
  ACCENT_COLORS,
  COLOR_SCHEMES,
  COLOR_SCHEME_PREVIEW,
  accentFromSystemColor,
}
export type { Accent, ColorScheme, ColorSchemePreview, Rgb, SystemAccentState }
export { EDITOR_FONTS, MONO_FONTS, UI_FONTS } from './appearance-fonts'
export type { EditorFontId, MonoFontId, UiFontId }
export {
  NOTELIST_WIDTH_DEFAULT,
  NOTELIST_WIDTH_MAX,
  NOTELIST_WIDTH_MIN,
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MAX,
  RAIL_WIDTH_MIN,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  WORD_GOAL_MAX,
} from './appearance-schema'
export type { ContentDirection, Theme } from './appearance-schema'
