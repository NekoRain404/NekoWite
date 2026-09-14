/**
 * The plugin rows.
 *
 * Two rules are worth pinning: opening the section reads manifests and never
 * imports plugin code, and flipping a switch re-reads rather than trusting the
 * click — the row has to describe the app's actual state, not the assumed one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { usePluginSettings, type PluginSettingsModel } from './use-plugin-settings'
import { useVaultSessionStore } from '../../../stores/vault-session'
import type { VaultPluginSummary } from '../../../services/plugins'

const mocks = vi.hoisted(() => ({
  listVaultPlugins: vi.fn(),
  setVaultPluginDisabled: vi.fn(),
  isPluginImportAllowedByCsp: vi.fn(() => true),
}))

vi.mock('../../../services/plugins', () => ({
  listVaultPlugins: mocks.listVaultPlugins,
  setVaultPluginDisabled: mocks.setVaultPluginDisabled,
  isPluginImportAllowedByCsp: mocks.isPluginImportAllowedByCsp,
}))

const ALFA: VaultPluginSummary = {
  id: 'alfa',
  name: 'Alfa',
  version: '1.0.0',
  disabled: false,
  active: true,
  unstable: false,
} as VaultPluginSummary

let pinia: Pinia
let mounted: VueApp[] = []

async function mountModel(): Promise<PluginSettingsModel> {
  let created: PluginSettingsModel | null = null
  const app = createApp({
    setup() {
      created = usePluginSettings()
      return () => null
    },
  })
  app.use(pinia)
  app.mount(document.createElement('div'))
  mounted.push(app)
  await nextTick()
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
  return created!
}

beforeEach(() => {
  localStorage.clear()
  pinia = createPinia()
  setActivePinia(pinia)
  mocks.listVaultPlugins.mockReset().mockResolvedValue([ALFA])
  mocks.setVaultPluginDisabled.mockReset()
  mounted = []
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
})

describe('usePluginSettings', () => {
  it('reads the open vault’s plugin manifests when the section mounts', async () => {
    useVaultSessionStore().vault = '/vault'
    const m = await mountModel()

    expect(mocks.listVaultPlugins).toHaveBeenCalledWith('/vault')
    expect(m.rows.value).toEqual([ALFA])
    expect(m.loading.value).toBe(false)
  })

  it('lists nothing without a vault rather than reading an empty path', async () => {
    const m = await mountModel()

    expect(mocks.listVaultPlugins).not.toHaveBeenCalled()
    expect(m.rows.value).toEqual([])
  })

  it('shows an empty list when the read fails, not a stale one', async () => {
    useVaultSessionStore().vault = '/vault'
    mocks.listVaultPlugins.mockRejectedValue(new Error('unreadable'))
    const m = await mountModel()

    expect(m.rows.value).toEqual([])
    expect(m.loading.value).toBe(false)
  })

  it('re-reads after a toggle, so the row reports the outcome and not the click', async () => {
    useVaultSessionStore().vault = '/vault'
    const m = await mountModel()
    mocks.listVaultPlugins.mockResolvedValue([{ ...ALFA, disabled: true, active: false }])

    await m.togglePlugin(ALFA, false)

    expect(mocks.setVaultPluginDisabled).toHaveBeenCalledWith('alfa', true, { vault: '/vault' })
    expect(mocks.listVaultPlugins).toHaveBeenCalledTimes(2)
    expect(m.rows.value[0]!.disabled).toBe(true)
  })
})
