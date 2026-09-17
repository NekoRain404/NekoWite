/**
 * The master-password control, reached the way a user reaches it: through the AI section.
 *
 * `VaultKeySettings.test.ts` next door pins what the block draws and how it fails. This file pins
 * the thing this project keeps getting wrong — 「建好了但够不到」, built but unreachable. A
 * component with twelve passing tests of its own is still a defect if the section that owns its
 * subject never renders it, and that is exactly the state `set_master_password` and
 * `unlock_vault` were in: implemented, tested, declared in the IPC manifest, and named by nothing
 * under `src/`.
 *
 * So this mounts the *real* `AiSettings.vue`, not the block, and drives the two gestures a user
 * makes: read the state, then enter the password and press the button. It fails at the first
 * assertion on a tree where the block exists but is not mounted anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import AiSettings from './AiSettings.vue'
import { t, setLocale } from '../../../i18n'

const mocks = vi.hoisted(() => ({
  listModels: vi.fn(),
  storeAiKey: vi.fn(),
  loadAiKey: vi.fn(),
  vaultStatus: vi.fn(),
  setMasterPassword: vi.fn(),
  unlockVault: vi.fn(),
}))

vi.mock('../../../platform/runtime/gateway-runtime', () => ({
  getSharedGateways: () => ({
    ai: { listModels: mocks.listModels },
    keys: {
      storeAiKey: mocks.storeAiKey,
      loadAiKey: mocks.loadAiKey,
      vaultStatus: mocks.vaultStatus,
      setMasterPassword: mocks.setMasterPassword,
      unlockVault: mocks.unlockVault,
    },
    fs: {},
  }),
}))

let mounted: VueApp[] = []

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  setLocale('zh')
  mocks.listModels.mockReset().mockResolvedValue([])
  mocks.storeAiKey.mockReset().mockResolvedValue(undefined)
  mocks.loadAiKey.mockReset().mockResolvedValue(null)
  mocks.vaultStatus.mockReset().mockResolvedValue({ passwordSet: true, unlocked: false })
  mocks.setMasterPassword.mockReset().mockResolvedValue(undefined)
  mocks.unlockVault.mockReset().mockResolvedValue(undefined)
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

async function mountSection(): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(AiSettings)
  app.mount(host)
  mounted.push(app)
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

function hook(name: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-test="${name}"]`)
}

describe('the AI section reaches the master password', () => {
  it('renders the vault control the section’s own key note is a claim about', async () => {
    await mountSection()

    const state = hook('vault-state')
    expect(
      state,
      'the AI section claims the key is "protected by your master password" and offers no way ' +
        'to set or enter one',
    ).not.toBeNull()
    // The sentence above it is the claim this control answers; both are on the page, and the
    // control is drawn from the backend's answer rather than from anything on the form.
    expect(mocks.vaultStatus).toHaveBeenCalled()
    expect(state!.textContent).toBe(t('aiSettings.vault.locked'))
  })

  it('unlocks from the section: type the password, press the button', async () => {
    await mountSection()

    const input = hook('vault-password')
    expect(input, 'the unlock field is reachable from the section').toBeInstanceOf(HTMLInputElement)
    const field = input as HTMLInputElement
    field.value = 'the master password'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    const button = hook('vault-submit')
    expect(button).toBeInstanceOf(HTMLButtonElement)
    ;(button as HTMLButtonElement).click()
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mocks.unlockVault).toHaveBeenCalledWith('the master password')
  })
})
