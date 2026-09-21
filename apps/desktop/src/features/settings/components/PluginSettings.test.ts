/**
 * The Plugins section's two "nothing to show" states, and the switch itself.
 *
 * An unreadable `plugins/` folder and a library with no plugins are different
 * answers, and the user's next move is different for each. Rendering both as
 * "no plugins in this library" tells someone with a permission problem to go
 * looking for a plugin to install.
 *
 * The switch has the same duty in the other direction: a plugin that could not be
 * started must not be left looking started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import PluginSettings from './PluginSettings.vue'
import { useVaultSessionStore } from '../../../stores/vault-session'
import { t } from '../../../i18n'
import { onNotify } from '../../../services/errors'
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

const flush = async (): Promise<void> => {
  await nextTick()
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

let mounted: VueApp[] = []
let pinia: Pinia

const ROW: VaultPluginSummary = {
  id: 'alfa',
  name: 'Alfa',
  version: '1.0.0',
  disabled: true,
  active: false,
  unstable: false,
}

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

  it('takes the tick back off the switch when the plugin could not be started', async () => {
    // F11's user-visible half. The tick is the user's; the state is the app's.
    // A refused switch (the gates said no, or the library's file would not take
    // the decision) leaves the record where it was, so the switch has to come
    // back off and say what stopped it.
    mocks.listVaultPlugins.mockResolvedValue([ROW])
    mocks.setVaultPluginDisabled.mockResolvedValue({
      disabled: true,
      refused: 'revoked: version 1.0.0 is no longer allowed',
      saved: 'saved',
    })
    await mountSection()

    const box = document.querySelector<HTMLInputElement>('.plugin-row input[type="checkbox"]')
    if (!box) throw new Error('unreachable: the row renders a switch')
    expect(box.checked).toBe(false)

    const messages: string[] = []
    const off = onNotify((msg) => messages.push(msg))
    box.checked = true
    box.dispatchEvent(new Event('change'))
    await flush()
    off()

    expect(messages).toEqual([
      t('settings.plugins.toggleRefused', { msg: 'revoked: version 1.0.0 is no longer allowed' }),
    ])
    const after = document.querySelector<HTMLInputElement>('.plugin-row input[type="checkbox"]')
    expect(after?.checked).toBe(false)
  })
})
