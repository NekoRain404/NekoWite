/**
 * The corner grip, and the one place the dialog's size is allowed to come from.
 *
 * The two things this file is here to stop, both of which a wrong implementation passes a
 * "the dialog got bigger" test with:
 *
 *  - **A size declared twice.** The dialog used to carry `width: min(720px, 100%)` in its own
 *    stylesheet, and a drag writing an inline width that the `min()` still capped is the
 *    two-answers defect: the grip would sit inside the corner it is supposed to be on. That one is
 *    not visible in a rendered tree, so it has a file of its own —
 *    `SettingsPanel.size-declaration.test.ts` — which is also the one that can be verified against
 *    the commit before the drag, since a guard sharing a file with these cases fails on collection
 *    there rather than on its assertion.
 *  - **An interpolated resize.** §7.3's 正文稳定 is strongest here — a `transition` on the dialog's
 *    `width`/`height` re-flows every line of text in it for the length of the curve. Asserted from
 *    the engine in `e2e/settings-resize.spec.ts` and in `size-declaration.test.ts` from the source.
 *
 * The equality this file settles on is between two independently answered numbers: what the model
 * reports (`aria-valuenow` / the inline style) and what the element's own attribute says. A
 * separator whose label is right and whose value never moves is the failure that leaves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import SettingsPanel from './SettingsPanel.vue'
import {
  DIALOG_BOUNDS_FALLBACK,
  DIALOG_HEIGHT_DEFAULT,
  DIALOG_HEIGHT_MIN,
  DIALOG_SIZE_KEY_HEIGHT,
  DIALOG_SIZE_KEY_WIDTH,
  DIALOG_SIZE_STEP,
  DIALOG_WIDTH_DEFAULT,
  DIALOG_WIDTH_MIN,
} from '../composables/use-dialog-size'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '9.9.9') }))

let mounted: VueApp[] = []

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  localStorage.clear()
  setActivePinia(createPinia())
  globalThis.matchMedia = vi.fn(() => ({
    matches: false,
    media: '',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as never
  document.body.innerHTML = ''
  mounted = []
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

function mountPanel(): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(SettingsPanel, { onClose: vi.fn(), onSaved: vi.fn() } as never)
  app.mount(host)
  mounted.push(app)
}

function dialog(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.settings-dialog')
  if (el === null) throw new Error('the dialog is not mounted')
  return el
}

function grip(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.settings-resize')
  if (el === null) throw new Error('the grip is not mounted')
  return el
}

/**
 * The size the dialog is *rendered* at, read from the element rather than from the model.
 *
 * `getBoundingClientRect()` is 0 in jsdom, so the element's own inline `style` is what a test can
 * read — which is also the honest target: it is the value the engine would apply.
 */
function renderedSize(): { width: number; height: number } {
  const el = dialog()
  return {
    width: Number.parseFloat(el.style.width),
    height: Number.parseFloat(el.style.height),
  }
}

async function press(key: string): Promise<void> {
  grip().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  await nextTick()
}

describe('the settings dialog’s corner grip', () => {
  it('is a focusable separator with a name and a value, not a decoration', () => {
    mountPanel()
    const el = grip()

    expect(el.getAttribute('role')).toBe('separator')
    expect(el.getAttribute('tabindex')).toBe('0')
    expect(el.getAttribute('aria-label')?.trim().length).toBeGreaterThan(0)
    // The value semantics every focusable separator carries — without them a screen reader has a
    // control it cannot report the state of.
    expect(el.getAttribute('aria-valuemin')).toBe(String(DIALOG_WIDTH_MIN))
    expect(el.getAttribute('aria-valuenow')).toBe(String(DIALOG_WIDTH_DEFAULT))
    expect(el.getAttribute('aria-valuemax')).toBe(String(DIALOG_BOUNDS_FALLBACK.width))
    // Both axes, in the text — `aria-valuenow` reports one and the grip moves two.
    const valueText = el.getAttribute('aria-valuetext') ?? ''
    expect(valueText).toContain(String(DIALOG_WIDTH_DEFAULT))
    expect(valueText).toContain(String(DIALOG_HEIGHT_DEFAULT))
  })

  it('renders the dialog at its clean-install size', () => {
    mountPanel()
    expect(renderedSize()).toEqual({
      width: DIALOG_WIDTH_DEFAULT,
      height: DIALOG_HEIGHT_DEFAULT,
    })
  })

  it('moves one axis per arrow, and reports the same number it renders', async () => {
    mountPanel()
    await press('ArrowRight')
    expect(renderedSize().width).toBe(DIALOG_WIDTH_DEFAULT + DIALOG_SIZE_STEP)
    expect(grip().getAttribute('aria-valuenow')).toBe(
      String(DIALOG_WIDTH_DEFAULT + DIALOG_SIZE_STEP),
    )
    await press('ArrowDown')
    expect(renderedSize().height).toBe(DIALOG_HEIGHT_DEFAULT + DIALOG_SIZE_STEP)
    // The width did not follow the down arrow: two axes, two keys.
    expect(renderedSize().width).toBe(DIALOG_WIDTH_DEFAULT + DIALOG_SIZE_STEP)
  })

  it('takes a bigger step with Shift held, and shrinks on the opposite arrow', async () => {
    mountPanel()
    grip().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }),
    )
    await nextTick()
    expect(renderedSize().width).toBe(DIALOG_WIDTH_DEFAULT + DIALOG_SIZE_STEP * 4)
    await press('ArrowLeft')
    expect(renderedSize().width).toBe(DIALOG_WIDTH_DEFAULT + DIALOG_SIZE_STEP * 3)
  })

  it('stops at the floor rather than shrinking past what its content needs', async () => {
    mountPanel()
    for (let i = 0; i < 60; i += 1) await press('ArrowLeft')
    expect(renderedSize().width).toBe(DIALOG_WIDTH_MIN)
    await press('Home')
    expect(renderedSize()).toEqual({ width: DIALOG_WIDTH_MIN, height: DIALOG_HEIGHT_MIN })
  })

  it('stops at the window rather than growing past what the app can show', async () => {
    mountPanel()
    await press('End')
    // jsdom lays nothing out, so the room is the documented fallback — and the point of the case is
    // that the ceiling is a measured bound and not a constant of its own.
    expect(renderedSize()).toEqual({
      width: DIALOG_BOUNDS_FALLBACK.width,
      height: DIALOG_BOUNDS_FALLBACK.height,
    })
  })

  it('is put back to the size it opens at by a double-click', async () => {
    mountPanel()
    await press('End')
    expect(renderedSize().width).toBe(DIALOG_BOUNDS_FALLBACK.width)
    grip().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await nextTick()
    expect(renderedSize()).toEqual({
      width: DIALOG_WIDTH_DEFAULT,
      height: DIALOG_HEIGHT_DEFAULT,
    })
  })

  it('writes both numbers where the next launch reads them', async () => {
    mountPanel()
    await press('ArrowRight')
    expect(localStorage.getItem(DIALOG_SIZE_KEY_WIDTH)).toBe(
      String(DIALOG_WIDTH_DEFAULT + DIALOG_SIZE_STEP),
    )
    expect(localStorage.getItem(DIALOG_SIZE_KEY_HEIGHT)).toBe(String(DIALOG_HEIGHT_DEFAULT))
  })

  it('opens at the size the last session left', () => {
    localStorage.setItem(DIALOG_SIZE_KEY_WIDTH, '900')
    localStorage.setItem(DIALOG_SIZE_KEY_HEIGHT, '600')
    mountPanel()
    expect(renderedSize()).toEqual({ width: 900, height: 600 })
  })
})
