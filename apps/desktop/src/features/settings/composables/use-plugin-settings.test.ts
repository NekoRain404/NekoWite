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
import { onNotify } from '../../../services/errors'
import { t } from '../../../i18n'
import type { VaultPluginSummary } from '../../../features/plugins'

/** A listing whose switch file verified, which is the ordinary case: the rows a
 *  test is about, and the state that means the rows are the vault's own. */
function verified(rows: VaultPluginSummary[]) {
  return { rows, switches: 'verified' as const }
}

const mocks = vi.hoisted(() => ({
  readVaultPlugins: vi.fn(),
  setVaultPluginDisabled: vi.fn(),
  isPluginImportAllowedByCsp: vi.fn(() => true),
}))

// The feature entry point, not the `services/plugins` shim: this composable was
// one of the three callers the shim's own doc names as un-migrated, and it reads
// the listing (rows *and* the switch file's state) now.
vi.mock('../../../features/plugins', () => ({
  readVaultPlugins: mocks.readVaultPlugins,
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
  mocks.readVaultPlugins.mockReset().mockResolvedValue(verified([ALFA]))
  // The switch answers with what the app holds and what the file said; the
  // ordinary case is "applied, and the file took it".
  mocks.setVaultPluginDisabled
    .mockReset()
    .mockResolvedValue({ disabled: true, refused: null, saved: 'saved' })
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

    expect(mocks.readVaultPlugins).toHaveBeenCalledWith('/vault')
    expect(m.rows.value).toEqual([ALFA])
    expect(m.loading.value).toBe(false)
  })

  it('lists nothing without a vault rather than reading an empty path', async () => {
    const m = await mountModel()

    expect(mocks.readVaultPlugins).not.toHaveBeenCalled()
    expect(m.rows.value).toEqual([])
    // No vault means no file was read, which is what `absent` says: the section
    // must not warn about a file it never looked for.
    expect(m.switches.value).toBe('absent')
  })

  it('carries what the vault’s switch file could be established as', async () => {
    // The rows come out of the in-memory record, so with a file that could not be
    // verified they are this session's belief. The model has to surface that, or
    // the panel draws switches it cannot vouch for.
    useVaultSessionStore().vault = '/vault'
    mocks.readVaultPlugins.mockResolvedValue({ rows: [ALFA], switches: 'tampered' })
    const m = await mountModel()

    expect(m.switches.value).toBe('tampered')
    // And the rows are still the rows: the notice explains them, it does not
    // replace them.
    expect(m.rows.value).toEqual([ALFA])
  })

  it('reports a verified file as verified, so nothing is warned about', async () => {
    useVaultSessionStore().vault = '/vault'
    const m = await mountModel()

    expect(m.switches.value).toBe('verified')
  })

  it('shows an empty list when the read fails, not a stale one — and says that is what happened', async () => {
    // "This library has no plugins" and "the folder could not be read" are two
    // different states, and the user's remedy differs completely: one is
    // "install a plugin", the other is "fix what is hiding the folder". A flag
    // is what lets the section tell them apart; the toast carries the reason.
    useVaultSessionStore().vault = '/vault'
    const messages: string[] = []
    const off = onNotify((msg) => messages.push(msg))
    mocks.readVaultPlugins.mockRejectedValue(new Error('EACCES: permission denied'))
    const m = await mountModel()
    off()

    expect(m.rows.value).toEqual([])
    expect(m.loading.value).toBe(false)
    expect(m.loadFailed.value).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('EACCES')
  })

  it('clears the failure once a read succeeds', async () => {
    useVaultSessionStore().vault = '/vault'
    mocks.readVaultPlugins.mockRejectedValue(new Error('unreadable'))
    const m = await mountModel()
    expect(m.loadFailed.value).toBe(true)

    mocks.readVaultPlugins.mockResolvedValue(verified([ALFA]))
    await m.refreshPluginRows()

    expect(m.loadFailed.value).toBe(false)
    expect(m.rows.value).toEqual([ALFA])
  })

  it('re-reads after a toggle, so the row reports the outcome and not the click', async () => {
    useVaultSessionStore().vault = '/vault'
    const m = await mountModel()
    mocks.readVaultPlugins.mockResolvedValue(verified([{ ...ALFA, disabled: true, active: false }]))

    await m.togglePlugin(ALFA, false)

    expect(mocks.setVaultPluginDisabled).toHaveBeenCalledWith('alfa', true, { vault: '/vault' })
    expect(mocks.readVaultPlugins).toHaveBeenCalledTimes(2)
    expect(m.rows.value[0]!.disabled).toBe(true)
  })

  it('says why a switch that was put back did not take effect', async () => {
    // A reload that refuses the plugin leaves the record disabled, so the row
    // would only show that the switch did not move. The reason is the one thing
    // the row cannot read for itself.
    useVaultSessionStore().vault = '/vault'
    const m = await mountModel()
    const messages: string[] = []
    const off = onNotify((msg) => messages.push(msg))
    mocks.setVaultPluginDisabled.mockResolvedValue({
      disabled: true,
      refused: 'integrity check failed: the plugin changed since you approved it',
      saved: 'saved',
    })

    await m.togglePlugin(ALFA, true)
    off()

    expect(messages).toEqual([
      t('settings.plugins.toggleRefused', {
        msg: 'integrity check failed: the plugin changed since you approved it',
      }),
    ])
    // Still re-read: the record is the answer to "did it move", the sentence is not.
    expect(mocks.readVaultPlugins).toHaveBeenCalledTimes(2)
  })

  it('says the decision is only for this session when the file did not take it', async () => {
    useVaultSessionStore().vault = '/vault'
    const m = await mountModel()
    const messages: string[] = []
    const off = onNotify((msg) => messages.push(msg))
    mocks.setVaultPluginDisabled.mockResolvedValue({ disabled: true, refused: null, saved: 'failed' })

    await m.togglePlugin(ALFA, false)
    off()

    expect(messages).toEqual([t('settings.plugins.toggleNotSaved')])
  })

  it('says nothing was written when the library’s file could not be verified', async () => {
    useVaultSessionStore().vault = '/vault'
    const m = await mountModel()
    const messages: string[] = []
    const off = onNotify((msg) => messages.push(msg))
    mocks.setVaultPluginDisabled.mockResolvedValue({
      disabled: true,
      refused: null,
      saved: 'tampered',
    })

    await m.togglePlugin(ALFA, false)
    off()

    expect(messages).toEqual([t('settings.plugins.toggleTampered')])
  })

  it('stays quiet when the switch was applied and the file took it', async () => {
    useVaultSessionStore().vault = '/vault'
    const m = await mountModel()
    const messages: string[] = []
    const off = onNotify((msg) => messages.push(msg))
    mocks.setVaultPluginDisabled.mockResolvedValue({ disabled: true, refused: null, saved: 'saved' })

    await m.togglePlugin(ALFA, false)
    off()

    expect(messages).toEqual([])
  })
})
