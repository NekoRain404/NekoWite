import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import TitleBar from './TitleBar.vue'

const controls = vi.hoisted(() => ({
  isMaximized: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  startDragging: vi.fn(),
  onResized: vi.fn(),
}))

vi.mock('../platform/window', () => ({
  getWindowControls: () => controls,
}))

function mount(): { host: HTMLElement; app: VueApp } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(TitleBar, {
    sidebarVisible: true,
    title: 'Test note',
    subtitle: 'subtitle',
  })
  app.mount(host)
  return { host, app }
}

describe('TitleBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    controls.isMaximized.mockResolvedValue(false)
    controls.minimize.mockResolvedValue(undefined)
    controls.toggleMaximize.mockResolvedValue(undefined)
    controls.close.mockResolvedValue(undefined)
    controls.startDragging.mockResolvedValue(undefined)
    controls.onResized.mockResolvedValue(() => {})
  })

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    document.body.innerHTML = ''
  })

  it('does not mark the whole UI as a native drag region', () => {
    const { host, app } = mount()
    try {
      expect(host.querySelector('[data-tauri-drag-region]')).toBeNull()
    } finally {
      app.unmount()
    }
  })

  it('starts a window drag only from the titlebar drag zone', async () => {
    const { host, app } = mount()
    try {
      const zone = host.querySelector('.tb-center')
      if (!zone) throw new Error('drag zone missing')
      zone.dispatchEvent(new MouseEvent('mousedown', { button: 0, detail: 1, bubbles: true }))
      expect(controls.startDragging).toHaveBeenCalledTimes(1)
    } finally {
      app.unmount()
    }
  })

  it('does not start a window drag from buttons or window controls', () => {
    const { host, app } = mount()
    try {
      const button = host.querySelector('.tb-btn')
      const close = host.querySelector('.tb-window-close')
      if (!button || !close) throw new Error('controls missing')
      button.dispatchEvent(new MouseEvent('mousedown', { button: 0, detail: 1, bubbles: true }))
      close.dispatchEvent(new MouseEvent('mousedown', { button: 0, detail: 1, bubbles: true }))
      expect(controls.startDragging).not.toHaveBeenCalled()
    } finally {
      app.unmount()
    }
  })

  it('does not start a window drag when clicking an icon inside a control', () => {
    const { host, app } = mount()
    try {
      const icon = host.querySelector('.tb-window-close svg')
      if (!icon) throw new Error('icon missing')
      icon.dispatchEvent(new MouseEvent('mousedown', { button: 0, detail: 1, bubbles: true }))
      expect(controls.startDragging).not.toHaveBeenCalled()
    } finally {
      app.unmount()
    }
  })

  it('does not start a window drag outside a Tauri runtime', () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    const { host, app } = mount()
    try {
      const zone = host.querySelector('.tb-center')
      if (!zone) throw new Error('drag zone missing')
      zone.dispatchEvent(new MouseEvent('mousedown', { button: 0, detail: 1, bubbles: true }))
      expect(controls.startDragging).not.toHaveBeenCalled()
    } finally {
      app.unmount()
    }
  })
})
