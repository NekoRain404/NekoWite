import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import SettingsPanel from './SettingsPanel.vue'
import { setLocale } from '../../../i18n'
import { fsService } from '../../../platform/gateways/fs'
import { onNotify } from '../../../services/errors'
import { useVaultSessionStore } from '../../../stores/vaultSession'

/**
 * The vault field is a read-only display of the vault that is open.
 *
 * `register_vault` (Rust) only accepts a root the user chose in the native
 * folder dialog this session, or the root the backend recorded last time. A
 * path typed into the settings panel is neither, so the old free-text field
 * ended in a guaranteed refusal: the user typed a path, saved, and the app
 * refused it. These tests pin the field to display-only and keep Browse — the
 * native picker — as the one control that switches the vault.
 */

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const VAULT_LS_KEY = 'nekowite.vault'
let mounted: VueApp[] = []

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  localStorage.clear()
  setLocale('zh')
  setActivePinia(createPinia())
  globalThis.matchMedia = vi.fn(() => ({
    matches: false,
    media: '(prefers-color-scheme: dark)',
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
  vi.restoreAllMocks()
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

function mountPanel(onSaved: () => void = vi.fn()): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(SettingsPanel, { onClose: vi.fn(), onSaved } as never)
  app.mount(host)
  mounted.push(app)
}

/** Let async work started by a click (the dialog promise, the emit) settle. */
async function settle(): Promise<void> {
  await nextTick()
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

function vaultField(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('.vault-row input')
  if (!input) throw new Error('vault field missing')
  return input
}

function browseButton(): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>('.vault-browse')
  if (!btn) throw new Error('browse button missing')
  return btn
}

describe('SettingsPanel vault field', () => {
  it('displays the open vault read-only, so a typed path cannot be committed', async () => {
    const saved = vi.fn()
    const session = useVaultSessionStore()
    session.vault = '/notes/current'
    mountPanel(saved)
    await settle()

    const field = vaultField()
    expect(field.value).toBe('/notes/current')
    // The mechanism that stops typing: the field is not an editor.
    expect(field.readOnly).toBe(true)

    // The old symptom, reproduced: type a path, press Enter. That path used to
    // be persisted and handed to the vault switch, which the backend refuses.
    field.value = '/typed/elsewhere'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    field.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
    await settle()

    expect(saved).not.toHaveBeenCalled()
    expect(localStorage.getItem(VAULT_LS_KEY)).toBeNull()
  })

  it('ignores a path left in storage by an older build', async () => {
    const saved = vi.fn()
    const session = useVaultSessionStore()
    session.vault = '/notes/current'
    // A path left behind by an older build's free-text field. Nothing in this
    // panel may pick it up and commit it: the backend refuses it exactly as it
    // refused the typed path that wrote it.
    localStorage.setItem(VAULT_LS_KEY, '/typed/elsewhere')
    mountPanel(saved)
    await settle()

    // The field shows the vault that is open, not the leftover string.
    expect(vaultField().value).toBe('/notes/current')

    // And no other control in the section can raise a switch with it — the
    // "save and switch" button that used to re-commit the field is gone, so
    // Browse (fed by the native picker) is the single vault control.
    const section = document.querySelector<HTMLElement>('.settings-section')!
    const buttons = [...section.querySelectorAll<HTMLButtonElement>('button')]
    const browse = buttons.filter((b) => b.classList.contains('vault-browse'))
    buttons.filter((b) => !b.classList.contains('vault-browse')).forEach((b) => b.click())
    await settle()

    expect(browse).toHaveLength(1)
    expect(saved).not.toHaveBeenCalled()
  })

  it('switches to the folder the native picker returns, and lets the runtime persist it', async () => {
    const saved = vi.fn()
    const pick = vi.spyOn(fsService, 'openFolderDialog').mockResolvedValue('/picked/alfa')
    const session = useVaultSessionStore()
    session.vault = '/notes/current'
    mountPanel(saved)
    await settle()

    browseButton().click()
    await settle()

    expect(pick).toHaveBeenCalledTimes(1)
    expect(saved).toHaveBeenCalledWith('/picked/alfa')
    // Persistence belongs to the switch itself (the runtime writes the path
    // only once `register_vault` commits), so a refused path is never stored
    // for the next launch to retry.
    expect(localStorage.getItem(VAULT_LS_KEY)).toBeNull()
  })

  it('follows the committed vault once the switch lands', async () => {
    const session = useVaultSessionStore()
    session.vault = '/notes/current'
    mountPanel()
    await settle()
    expect(vaultField().value).toBe('/notes/current')

    vi.spyOn(fsService, 'openFolderDialog').mockResolvedValue('/picked/alfa')
    browseButton().click()
    await settle()
    // The runtime commits by setting the session vault; the display tracks it.
    session.vault = '/picked/alfa'
    await settle()

    expect(vaultField().value).toBe('/picked/alfa')
  })

  it('keeps the failure toast when the picker itself fails', async () => {
    const messages: string[] = []
    const off = onNotify((m) => messages.push(m))
    vi.spyOn(fsService, 'openFolderDialog').mockRejectedValue(new Error('dialog exploded'))
    mountPanel()
    await settle()

    browseButton().click()
    await settle()
    off()

    expect(messages).toEqual([expect.stringContaining('dialog exploded')])
  })
})
