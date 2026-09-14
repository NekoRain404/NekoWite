import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'

vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: vi.fn().mockResolvedValue(''),
    write: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    watch: vi.fn(),
    stat: vi.fn(),
    onFsChange: vi.fn().mockResolvedValue(() => undefined),
    listHistory: vi.fn().mockResolvedValue([]),
    listTrash: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('../services/vault-files', () => ({
  vaultFileIndex: { invalidate: vi.fn(), files: vi.fn(() => []) },
}))

const runEditorCommandMock = vi.hoisted(() => vi.fn(() => true))
vi.mock('../services/run-editor-command', () => ({ runEditorCommand: runEditorCommandMock }))

import CommandPalette from './CommandPalette.vue'
import { useTabsStore } from '../stores/tabs'
import { t } from '../i18n'

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

function paletteItems(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('.palette-item')]
}

function itemLabels(): string[] {
  return paletteItems().map((el) => (el.querySelector('.palette-item-label')?.textContent ?? '').trim())
}

function itemWithLabel(label: string): HTMLElement | null {
  return paletteItems().find(
    (el) => (el.querySelector('.palette-item-label')?.textContent ?? '').trim() === label,
  ) ?? null
}

/** Type into the palette search box the way a user does (v-model listens for the
 *  native `input` event). */
function typeQuery(value: string): void {
  const input = document.body.querySelector<HTMLInputElement>('.palette-input')
  if (!input) throw new Error('palette input not rendered')
  input.value = value
  input.dispatchEvent(new Event('input'))
}

function painted(): boolean {
  return overlay()?.classList.contains('is-open') ?? false
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Long enough for the overlay to leave the tree on the *animated* close path.
 *
 * The palette holds the node for `--app-motion` while it fades, and there is no
 * stylesheet in this environment, so the component's own `MOTION_FALLBACK_MS`
 * is what governs — 300ms. The other close tests run under reduced motion,
 * where the node goes on the same tick, which is why only the two that opt out
 * of it need this. This is the harness keeping up with a duration, not an
 * assertion being loosened: what is asserted is still "the overlay is gone".
 */
const AFTER_FADE = 400

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

describe('CommandPalette toggle', () => {
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
    await settle(AFTER_FADE)
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

    await settle(AFTER_FADE)
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

/** The listbox may only own options (and presentational wrappers): anything
 *  else inside it is announced as an option or dropped from the accessibility
 *  tree inconsistently. */
const ALLOWED_INSIDE_LISTBOX = new Set(['option', 'presentation', 'none', 'group'])

describe('CommandPalette listbox composition', () => {
  it('exposes only options and presentational wrappers inside role=listbox', async () => {
    await useTabsStore().openTab(null)
    pressCtrlK()
    await nextTick()

    const listbox = document.body.querySelector<HTMLElement>('[role="listbox"]')!
    expect(listbox).toBeTruthy()
    const offenders = [...listbox.querySelectorAll<HTMLElement>('[role]')]
      .filter((el) => el !== listbox)
      .map((el) => `${el.className}:${el.getAttribute('role')}`)
      .filter((entry) => !ALLOWED_INSIDE_LISTBOX.has(entry.split(':')[1] ?? ''))

    expect(offenders).toEqual([])

    // Every listbox child that isn't an option must be hidden from the
    // accessibility tree, so the option index stays truthful.
    const wrappers = [...listbox.children].filter(
      (child) => child.getAttribute('role') !== 'option',
    )
    for (const wrapper of wrappers) {
      expect(['presentation', 'none']).toContain(wrapper.getAttribute('role'))
    }
  })
})

describe('CommandPalette commands without an open document', () => {
  it('offers no editor command — and says why — while no document is open', async () => {
    pressCtrlK()
    await nextTick()

    // Every palette command runs against the live editor model, so with no
    // document open each one would be a silent no-op: `runEditorCommand` reports
    // "nothing handled it" and the row did nothing at all. Nothing that cannot
    // run is offered.
    expect(itemLabels()).toEqual([])
    // The empty list is explained instead of leaving a dead command list behind.
    expect(document.body.textContent).toContain(t('palette.noDocument'))

    // A query that exactly matches a formatting command still offers nothing.
    typeQuery(t('command.bold'))
    await nextTick()
    expect(itemLabels()).toEqual([])
  })

  it('offers the editor commands again once a document is open', async () => {
    await useTabsStore().openTab(null)
    pressCtrlK()
    await nextTick()

    const labels = itemLabels()
    expect(labels).toContain(t('command.bold'))
    expect(labels).toContain(t('command.heading:h1'))
    // The builtin formatting set (20 commands) is offered again with a document.
    expect(labels.length).toBeGreaterThanOrEqual(20)
    expect(document.body.textContent).not.toContain(t('chat.emptyDocHint'))

    // Executing a row dispatches through the shared, mode-aware runner.
    itemWithLabel(t('command.bold'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(runEditorCommandMock).toHaveBeenCalledWith('bold')
  })
})
