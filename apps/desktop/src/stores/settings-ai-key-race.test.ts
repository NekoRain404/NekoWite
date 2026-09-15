import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const loadAiKeyMock = vi.hoisted(() => vi.fn())
const storeAiKeyMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/runtime/gateway-runtime', () => ({
  getSharedGateways: () => ({
    keys: { loadAiKey: loadAiKeyMock, storeAiKey: storeAiKeyMock },
    ai: { listModels: vi.fn(async () => []) },
  }),
}))

import { useSettingsStore } from './settings'

/**
 * The API-key field against the answers that arrive after the question moved
 * on.
 *
 * `loadKey()` asks the backend for the selected provider's key and writes the
 * answer into `apiKey`, the same ref the settings field binds to with
 * `v-model`. The write used to be unconditional, so an answer that arrived
 * after the user had switched provider — or after they had started typing the
 * key themselves — overwrote the field with a value about somebody else's
 * question. Both tests below fail on that write and pass on one that checks,
 * first, that the question has not moved on.
 *
 * The backend only ever returns a mask (or null), so the damage is bounded to
 * clearing the field; a cleared field also means `saveKey()` would store ''.
 */
describe('settings-ai: the key field vs a late answer', () => {
  /** Loads that stay pending until the test resolves them, keyed by provider. */
  function gatedLoads(): Map<string, (value: string | null) => void> {
    const gate = new Map<string, (value: string | null) => void>()
    loadAiKeyMock.mockImplementation(
      (provider: string) =>
        new Promise<string | null>((resolve) => {
          gate.set(provider, resolve)
        }),
    )
    return gate
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    loadAiKeyMock.mockReset()
    storeAiKeyMock.mockReset()
  })

  it('keeps what the user typed when the provider they left answers last', async () => {
    const gate = gatedLoads()
    const settings = useSettingsStore()

    settings.provider = 'anthropic'
    await nextTick()
    settings.provider = 'openai'
    await nextTick()
    // Each switch asked its own provider, so two loads are in flight.
    expect([...gate.keys()].sort()).toEqual(['anthropic', 'openai'])

    // The user starts typing the key for the provider they are on now.
    settings.apiKey = 'sk-the-user-just-typed'

    // The provider they LEFT answers last (null: no key configured for it).
    gate.get('anthropic')!(null)
    await nextTick()

    expect(settings.apiKey).toBe('sk-the-user-just-typed')
    expect(settings.provider).toBe('openai')
  })

  it('does not clear the field when the answer lands after the user started typing', async () => {
    const gate = gatedLoads()
    const settings = useSettingsStore()

    settings.provider = 'anthropic'
    await nextTick()
    settings.apiKey = 'sk-the-user-just-typed'

    // The answer to the switch this field is waiting on — arriving one
    // keystroke too late to be the field's owner.
    gate.get('anthropic')!('••••••••')
    await nextTick()

    expect(settings.apiKey).toBe('sk-the-user-just-typed')
  })

  it('still writes the answer when nothing has moved since the question', async () => {
    const gate = gatedLoads()
    const settings = useSettingsStore()

    // A key left in the field from the previous provider — the case the reload
    // exists for. Nothing is typed while the answer is in flight, so the field
    // is still the load's to write, and the reload clears it.
    settings.apiKey = 'sk-typed-but-not-saved'
    settings.provider = 'anthropic'
    await nextTick()
    gate.get('anthropic')!(null)
    await nextTick()

    expect(settings.apiKey).toBe('')
  })

  it('never puts the mask in the field', async () => {
    const gate = gatedLoads()
    const settings = useSettingsStore()

    settings.provider = 'anthropic'
    await nextTick()
    gate.get('anthropic')!('••••••••')
    await nextTick()

    expect(settings.apiKey).toBe('')
  })
})
