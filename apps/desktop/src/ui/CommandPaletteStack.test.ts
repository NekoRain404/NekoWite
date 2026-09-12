import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: vi.fn().mockResolvedValue(''),
    write: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    searchNotes: vi.fn().mockResolvedValue([]),
    watch: vi.fn(),
    stat: vi.fn(),
    onFsChange: vi.fn().mockResolvedValue(() => undefined),
    listHistory: vi.fn().mockResolvedValue([]),
    listTrash: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('../services/vaultFiles', () => ({
  vaultFileIndex: { invalidate: vi.fn(), files: vi.fn(() => []) },
}))

vi.mock('../services/runEditorCommand', () => ({ runEditorCommand: vi.fn(() => true) }))

import SettingsPanel from './SettingsPanel.vue'
import CommandPalette from './CommandPalette.vue'
import { modalStack } from '../services/modalStack'
import { setLocale } from '../i18n'

let pinia: Pinia
let mounted: VueApp[] = []

function mountComponent(component: unknown, props: Record<string, unknown> = {}): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(component as never, props as never)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
}

function pressKey(key: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
}

function pressCtrlK(): void {
  pressKey('k', { ctrlKey: true })
}

function overlay(): Element | null {
  return document.body.querySelector('.palette-overlay')
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function settleFocus(): Promise<void> {
  await nextTick()
  await settle(0)
  await nextTick()
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  localStorage.clear()
  setLocale('zh')
  modalStack.resetModalStack()
  globalThis.matchMedia = vi.fn(() => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as never
  document.body.innerHTML = ''
  mounted = []
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  modalStack.resetModalStack()
  document.body.innerHTML = ''
})

describe('modal stacking', () => {
  it('Escape with only the settings open closes the settings', async () => {
    const close = vi.fn()
    mountComponent(SettingsPanel, { onClose: close, onSaved: vi.fn() })
    await settleFocus()

    pressKey('Escape')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+K raises the palette over an open settings dialog', async () => {
    // The palette is a command launcher: it deliberately goes on top of the
    // settings panel (both sit at z-index 10000). What must not happen is the
    // *Escape* below closing both at once.
    mountComponent(SettingsPanel, { onClose: vi.fn(), onSaved: vi.fn() })
    mountComponent(CommandPalette)
    await settleFocus()

    pressCtrlK()
    await nextTick()
    expect(overlay()).not.toBeNull()
  })

  it('Escape opens and closes one dialog at a time', async () => {
    const closeSettings = vi.fn()
    mountComponent(SettingsPanel, { onClose: closeSettings, onSaved: vi.fn() })
    mountComponent(CommandPalette)
    await settleFocus()

    // Settings is the only modal: Escape reaches it and only it.
    pressKey('Escape')
    expect(closeSettings).toHaveBeenCalledTimes(1)

    // Raise the palette on top. Escape must now close the palette alone —
    // before the stack existed, one press closed both because two window
    // keydown listeners cannot cancel each other.
    pressCtrlK()
    await nextTick()
    expect(overlay()).not.toBeNull()
    pressKey('Escape')
    await nextTick()
    expect(closeSettings).toHaveBeenCalledTimes(1)
    await settle(250)
    expect(overlay()).toBeNull()
  })

  it('keeps repeated Tab presses inside the palette', async () => {
    mountComponent(CommandPalette)
    pressCtrlK()
    await nextTick()

    const dialog = document.body.querySelector<HTMLElement>('.palette')!
    for (let i = 0; i < 40; i++) {
      const before = document.activeElement as HTMLElement | null
      const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      before?.dispatchEvent(ev)
      await settleFocus()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })
})
