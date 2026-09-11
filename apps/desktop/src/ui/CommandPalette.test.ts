import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'

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

import CommandPalette from './CommandPalette.vue'

let pinia: Pinia
let mounted: VueApp[] = []

// Controllable rAF: the fade-in paint is deferred by two frames, and the
// close path must be able to cancel it.
let rafQueue: Array<() => void> = []

function stubRaf(): void {
  rafQueue = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(() => cb(0))
    return rafQueue.length
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafQueue[id - 1] = () => undefined
  })
}

function flushRaf(): void {
  const queue = rafQueue
  rafQueue = []
  for (const cb of queue) cb()
}

let reducedMotion = true
function stubMotion(): void {
  vi.stubGlobal('matchMedia', () => ({
    matches: reducedMotion,
    addEventListener() {},
    removeEventListener() {},
  }))
}

function mount(): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(CommandPalette)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
}

function pressCtrlK(): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }),
  )
}

function pressEscape(): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  )
}

function overlay(): Element | null {
  return document.body.querySelector('.palette-overlay')
}

function painted(): boolean {
  return overlay()?.classList.contains('is-open') ?? false
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('CommandPalette toggle', () => {
  beforeEach(async () => {
    pinia = createPinia()
    setActivePinia(pinia)
    document.body.innerHTML = ''
    mounted = []
    reducedMotion = true
    stubRaf()
    stubMotion()
    mount()
    await nextTick()
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('opens on Ctrl+K and closes on a second Ctrl+K', async () => {
    expect(overlay()).toBeNull()

    pressCtrlK()
    await nextTick()
    expect(overlay()).not.toBeNull()
    expect(painted()).toBe(true)

    pressCtrlK()
    await nextTick()
    await settle(250)
    expect(overlay()).toBeNull()
  })

  it('closes on Escape', async () => {
    pressCtrlK()
    await nextTick()
    expect(overlay()).not.toBeNull()

    pressEscape()
    await nextTick()
    await settle(250)
    expect(overlay()).toBeNull()
  })

  it('closes on Escape even before the fade-in has painted', async () => {
    // Non-reduced motion defers the fade-in by two frames, so `visible` is
    // still false right after opening. Gating Escape on that flag made the
    // first Escape press do nothing.
    reducedMotion = false
    pressCtrlK()
    await nextTick()
    expect(overlay()).not.toBeNull()
    expect(painted()).toBe(false)

    pressEscape()
    await nextTick()
    await settle(250)
    expect(overlay()).toBeNull()
  })

  it('reopens when Ctrl+K arrives during the fade-out', async () => {
    pressCtrlK()
    await nextTick()
    expect(overlay()).not.toBeNull()

    pressEscape()
    await nextTick()

    // A palette mid fade-out counts as closed, so this press revives it instead
    // of being swallowed by the in-flight close.
    pressCtrlK()
    await nextTick()
    await settle(250)
    expect(overlay()).not.toBeNull()
    expect(painted()).toBe(true)
  })

  it('cancels the deferred fade-in paint when closed first', async () => {
    reducedMotion = false
    pressCtrlK()
    await nextTick()
    expect(overlay()).not.toBeNull()

    // Close before the fade-in has painted. The palette is still mounted for the
    // fade duration, which is what makes the stale flag observable.
    pressEscape()
    await nextTick()
    expect(painted()).toBe(false)

    // Flushing the cancelled frame must NOT paint: a late paint would flip the
    // open flag back on while the palette is closing.
    flushRaf()
    flushRaf()
    await nextTick()
    expect(painted()).toBe(false)

    await settle(250)
    expect(overlay()).toBeNull()

    // And it is still usable afterwards.
    pressCtrlK()
    await nextTick()
    expect(overlay()).not.toBeNull()
    flushRaf()
    flushRaf()
    await nextTick()
    expect(painted()).toBe(true)
  })

  it('ignores Escape when it is not open', async () => {
    pressEscape()
    await nextTick()
    await settle(20)
    expect(overlay()).toBeNull()
  })
})
