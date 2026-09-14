/**
 * The Plugins section's two "nothing to show" states.
 *
 * An unreadable `plugins/` folder and a library with no plugins are different
 * answers, and the user's next move is different for each. Rendering both as
 * "no plugins in this library" tells someone with a permission problem to go
 * looking for a plugin to install.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import PluginSettings from './PluginSettings.vue'
import { useVaultSessionStore } from '../../../stores/vault-session'
import { t } from '../../../i18n'

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

const flush = async (): Promise<void> => {
  await nextTick()
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

let mounted: VueApp[] = []
let pinia: Pinia

async function mountSection(): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(PluginSettings)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  await flush()
}

beforeEach(() => {
  localStorage.clear()
  pinia = createPinia()
  setActivePinia(pinia)
  mocks.listVaultPlugins.mockReset()
  mounted = []
  document.body.innerHTML = ''
  useVaultSessionStore().vault = '/vault'
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

describe('PluginSettings section', () => {
  it('says the folder could not be read, not that there are no plugins', async () => {
    mocks.listVaultPlugins.mockRejectedValue(new Error('EACCES: permission denied'))
    await mountSection()

    expect(document.querySelector('[data-test="plugins-unreadable"]')?.textContent).toBe(
      t('settings.plugins.unreadable'),
    )
    expect(document.body.textContent).not.toContain(t('settings.plugins.empty'))
  })

  it('says the library has no plugins when the read succeeded and found none', async () => {
    mocks.listVaultPlugins.mockResolvedValue([])
    await mountSection()

    expect(document.body.textContent).toContain(t('settings.plugins.empty'))
    expect(document.querySelector('[data-test="plugins-unreadable"]')).toBeNull()
  })
})
