import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const loadAiKeyMock = vi.hoisted(() => vi.fn())
const storeAiKeyMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/runtime/gateway-runtime', () => ({
  getSharedGateways: () => ({
    keys: { loadAiKey: loadAiKeyMock, storeAiKey: storeAiKeyMock },
    ai: { listModels: vi.fn(async (): Promise<string[]> => []) },
  }),
}))

import { useSettingsStore } from './settings'
import { isAiConfigured } from '../services/ai-readiness'

/**
 * The stored-key fact, and the gate that reads it.
 *
 * `loadKey()` asks the vault whether this provider has a key, and then throws
 * the evidence away on purpose: the mask must never be written into `apiKey`
 * (it would be sent back as the credential), so a configured install is left
 * looking exactly like a fresh one. `keyConfigured` is that answer published as
 * state of its own, and the ghost writer's gate reads it — the field cannot
 * tell it what it needs to know.
 *
 * The load is driven directly here, which is what both ways into it do: the
 * provider watcher and `app-bootstrap.ts` call this same `loadKey()`.
 */

/** The frontend's copy of the Rust constant (`key_store::AI_KEY_MASKED`). */
const MASK = '••••••••'

/** The state the shortcut hands `isAiConfigured`, read the way it reads it. */
function readiness(s: ReturnType<typeof useSettingsStore>): {
  provider: string
  baseUrl: string
  apiKey: string
  keyConfigured: boolean
} {
  return {
    provider: s.provider,
    baseUrl: s.baseUrl,
    apiKey: s.apiKey,
    keyConfigured: s.keyConfigured,
  }
}

describe('settings-ai: the stored-key fact', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    loadAiKeyMock.mockReset()
    storeAiKeyMock.mockReset()
  })

  it('loads a stored key as configured, without letting the mask into the field', async () => {
    // The install that had a key configured before this launch.
    localStorage.setItem('nekowite.ai.provider', 'anthropic')
    loadAiKeyMock.mockImplementation(async (): Promise<string | null> => MASK)
    const s = useSettingsStore()

    await s.loadKey()

    expect(s.apiKey).toBe('')
    expect(s.keyConfigured).toBe(true)
    // The property the blanking exists for, restated where the fact now lives.
    expect(s.config().api_key).toBeUndefined()
  })

  it('arms the gate on the loaded state, though the field is empty', async () => {
    localStorage.setItem('nekowite.ai.provider', 'anthropic')
    loadAiKeyMock.mockImplementation(async (): Promise<string | null> => MASK)
    const s = useSettingsStore()
    await s.loadKey()

    const state = readiness(s)
    const configured = isAiConfigured(state)
    expect(
      configured,
      `apiKey=${JSON.stringify(state.apiKey)} keyConfigured=${String(
        state.keyConfigured,
      )} -> isAiConfigured=${String(configured)}`,
    ).toBe(true)
  })

  it('leaves a fresh install unconfigured: no stored key, nothing typed', async () => {
    localStorage.setItem('nekowite.ai.provider', 'openai')
    loadAiKeyMock.mockImplementation(async (): Promise<string | null> => null)
    const s = useSettingsStore()

    await s.loadKey()

    expect(s.apiKey).toBe('')
    expect(s.keyConfigured).toBe(false)
    expect(isAiConfigured(readiness(s))).toBe(false)
  })

  it('reads a key cleared in Settings as unconfigured again', async () => {
    localStorage.setItem('nekowite.ai.provider', 'openai')
    loadAiKeyMock.mockImplementation(async (): Promise<string | null> => MASK)
    storeAiKeyMock.mockImplementation(async (): Promise<void> => undefined)
    const s = useSettingsStore()
    await s.loadKey()
    expect(s.keyConfigured).toBe(true)

    // Emptying the field and pressing Save key is how a key is removed.
    s.apiKey = ''
    await s.saveKey()

    expect(s.keyConfigured).toBe(false)
    expect(isAiConfigured(readiness(s))).toBe(false)
  })

  it('publishes the fact again after a provider switch', async () => {
    // The switch's own load, held open so the assertion runs on its answer and
    // not on a timer.
    const gate = new Map<string, (value: string | null) => void>()
    loadAiKeyMock.mockImplementation(
      (provider: string): Promise<string | null> =>
        new Promise((resolve) => {
          gate.set(provider, resolve)
        }),
    )
    const s = useSettingsStore()

    s.provider = 'deepseek'
    await nextTick()

    expect(gate.has('deepseek')).toBe(true)
    gate.get('deepseek')!(MASK)
    await Promise.resolve()
    await Promise.resolve()

    expect(s.apiKey).toBe('')
    expect(s.keyConfigured).toBe(true)
  })
})
