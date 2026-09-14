/**
 * The model field, driven the way the report drove it.
 *
 * The report: the refresh finished without an error and the dropdown still
 * showed no models. The field was an `<input list="model-list">` pointing at a
 * native `<datalist>`, whose popup is drawn by the engine *outside the DOM* —
 * the same class of control as the 19 native `<select>`s this programme
 * removed, and one WebKitGTK draws poorly to the point of invisibility. So the
 * list is drawn by the app now, and these cases drive the real section: press
 * Refresh, read the store, open the field, read the DOM.
 *
 * The second case is the constraint that separates this field from a picker:
 * the list is only ever as good as the provider's `/models` endpoint, and
 * people paste model ids it does not know. A control that could only commit a
 * listed value would be a worse bug than the one being fixed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import AiSettings from './AiSettings.vue'
import { t } from '../../../i18n'
import { useSettingsStore } from '../../../stores/settings'

const mocks = vi.hoisted(() => ({ listModels: vi.fn() }))

vi.mock('../../../platform/runtime/gateway-runtime', () => ({
  getSharedGateways: () => ({
    ai: { listModels: mocks.listModels },
    keys: { storeAiKey: vi.fn(), loadAiKey: vi.fn().mockResolvedValue(null) },
    fs: {},
  }),
}))

let mounted: VueApp[] = []

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  mocks.listModels.mockReset()
  // Like the field's own `matchMedia` need in the panel suite: nothing here
  // asserts on the theme, and happy-dom does not implement it.
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

function mount(): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(AiSettings)
  app.mount(host)
  mounted.push(app)
}

/** The text input of the field labelled "Model" — the same label association
 *  the native control sat in, so what the user's field is has not moved. */
function modelField(): HTMLInputElement {
  const field = Array.from(document.querySelectorAll<HTMLElement>('.settings-section label'))
    .find((candidate) => candidate.querySelector('span')?.textContent?.trim() === t('aiSettings.model'))
  const input = field?.querySelector<HTMLInputElement>('input')
  if (!input) throw new Error('no input inside the field labelled "Model"')
  return input
}

function listbox(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="listbox"]')
}

function optionLabels(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .map((option) => option.textContent?.trim() ?? '')
}

function press(target: HTMLElement, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

/** Type into the field the way a keyboard does: set, then announce. */
function type(input: HTMLInputElement, text: string): void {
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function flush(): Promise<void> {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

describe('the model field', () => {
  it('offers the models a refresh just fetched, in a list the app draws', async () => {
    mocks.listModels.mockResolvedValue(['qwen2.5-coder:3b', 'gpt-4o-mini', 'claude-sonnet-4-5'])
    mount()
    await flush()

    document.querySelector<HTMLButtonElement>('.model-refresh')!.click()
    await flush()
    expect(useSettingsStore().modelsCache).toEqual([
      'qwen2.5-coder:3b',
      'gpt-4o-mini',
      'claude-sonnet-4-5',
    ])

    // The row's leftover width is given to the combobox's root by this
    // section's own scoped rule, and that rule only matches because Vue stamps
    // a child's root element with the parent's scope id. If that ever stops
    // being true the field silently collapses to its intrinsic width, which no
    // other test here can see.
    const wrapper = document.querySelector('.model-row > .combobox')
    expect(wrapper, 'the field is the combobox root in the model row').not.toBeNull()
    expect(
      [...wrapper!.attributes].filter((attribute) => attribute.name.startsWith('data-v-')),
    ).toHaveLength(2)

    const input = modelField()
    // The control itself: a native `<datalist>` popup is drawn by the engine
    // outside the DOM — no CSS reaches it, and WebKitGTK's support for it is
    // the reason the user saw nothing. Nothing here may fall back to one.
    expect(input.hasAttribute('list')).toBe(false)
    expect(document.querySelector('datalist')).toBeNull()
    expect(input.getAttribute('role')).toBe('combobox')

    // Opening the field is what had to work.
    input.click()
    await nextTick()
    expect(input.getAttribute('aria-expanded')).toBe('true')
    const list = listbox()
    expect(list, 'the model list is drawn in the DOM, where CSS can reach it').not.toBeNull()
    expect(input.getAttribute('aria-controls')).toBe(list!.id)
    expect(optionLabels()).toEqual([
      'qwen2.5-coder:3b',
      'gpt-4o-mini',
      'claude-sonnet-4-5',
    ])

    // The row the keyboard is on is the one a screen reader reads out.
    const active = input.getAttribute('aria-activedescendant')
    expect(document.getElementById(active ?? '')?.textContent?.trim()).toBe('qwen2.5-coder:3b')
  })

  it('keeps a model id the provider does not list', async () => {
    mocks.listModels.mockResolvedValue(['qwen2.5-coder:3b'])
    mount()
    const settings = useSettingsStore()
    settings.model = 'qwen2.5-coder:3b'

    const input = modelField()
    type(input, 'tokenflux/uncensored-72b')
    await nextTick()

    // Pasted from the provider's docs, or from a chat that names a model the
    // endpoint has never heard of. The field must take it verbatim.
    expect(settings.model).toBe('tokenflux/uncensored-72b')
    // Nothing matches, so nothing opens over the fields below it.
    expect(listbox()).toBeNull()
    expect(input.getAttribute('aria-expanded')).toBe('false')

    // And it survives the key that commits a suggestion: there is no row to
    // commit, so Enter must leave the typed value alone.
    press(input, 'Enter')
    await nextTick()
    expect(settings.model).toBe('tokenflux/uncensored-72b')

    // Escape closes (there is nothing open) without clearing what was typed.
    press(input, 'Escape')
    await nextTick()
    expect(input.value).toBe('tokenflux/uncensored-72b')
    expect(settings.model).toBe('tokenflux/uncensored-72b')
  })
})
