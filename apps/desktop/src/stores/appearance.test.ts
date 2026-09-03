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

  it('defaults sidebarWidth to 232 and clamps into [180, 400]', () => {
    const s = useAppearanceStore()
    expect(s.sidebarWidth).toBe(232)
    s.setSidebarWidth(100)
    expect(s.sidebarWidth).toBe(180)
    s.setSidebarWidth(999)
    expect(s.sidebarWidth).toBe(400)
    s.setSidebarWidth(280.7)
    expect(s.sidebarWidth).toBe(281)
  })

  it('defaults railWidth to 300 and clamps into [240, 480]', () => {
    const s = useAppearanceStore()
    expect(s.railWidth).toBe(300)
    s.setRailWidth(100)
    expect(s.railWidth).toBe(240)
    s.setRailWidth(999)
    expect(s.railWidth).toBe(480)
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
})
