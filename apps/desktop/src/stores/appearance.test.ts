import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { computed } from 'vue'
import { useAppearanceStore } from './appearance'

// happy-dom 无 matchMedia，stub
const matchMediaMock = vi.fn(() => ({
  matches: false, media: '(prefers-color-scheme: dark)',
  onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
}))

describe('useAppearanceStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    matchMediaMock.mockReturnValue({ ...matchMediaMock(), matches: false })
    globalThis.matchMedia = matchMediaMock as never
  })

  it('defaults to system theme and ink accent', () => {
    const s = useAppearanceStore()
    expect(s.theme).toBe('system')
    expect(s.accent).toBe('ink')
    expect(s.effectiveTheme()).toBe('light') // matches=false
  })

  it('persists theme and accent to localStorage', () => {
    const s = useAppearanceStore()
    s.setTheme('dark')
    s.setAccent('coral')
    const saved = JSON.parse(localStorage.getItem('nekowite.appearance') ?? '{}')
    expect(saved.theme).toBe('dark')
    expect(saved.accent).toBe('coral')
  })

  it('restores from localStorage on next load', () => {
    localStorage.setItem('nekowite.appearance', JSON.stringify({ theme: 'dark', accent: 'blue' }))
    const s = useAppearanceStore()
    expect(s.theme).toBe('dark')
    expect(s.accent).toBe('blue')
  })

  it('effectiveTheme follows dark media query when system', () => {
    matchMediaMock.mockReturnValue({ ...matchMediaMock(), matches: true })
    const s = useAppearanceStore()
    expect(s.effectiveTheme()).toBe('dark')
  })

  it('effectiveTheme is reactive to touchSystem (OS theme flip)', () => {
    const s = useAppearanceStore()
    const effective = computed(() => s.effectiveTheme())
    expect(effective.value).toBe('light')
    matchMediaMock.mockReturnValue({ ...matchMediaMock(), matches: true })
    s.touchSystem()
    expect(effective.value).toBe('dark')
  })

  it('clamps bodyFontSize into [12, 20]', () => {
    const s = useAppearanceStore()
    s.setBodyFontSize(0)
    expect(s.bodyFontSize).toBe(12)
    s.setBodyFontSize(99)
    expect(s.bodyFontSize).toBe(20)
    s.setBodyFontSize(14.5)
    expect(s.bodyFontSize).toBe(14.5)
  })

  it('clamps lineHeight into [1.2, 2.4]', () => {
    const s = useAppearanceStore()
    s.setLineHeight(0)
    expect(s.lineHeight).toBe(1.2)
    s.setLineHeight(9)
    expect(s.lineHeight).toBe(2.4)
    s.setLineHeight(1.6)
    expect(s.lineHeight).toBe(1.6)
  })

  it('defaults sidebarWidth to 232 and clamps into [160, 520]', () => {
    const s = useAppearanceStore()
    expect(s.sidebarWidth).toBe(232)
    s.setSidebarWidth(100)
    expect(s.sidebarWidth).toBe(160)
    s.setSidebarWidth(999)
    expect(s.sidebarWidth).toBe(520)
    s.setSidebarWidth(280.7)
    expect(s.sidebarWidth).toBe(281)
  })

  it('defaults railWidth to 300 and clamps into [220, 640]', () => {
    const s = useAppearanceStore()
    expect(s.railWidth).toBe(300)
    s.setRailWidth(100)
    expect(s.railWidth).toBe(220)
    s.setRailWidth(999)
    expect(s.railWidth).toBe(640)
  })

  it('defaults notelistWidth to 280 and clamps into [200, 520]', () => {
    const s = useAppearanceStore()
    expect(s.notelistWidth).toBe(280)
    s.setNotelistWidth(50)
    expect(s.notelistWidth).toBe(200)
    s.setNotelistWidth(999)
    expect(s.notelistWidth).toBe(520)
  })

  it('persists and restores layout widths', () => {
    const s = useAppearanceStore()
    s.setSidebarWidth(320)
    s.setRailWidth(420)
    const saved = JSON.parse(localStorage.getItem('nekowite.appearance') ?? '{}')
    expect(saved.sidebarWidth).toBe(320)
    expect(saved.railWidth).toBe(420)

    localStorage.setItem('nekowite.appearance', JSON.stringify({ sidebarWidth: 360, railWidth: 260 }))
    setActivePinia(createPinia())
    const restored = useAppearanceStore()
    expect(restored.sidebarWidth).toBe(360)
    expect(restored.railWidth).toBe(260)
  })

  it('falls back to defaults for corrupt layout widths', () => {
    localStorage.setItem('nekowite.appearance', JSON.stringify({ sidebarWidth: 'wide', railWidth: null }))
    const s = useAppearanceStore()
    expect(s.sidebarWidth).toBe(232)
    expect(s.railWidth).toBe(300)
  })

  it('defaults all fonts to the system/mono presets', () => {
    const s = useAppearanceStore()
    expect(s.uiFont).toBe('system')
    expect(s.editorFont).toBe('system')
    expect(s.monoFont).toBe('mono')
    expect(typeof s.uiFontFamily()).toBe('string')
    expect(typeof s.editorFontFamily()).toBe('string')
    expect(typeof s.monoFontFamily()).toBe('string')
    expect(s.uiFontFamily()).toContain('Inter')
  })

  it('persists and restores font selections', () => {
    const s = useAppearanceStore()
    s.setUiFont('serif')
    s.setEditorFont('reading')
    s.setMonoFont('jetbrains')
    const saved = JSON.parse(localStorage.getItem('nekowite.appearance') ?? '{}')
    expect(saved.uiFont).toBe('serif')
    expect(saved.editorFont).toBe('reading')
    expect(saved.monoFont).toBe('jetbrains')

    localStorage.setItem('nekowite.appearance', JSON.stringify({ uiFont: 'rounded', editorFont: 'sans', monoFont: 'cascadia' }))
    setActivePinia(createPinia())
    const restored = useAppearanceStore()
    expect(restored.uiFont).toBe('rounded')
    expect(restored.editorFont).toBe('sans')
    expect(restored.monoFont).toBe('cascadia')
    expect(restored.monoFontFamily()).toContain('Cascadia')
  })

  it('falls back to defaults for unknown font ids', () => {
    localStorage.setItem('nekowite.appearance', JSON.stringify({ uiFont: 'comic', editorFont: 'times', monoFont: 'futura' }))
    const s = useAppearanceStore()
    expect(s.uiFont).toBe('system')
    expect(s.editorFont).toBe('system')
    expect(s.monoFont).toBe('mono')
  })

  it('restores an extended accent and falls back for unknown accents', () => {
    localStorage.setItem('nekowite.appearance', JSON.stringify({ accent: 'teal' }))
    setActivePinia(createPinia())
    const restored = useAppearanceStore()
    expect(restored.accent).toBe('teal')

    localStorage.setItem('nekowite.appearance', JSON.stringify({ accent: 'neon' }))
    setActivePinia(createPinia())
    const invalid = useAppearanceStore()
    expect(invalid.accent).toBe('ink')
  })

  it('defaults editor behavior flags and disables the word goal', () => {
    const s = useAppearanceStore()
    expect(s.focusMode).toBe(false)
    expect(s.wordGoal).toBe(0)
    expect(s.spellCheckEnabled).toBe(true)
    expect(s.softWrap).toBe(true)
    expect(s.lineNumbers).toBe(true)
    expect(s.autosaveOnBlur).toBe(true)
    expect(s.statusBarWords).toBe(true)
    expect(s.followSystemAccent).toBe(false)
    expect(s.renderTaskChecklist).toBe(true)
    expect(s.autoSyncScroll).toBe(true)
    expect(s.confirmBeforeDelete).toBe(true)
  })

  it('persists and restores editor behavior flags', () => {
    const s = useAppearanceStore()
    s.setFocusMode(true)
    s.setWordGoal(1200)
    s.setSpellCheckEnabled(false)
    s.setSoftWrap(false)
    s.setLineNumbers(false)
    s.setAutosaveOnBlur(false)
    s.setStatusBarWords(false)
    s.setFollowSystemAccent(true)
    s.setRenderTaskChecklist(false)
    s.setAutoSyncScroll(false)
    s.setConfirmBeforeDelete(false)
    const saved = JSON.parse(localStorage.getItem('nekowite.appearance') ?? '{}')
    expect(saved.focusMode).toBe(true)
    expect(saved.wordGoal).toBe(1200)
    expect(saved.spellCheckEnabled).toBe(false)
    expect(saved.softWrap).toBe(false)
    expect(saved.lineNumbers).toBe(false)
    expect(saved.autosaveOnBlur).toBe(false)
    expect(saved.statusBarWords).toBe(false)
    expect(saved.followSystemAccent).toBe(true)
    expect(saved.renderTaskChecklist).toBe(false)
    expect(saved.autoSyncScroll).toBe(false)
    expect(saved.confirmBeforeDelete).toBe(false)

    localStorage.setItem('nekowite.appearance', JSON.stringify({
      focusMode: true,
      wordGoal: 500,
      spellCheckEnabled: false,
      softWrap: false,
      lineNumbers: false,
      autosaveOnBlur: false,
      statusBarWords: false,
      followSystemAccent: true,
      renderTaskChecklist: false,
      autoSyncScroll: false,
      confirmBeforeDelete: false,
    }))
    setActivePinia(createPinia())
    const restored = useAppearanceStore()
    expect(restored.focusMode).toBe(true)
    expect(restored.wordGoal).toBe(500)
    expect(restored.spellCheckEnabled).toBe(false)
    expect(restored.softWrap).toBe(false)
    expect(restored.lineNumbers).toBe(false)
    expect(restored.autosaveOnBlur).toBe(false)
    expect(restored.statusBarWords).toBe(false)
    expect(restored.followSystemAccent).toBe(true)
    expect(restored.renderTaskChecklist).toBe(false)
    expect(restored.autoSyncScroll).toBe(false)
    expect(restored.confirmBeforeDelete).toBe(false)
  })

  it('falls back to defaults for old (missing-field) and invalid localStorage', () => {
    localStorage.setItem('nekowite.appearance', JSON.stringify({ theme: 'dark' }))
    setActivePinia(createPinia())
    const s = useAppearanceStore()
    expect(s.focusMode).toBe(false)
    expect(s.wordGoal).toBe(0)
    expect(s.spellCheckEnabled).toBe(true)
    expect(s.softWrap).toBe(true)
    expect(s.lineNumbers).toBe(true)
    expect(s.autosaveOnBlur).toBe(true)
    expect(s.statusBarWords).toBe(true)
    expect(s.followSystemAccent).toBe(false)
    expect(s.renderTaskChecklist).toBe(true)
    expect(s.autoSyncScroll).toBe(true)
    expect(s.confirmBeforeDelete).toBe(true)

    localStorage.setItem('nekowite.appearance', JSON.stringify({
      focusMode: 'yes',
      wordGoal: 'many',
      spellCheckEnabled: 1,
      softWrap: null,
      lineNumbers: 'off',
      autosaveOnBlur: 0,
      statusBarWords: [],
      followSystemAccent: 'on',
      renderTaskChecklist: 0,
      autoSyncScroll: 'no',
      confirmBeforeDelete: [],
    }))
    setActivePinia(createPinia())
    const invalid = useAppearanceStore()
    expect(invalid.focusMode).toBe(false)
    expect(invalid.wordGoal).toBe(0)
    expect(invalid.spellCheckEnabled).toBe(true)
    expect(invalid.softWrap).toBe(true)
    expect(invalid.lineNumbers).toBe(true)
    expect(invalid.autosaveOnBlur).toBe(true)
    expect(invalid.statusBarWords).toBe(true)
    expect(invalid.followSystemAccent).toBe(false)
    expect(invalid.renderTaskChecklist).toBe(true)
    expect(invalid.autoSyncScroll).toBe(true)
    expect(invalid.confirmBeforeDelete).toBe(true)
  })

  it('clamps wordGoal into [0, 100000] and rounds', () => {
    const s = useAppearanceStore()
    s.setWordGoal(-10)
    expect(s.wordGoal).toBe(0)
    s.setWordGoal(999999)
    expect(s.wordGoal).toBe(100000)
    s.setWordGoal(1234.6)
    expect(s.wordGoal).toBe(1235)
    s.setWordGoal(0)
    expect(s.wordGoal).toBe(0)
  })

  it('effectiveAccent returns the user pick by default', () => {
    const s = useAppearanceStore()
    s.setAccent('blue')
    expect(s.effectiveAccent()).toBe('blue')
  })

  it('effectiveAccent follows light/dark when followSystemAccent is on', () => {
    const s = useAppearanceStore()
    s.setFollowSystemAccent(true)
    // Explicit light theme -> automatic light accent.
    s.setTheme('light')
    expect(s.effectiveAccent()).toBe('coral')
    // Explicit dark theme -> automatic dark accent.
    s.setTheme('dark')
    expect(s.effectiveAccent()).toBe('violet')
    // Theme kept even when the user changes the accent pick (system controls it).
    s.setAccent('teal')
    expect(s.effectiveAccent()).toBe('violet')
  })

  it('persists followSystemAccent and restores it', () => {
    const s = useAppearanceStore()
    s.setFollowSystemAccent(true)
    const saved = JSON.parse(localStorage.getItem('nekowite.appearance') ?? '{}')
    expect(saved.followSystemAccent).toBe(true)

    localStorage.setItem('nekowite.appearance', JSON.stringify({ followSystemAccent: true, theme: 'light' }))
    setActivePinia(createPinia())
    const restored = useAppearanceStore()
    expect(restored.followSystemAccent).toBe(true)
    expect(restored.effectiveAccent()).toBe('coral')
  })

  it('defaults high contrast off and content direction to auto', () => {
    const s = useAppearanceStore()
    expect(s.highContrast).toBe(false)
    expect(s.contentDirection).toBe('auto')
  })

  it('persists and restores high contrast and content direction', () => {
    const s = useAppearanceStore()
    s.setHighContrast(true)
    s.setContentDirection('rtl')
    const saved = JSON.parse(localStorage.getItem('nekowite.appearance') ?? '{}')
    expect(saved.highContrast).toBe(true)
    expect(saved.contentDirection).toBe('rtl')

    localStorage.setItem('nekowite.appearance', JSON.stringify({ highContrast: false, contentDirection: 'ltr' }))
    setActivePinia(createPinia())
    const restored = useAppearanceStore()
    expect(restored.highContrast).toBe(false)
    expect(restored.contentDirection).toBe('ltr')
  })

  it('falls back to defaults for invalid content direction and non-boolean high contrast', () => {
    localStorage.setItem('nekowite.appearance', JSON.stringify({ contentDirection: 'sideways', highContrast: 'on' }))
    setActivePinia(createPinia())
    const invalid = useAppearanceStore()
    expect(invalid.contentDirection).toBe('auto')
    expect(invalid.highContrast).toBe(false)
  })
})
