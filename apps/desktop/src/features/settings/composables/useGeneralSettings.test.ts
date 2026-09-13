/**
 * The General section's model.
 *
 * `browseVault` is the only control that may change the vault, so its three
 * outcomes are worth pinning here as well as through the panel: a pick is handed
 * back for the runtime to commit, a cancel is silence, and a failure is a toast
 * — never a thrown dialog promise, and never a path written to storage by this
 * panel (persisting is the switcher's job, after `register_vault` commits).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { useGeneralSettings, type GeneralSettingsModel } from './useGeneralSettings'
import { useVaultSessionStore } from '../../../stores/vaultSession'
import { onNotify } from '../../../services/errors'

const mocks = vi.hoisted(() => ({ openFolderDialog: vi.fn() }))

vi.mock('../../../platform/gateways/fs', () => ({
  fsService: { openFolderDialog: mocks.openFolderDialog },
}))

const VAULT_LS_KEY = 'nekowite.vault'
let pinia: Pinia
let mounted: VueApp[] = []

function mountModel(): GeneralSettingsModel {
  let created: GeneralSettingsModel | null = null
  const app = createApp({
    setup() {
      created = useGeneralSettings()
      return () => null
    },
  })
  app.use(pinia)
  app.mount(document.createElement('div'))
  mounted.push(app)
  return created!
}

beforeEach(() => {
  localStorage.clear()
  pinia = createPinia()
  setActivePinia(pinia)
  mocks.openFolderDialog.mockReset().mockResolvedValue(null)
  mounted = []
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
})

describe('useGeneralSettings', () => {
  it('shows the open vault, trimmed', () => {
    const m = mountModel()
    expect(m.vaultPath.value).toBe('')

    useVaultSessionStore().vault = '  /notes/current  '
    expect(m.vaultPath.value).toBe('/notes/current')
  })

  it('hands back the folder the native picker returned, and stores nothing', async () => {
    const m = mountModel()
    mocks.openFolderDialog.mockResolvedValue('/picked/alfa')

    await expect(m.browseVault()).resolves.toBe('/picked/alfa')
    // A refused path must never be stored for the next launch to retry.
    expect(localStorage.getItem(VAULT_LS_KEY)).toBeNull()
  })

  it('returns null when the user cancels, without reporting anything', async () => {
    const m = mountModel()
    const messages: string[] = []
    const off = onNotify((msg) => messages.push(msg))
    mocks.openFolderDialog.mockResolvedValue(null)

    await expect(m.browseVault()).resolves.toBeNull()
    off()

    expect(messages).toEqual([])
  })

  it('reports a picker failure and resolves null instead of rejecting', async () => {
    const m = mountModel()
    const messages: string[] = []
    const off = onNotify((msg) => messages.push(msg))
    mocks.openFolderDialog.mockRejectedValue(new Error('dialog exploded'))

    await expect(m.browseVault()).resolves.toBeNull()
    off()

    expect(messages).toEqual([expect.stringContaining('dialog exploded')])
  })

  it('maps the language select onto the two supported locales', () => {
    const m = mountModel()

    m.onLocaleChange({ target: { value: 'en' } } as unknown as Event)
    expect(m.locale.value).toBe('en')

    // Anything else falls back to zh rather than leaving the app keyless.
    m.onLocaleChange({ target: { value: 'de' } } as unknown as Event)
    expect(m.locale.value).toBe('zh')
  })
})
