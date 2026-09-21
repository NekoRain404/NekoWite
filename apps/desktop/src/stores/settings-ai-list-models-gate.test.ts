/**
 * The model list, and the master switch that has to stop it.
 *
 * `features/ai/services/ai-gate.ts` states the rule for the whole app: with the
 * AI master switch off, "no request may leave the app". The model-list path was
 * the one that never consulted it — `刷新模型列表`, the provider watcher and the
 * provider form's `获取模型` all reached `ai_list_models`, and the Rust command
 * backfills the stored API key, so the request left carrying a real credential
 * while the user had switched AI off.
 *
 * This file holds the deepest half of the fix: the store action itself. Both
 * settings-page gestures go through it (`use-ai-settings.test.ts` drives them),
 * and the provider form's fetch has a port of its own and its own test
 * (`agent-provider-authoring.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { onNotify } from '../services/errors'

const listModelsMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/runtime/gateway-runtime', () => ({
  getSharedGateways: () => ({
    ai: { listModels: listModelsMock },
    keys: { loadAiKey: vi.fn(async () => null), storeAiKey: vi.fn(async () => undefined) },
  }),
}))

import { useSettingsStore } from './settings'
import { useAiPermissionStore } from './ai-permission'
import { t } from '../i18n'

describe('settings-ai: the model list under the master switch', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    listModelsMock.mockReset().mockResolvedValue(['model-a'])
  })

  it('sends nothing when the AI master switch is off', async () => {
    // AI is off in Settings → AI. `ai_list_models` is a request that leaves the
    // app with a credential attached, which is exactly what the switch promises
    // to stop — the module that owns the switch says so, and this path used not
    // to ask it.
    useAiPermissionStore().setEnabled(false)
    const s = useSettingsStore()

    await s.listModels()

    expect(listModelsMock).not.toHaveBeenCalled()
  })

  it('explains the block instead of leaving the refresh looking broken', async () => {
    // The other way this fix can be wrong is a silent no-op: the button would
    // finish with no error and no new models, which is the shape of the
    // model-list report this whole path was fixed for. Every other AI surface
    // says why it refused (`ai-ghost.ts`, `ai-chat.ts`), so this one does too.
    useAiPermissionStore().setEnabled(false)
    const messages: string[] = []
    const off = onNotify((msg) => messages.push(msg))

    await useSettingsStore().listModels()
    off()

    expect(messages).toEqual([t('aiperm.blockedDisabled')])
  })

  it('keeps the fetch a switched-on install is allowed to make', async () => {
    // The default state, and the state a build that predates the switch reads
    // back: the request goes out and the cache lands, exactly as before.
    const s = useSettingsStore()

    await s.listModels()

    expect(listModelsMock).toHaveBeenCalledTimes(1)
    expect(s.modelsCache).toEqual(['model-a'])
  })
})
