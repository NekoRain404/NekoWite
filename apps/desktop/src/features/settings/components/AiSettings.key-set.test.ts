/**
 * The "a key is set" affordance in the AI section.
 *
 * The store empties the API-key field whenever a stored key arrives (the mask
 * must never be sent back as a credential), so a provider that is perfectly
 * configured shows an empty field — indistinguishable from a fresh install.
 * `keyConfigured` is the fact the store publishes for exactly this (38dde36),
 * and these tests pin the section to read it, to render a note that says a key
 * is set, and to keep that note away from anything that would break the key
 * lifecycle: the mask never reaches the field, typing a replacement still
 * works, and a key genuinely cleared still reads as unset.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import AiSettings from './AiSettings.vue'
import { t } from '../../../i18n'
import { useSettingsStore } from '../../../stores/settings'

const mocks = vi.hoisted(() => ({
  listModels: vi.fn(),
  storeAiKey: vi.fn(),
  loadAiKey: vi.fn(),
}))

vi.mock('../../../platform/runtime/gateway-runtime', () => ({
  getSharedGateways: () => ({
    ai: { listModels: mocks.listModels },
    keys: { storeAiKey: mocks.storeAiKey, loadAiKey: mocks.loadAiKey },
    fs: {},
  }),
}))

/** The frontend's copy of the Rust constant (`key_store::AI_KEY_MASKED`). */
const MASK = '••••••••'

let mounted: VueApp[] = []

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  mocks.listModels.mockReset().mockResolvedValue([])
  mocks.storeAiKey.mockReset().mockResolvedValue(undefined)
  mocks.loadAiKey.mockReset().mockResolvedValue(null)
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

async function flush(): Promise<void> {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

/** The text input of the field labelled "API Key". */
function apiKeyField(): HTMLInputElement {
  const field = Array.from(document.querySelectorAll<HTMLElement>('.settings-section label'))
    .find((candidate) => candidate.querySelector('span')?.textContent?.trim() === t('aiSettings.apiKey'))
  const input = field?.querySelector<HTMLInputElement>('input')
  if (!input) throw new Error('no input inside the field labelled "API Key"')
  return input
}

/** The "a key is set" affordance, located by its stable hook. */
function keySetNote(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-test="ai-key-set"]')
}

describe('the AI section’s stored-key affordance', () => {
  it('tells a configured provider apart from a fresh one, without ever showing the mask', async () => {
    // The vault has a key for this provider — the ordinary post-restart world.
    mocks.loadAiKey.mockImplementation(async (): Promise<string | null> => MASK)
    const settings = useSettingsStore()
    await settings.loadKey()
    expect(settings.keyConfigured).toBe(true)
    expect(settings.apiKey).toBe('')

    mount()
    await flush()

    const note = keySetNote()
    expect(note, 'a configured provider must show a "key is set" affordance').not.toBeNull()
    expect(note!.textContent).toBe(t('aiSettings.keySet'))
    // The mask must never appear in the field: the store blanks it, and the
    // section binds to that blanked value.
    expect(apiKeyField().value).toBe('')
    expect(apiKeyField().value).not.toContain('•')
  })

  it('shows nothing for a fresh provider with no key', async () => {
    mocks.loadAiKey.mockImplementation(async (): Promise<string | null> => null)
    const settings = useSettingsStore()
    await settings.loadKey()

    mount()
    await flush()

    expect(settings.keyConfigured).toBe(false)
    expect(keySetNote()).toBeNull()
  })

  it('lets the user type a replacement into the configured field', async () => {
    mocks.loadAiKey.mockImplementation(async (): Promise<string | null> => MASK)
    const settings = useSettingsStore()
    await settings.loadKey()

    mount()
    await flush()
    expect(keySetNote(), 'the configured state is what the replacement starts from').not.toBeNull()

    const field = apiKeyField()
    expect(field.readOnly, 'the affordance must not make the field read-only').toBe(false)
    field.value = 'sk-replacement'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    // Typing writes through to the store, and must mean "replace".
    expect(settings.apiKey).toBe('sk-replacement')
    // While the field's own dots carry "something is here", the "type here to
    // replace" note steps back instead of contradicting the typing.
    expect(keySetNote()).toBeNull()
  })

  it('reads a key genuinely cleared in Settings as unset again', async () => {
    mocks.loadAiKey.mockImplementation(async (): Promise<string | null> => MASK)
    mocks.storeAiKey.mockImplementation(async (): Promise<void> => undefined)
    const settings = useSettingsStore()
    await settings.loadKey()
    expect(settings.keyConfigured).toBe(true)

    mount()
    await flush()
    expect(keySetNote(), 'the configured state is the cleared state’s starting point').not.toBeNull()

    // Emptying the field and pressing Save key is how a key is removed.
    settings.apiKey = ''
    await settings.saveKey()
    await nextTick()

    expect(settings.keyConfigured).toBe(false)
    expect(keySetNote()).toBeNull()
  })
})
