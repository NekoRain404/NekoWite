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
})
