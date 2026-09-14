/**
 * The model field inside the dialog it actually lives in.
 *
 * `AiSettings.model.test.ts` drives the section on its own; what is pinned here
 * is only the thing the section cannot see: Escape, and who is allowed to
 * answer it. Every dialog in the app listens for Escape on `window` in the
 * capture phase, and a capture listener runs *before* the field's own — so if
 * the open list does not take the top of the modal stack, one press closes the
 * list and the settings dialog together. That is the failure this file exists
 * to make impossible to reintroduce.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import SettingsPanel from './SettingsPanel.vue'
import { modalStack } from '../../../services/modal-stack'
import { useSettingsStore } from '../../../stores/settings'

const mocks = vi.hoisted(() => ({ listModels: vi.fn() }))

vi.mock('../../../platform/runtime/gateway-runtime', () => ({
  getSharedGateways: () => ({
    ai: { listModels: mocks.listModels },
    keys: { storeAiKey: vi.fn(), loadAiKey: vi.fn().mockResolvedValue(null) },
    fs: {},
  }),
}))

vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '9.9.9') }))

let mounted: VueApp[] = []
let onClose: ReturnType<typeof vi.fn>

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  mocks.listModels.mockReset().mockResolvedValue([])
  onClose = vi.fn()
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
  modalStack.resetModalStack()
})

async function openAiSection(): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(SettingsPanel, { onClose, onSaved: vi.fn() } as never)
  app.mount(host)
  mounted.push(app)
  await nextTick()
  // The rail is labelled and ordered — AI is the fifth section.
  Array.from(document.querySelectorAll<HTMLElement>('.nav-row'))[4]?.click()
  await nextTick()
}

function modelInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')
  if (!input) throw new Error('no combobox input in the dialog')
  return input
}

function pressEscape(): void {
  // One real press, from the focused field. It reaches the dialog's listener on
  // `window` first (capture) and the field's own second — the order that made
  // this bug possible in the first place.
  document.activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  )
}

describe('the model field in the settings dialog', () => {
  it('takes Escape for its own list, leaving the dialog open', async () => {
    const settings = useSettingsStore()
    settings.model = 'gpt-4o-mini'
    settings.modelsCache = ['gpt-4o-mini', 'gpt-4.1']
    await openAiSection()

    const input = modelInput()
    input.click()
    // A real click focuses the field (the mousedown does it); happy-dom's
    // `click()` does not, and an Escape sent anywhere else never reaches the
    // field's own handler.
    input.focus()
    await nextTick()
    expect(document.querySelector('[role="listbox"]')).not.toBeNull()

    pressEscape()
    await nextTick()

    // The list is what the user was looking at, so the list is what Escape
    // closes — the dialog a click outside would have dismissed stays.
    expect(input.getAttribute('aria-expanded')).toBe('false')
    // The element outlives the close by one motion rung, so it is waited out
    // rather than asserted away in the same tick.
    await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull())
    expect(document.querySelector('.settings-dialog')).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()

    // And the plain Escape, with nothing of ours open, still closes it.
    pressEscape()
    await nextTick()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('writes a picked row through to the store from inside the dialog', async () => {
    const settings = useSettingsStore()
    settings.model = 'gpt-4o-mini'
    settings.modelsCache = ['gpt-4o-mini', 'stale-model']
    await openAiSection()

    modelInput().click()
    await nextTick()
    // The row is teleported to <body>, outside the dialog and above its
    // overlay: it has to be reachable and clickable there.
    const row = [...document.querySelectorAll<HTMLElement>('.combo-option')]
      .find((candidate) => candidate.dataset.value === 'stale-model')
    expect(row, 'the row is in the document').toBeDefined()
    row!.click()
    await nextTick()

    expect(settings.model).toBe('stale-model')
    expect(modelInput().getAttribute('aria-expanded')).toBe('false')
    await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull())
  })

  it('shows a refresh result in the dialog, which is the report', async () => {
    // The report was not a missing model: it was a list that had arrived and a
    // control that could not draw it. This walks the whole path in the dialog.
    mocks.listModels.mockResolvedValue(['tokenflux/uncensored-72b'])
    await openAiSection()

    document.querySelector<HTMLButtonElement>('.model-refresh')!.click()
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()

    modelInput().click()
    await nextTick()
    expect(
      [...document.querySelectorAll<HTMLElement>('[role="option"]')]
        .map((option) => option.textContent?.trim()),
    ).toContain('tokenflux/uncensored-72b')
  })
})
