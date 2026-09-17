/**
 * The master-password block: the state it draws, and the refusal it draws.
 *
 * `set_master_password` and `unlock_vault` were implemented, tested in Rust and named in the IPC
 * manifest, and no window could reach either (`docs/development-log.md:135`). This is the surface
 * they were built for, and what it has to get right is not "a password field exists" — it is that
 * the page is a *function of the vault's state*, and that a refusal arrives as the arm it happened
 * to be rather than as one sentence covering six.
 *
 * So the tests below are about differences:
 *
 * - the three states draw three different sentences and offer three different controls, and the
 *   change form is not drawn at all while the vault is locked (§5.2: 「不显示可点击但无效果的控件」)
 *   — `set_master_password` refuses in that state by design;
 * - `wrongPassword`, `noMasterPassword` and an unrecognised rejection produce three *different*
 *   sentences, because they are three different next moves;
 * - the password reaches the command and nothing else: not the rendered text, not storage, not an
 *   error toast, and not the next render after a success.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import VaultKeySettings from './VaultKeySettings.vue'
import { t, setLocale } from '../../../i18n'
import { onNotify } from '../../../services/errors'

const mocks = vi.hoisted(() => ({
  vaultStatus: vi.fn(),
  setMasterPassword: vi.fn(),
  unlockVault: vi.fn(),
}))

vi.mock('../../../platform/runtime/gateway-runtime', () => ({
  getSharedGateways: () => ({
    keys: {
      storeAiKey: vi.fn(),
      loadAiKey: vi.fn(),
      vaultStatus: mocks.vaultStatus,
      setMasterPassword: mocks.setMasterPassword,
      unlockVault: mocks.unlockVault,
    },
    ai: {},
    fs: {},
  }),
}))

const PASSWORD = 'correct horse battery staple'

let mounted: VueApp[] = []
let toasts: string[] = []
let stopNotifying: (() => void) | null = null

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  setLocale('zh')
  mocks.vaultStatus.mockReset().mockResolvedValue({ passwordSet: false, unlocked: true })
  mocks.setMasterPassword.mockReset().mockResolvedValue(undefined)
  mocks.unlockVault.mockReset().mockResolvedValue(undefined)
  toasts = []
  stopNotifying = onNotify((message) => toasts.push(message))
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
  stopNotifying?.()
  stopNotifying = null
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

async function mount(): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(VaultKeySettings)
  app.mount(host)
  mounted.push(app)
  await flush()
}

async function flush(): Promise<void> {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

function hook(name: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-test="${name}"]`)
}

function field(name: string): HTMLInputElement {
  const input = hook(name)
  if (!(input instanceof HTMLInputElement)) throw new Error(`no input at data-test="${name}"`)
  return input
}

async function type(name: string, value: string): Promise<void> {
  const input = field(name)
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

function submitButton(): HTMLButtonElement {
  const button = hook('vault-submit')
  if (!(button instanceof HTMLButtonElement)) throw new Error('no submit button')
  return button
}

/** The words above one field — the label the user reads before typing into it. */
function fieldLabel(name: string): string {
  return field(name).closest('label')?.querySelector('span')?.textContent?.trim() ?? ''
}

/** Every value `localStorage` holds, as one string — what a persisted password would turn up in. */
function storedValues(): string {
  return Array.from({ length: localStorage.length }, (_, i) =>
    localStorage.getItem(localStorage.key(i) ?? '') ?? '',
  ).join('\n')
}

describe('the vault state the block draws', () => {
  it('offers to set a password on a vault that has none, and says what that means', async () => {
    mocks.vaultStatus.mockResolvedValue({ passwordSet: false, unlocked: true })
    await mount()

    expect(hook('vault-state')?.textContent).toBe(t('aiSettings.vault.noPassword'))
    // The honest bound, on screen: without a password the key file opens the vault for anything
    // running as the user.
    expect(hook('vault-storage')?.textContent).toBe(t('aiSettings.vault.storagePlain'))
    // Setting asks twice — the confirm field is the setting path's.
    expect(field('vault-confirm')).toBeInstanceOf(HTMLInputElement)
    expect(submitButton().textContent?.trim()).toBe(t('aiSettings.vault.set'))
  })

  it('offers only the unlock on a locked vault, and states why the change is not there', async () => {
    mocks.vaultStatus.mockResolvedValue({ passwordSet: true, unlocked: false })
    await mount()

    expect(hook('vault-state')?.textContent).toBe(t('aiSettings.vault.locked'))
    expect(submitButton().textContent?.trim()).toBe(t('aiSettings.vault.unlock'))
    // §5.2: the change form cannot be honoured here — `set_master_password` refuses a locked
    // vault on purpose — so it is not drawn, and the reason it is not is on screen.
    expect(hook('vault-change-hint')?.textContent).toBe(t('aiSettings.vault.changeHint'))
    expect(document.querySelectorAll('[data-test="vault-confirm"]').length).toBe(0)
    // And the vault's own bound, rather than the passwordless one.
    expect(hook('vault-storage')?.textContent).toBe(t('aiSettings.vault.storagePassword'))
  })

  it('offers a change on a vault that is set and unlocked, and asks twice for it', async () => {
    mocks.vaultStatus.mockResolvedValue({ passwordSet: true, unlocked: true })
    await mount()

    expect(hook('vault-state')?.textContent).toBe(t('aiSettings.vault.unlocked'))
    expect(submitButton().textContent?.trim()).toBe(t('aiSettings.vault.change'))
    expect(field('vault-confirm')).toBeInstanceOf(HTMLInputElement)
    expect(hook('vault-change-hint')).toBeNull()
  })

  it('draws a failed state read as its own state, with no form to guess with', async () => {
    mocks.vaultStatus.mockRejectedValue('the master key file /x/master.key could not be read: EIO')
    await mount()

    const state = hook('vault-state')?.textContent ?? ''
    expect(state).toContain('EIO')
    expect(state).not.toBe(t('aiSettings.vault.noPassword'))
    // No control at all: there is no password that fixes an unreadable key file.
    expect(hook('vault-submit')).toBeNull()
    expect(hook('vault-password')).toBeNull()
  })
})

/**
 * Which password the two-field form is asking for.
 *
 * The form is drawn in two states — setting a first password, and changing one the vault is
 * already unlocked under — and in neither does it ask for the current password (`set_master_password`
 * is reached with only the new one). Its shape, though, is the conventional *change* form: two
 * fields, one above the other. A field labelled with the same words the unlock field uses therefore
 * reads as "current password", in the one state where the old password is deliberately not asked
 * for — a control claiming to be something it is not, which is §5.2's rule one layer down.
 *
 * These are sentence-level tests for a sentence-level defect: one per state that draws the two
 * fields, plus the state that draws one, so a rename in either direction has to say what it means.
 */
describe('the two-field form says which password it is for', () => {
  it('names both fields as the new password where the vault is unlocked and the password is changed', async () => {
    mocks.vaultStatus.mockResolvedValue({ passwordSet: true, unlocked: true })
    await mount()

    expect(fieldLabel('vault-password')).toBe(t('aiSettings.vault.newPassword'))
    expect(fieldLabel('vault-confirm')).toBe(t('aiSettings.vault.newConfirm'))
    // The words the unlock field uses, which this form must not borrow: they read as "the password
    // you already have", and this form is not asking for that.
    expect(fieldLabel('vault-password')).not.toBe(t('aiSettings.vault.password'))
  })

  it('names both fields as the new password where a first one is set', async () => {
    mocks.vaultStatus.mockResolvedValue({ passwordSet: false, unlocked: true })
    await mount()

    // The same words as the change state, and deliberately: the two are one form meaning one
    // thing — "the password this vault will have" — and a second spelling of it would be a
    // difference the user has to interpret.
    expect(fieldLabel('vault-password')).toBe(t('aiSettings.vault.newPassword'))
    expect(fieldLabel('vault-confirm')).toBe(t('aiSettings.vault.newConfirm'))
  })

  it('asks for the current password on a locked vault, and asks once', async () => {
    mocks.vaultStatus.mockResolvedValue({ passwordSet: true, unlocked: false })
    await mount()

    expect(fieldLabel('vault-password')).toBe(t('aiSettings.vault.password'))
    expect(fieldLabel('vault-password')).not.toBe(t('aiSettings.vault.newPassword'))
    // One field, so there is nothing to confirm and no confirm label to borrow.
    expect(hook('vault-confirm')).toBeNull()
  })
})

describe('a refusal keeps the arm it happened to be', () => {
  it('draws a wrong password as a wrong password', async () => {
    mocks.vaultStatus.mockResolvedValue({ passwordSet: true, unlocked: false })
    mocks.unlockVault.mockRejectedValue({
      code: 'wrongPassword',
      message: 'incorrect master password',
    })
    await mount()

    await type('vault-password', 'not the password')
    submitButton().click()
    await flush()

    expect(hook('vault-failure')?.textContent).toBe(t('aiSettings.vault.fail.wrongPassword'))
    // The three arms this one must not be confused with, named so the assertion is about the
    // difference rather than about one string.
    expect(hook('vault-failure')?.textContent).not.toBe(
      t('aiSettings.vault.fail.noMasterPassword'),
    )
    expect(hook('vault-failure')?.textContent).not.toBe(t('aiSettings.vault.fail.vaultLocked'))
    expect(hook('vault-failure')?.textContent).not.toBe(t('aiSettings.vault.fail.changeFailed'))
    // Still locked, so the state line and the control are unchanged.
    expect(submitButton().textContent?.trim()).toBe(t('aiSettings.vault.unlock'))
  })

  it('draws "there is no master password to unlock" as that, not as a failed attempt', async () => {
    mocks.vaultStatus.mockResolvedValue({ passwordSet: true, unlocked: false })
    mocks.unlockVault.mockRejectedValue({ code: 'noMasterPassword', message: 'no master password is set' })
    await mount()

    await type('vault-password', 'anything')
    submitButton().click()
    await flush()

    expect(hook('vault-failure')?.textContent).toBe(t('aiSettings.vault.fail.noMasterPassword'))
    expect(hook('vault-failure')?.textContent).not.toBe(t('aiSettings.vault.fail.wrongPassword'))
  })

  it('draws a rejection that is not a refusal as unreachable, not as one of the arms', async () => {
    mocks.vaultStatus.mockResolvedValue({ passwordSet: true, unlocked: false })
    // A build with no backend, or a renamed command: the call did not complete, which says
    // nothing about the vault and must not be drawn as "your password was wrong".
    mocks.unlockVault.mockRejectedValue(new Error('Command unlock_vault not found'))
    await mount()

    await type('vault-password', PASSWORD)
    submitButton().click()
    await flush()

    const failure = hook('vault-failure')?.textContent ?? ''
    expect(failure).toContain('Command unlock_vault not found')
    expect(failure).not.toBe(t('aiSettings.vault.fail.wrongPassword'))
    expect(failure).not.toBe(t('aiSettings.vault.fail.changeFailed'))
  })

  it('keeps the file’s own sentence for the arm that carries a path', async () => {
    mocks.vaultStatus.mockResolvedValue({ passwordSet: true, unlocked: false })
    mocks.unlockVault.mockRejectedValue({
      code: 'keyFilesUnreadable',
      message: 'the master key file /home/u/.nekowite/master.key is missing',
    })
    await mount()

    await type('vault-password', PASSWORD)
    submitButton().click()
    await flush()

    const failure = hook('vault-failure')?.textContent ?? ''
    expect(failure).toContain(t('aiSettings.vault.fail.keyFilesUnreadable'))
    // The backend's sentence is the only thing that names *which* file, so it is shown with it.
    expect(failure).toContain('/home/u/.nekowite/master.key')
  })
})

describe('the password reaches the command and nothing else', () => {
  it('sends what was typed, and leaves nothing of it behind', async () => {
    mocks.vaultStatus.mockResolvedValue({ passwordSet: false, unlocked: true })
    await mount()

    await type('vault-password', PASSWORD)
    await type('vault-confirm', PASSWORD)
    submitButton().click()
    await flush()

    expect(mocks.setMasterPassword).toHaveBeenCalledTimes(1)
    expect(mocks.setMasterPassword).toHaveBeenCalledWith(PASSWORD)

    // Cleared by the success, so the secret is not sitting in a live input for the rest of the
    // session or re-submitted by the next click.
    expect(field('vault-password').value).toBe('')
    expect(field('vault-confirm').value).toBe('')
    // Nothing on screen quotes it, and neither did the toast channel.
    expect(document.body.textContent ?? '').not.toContain(PASSWORD)
    expect(toasts.join('\n')).not.toContain(PASSWORD)
    // And nothing wrote it anywhere a restart could read back.
    expect(storedValues()).not.toContain(PASSWORD)
  })

  it('refuses a mismatch on the page rather than sending it', async () => {
    mocks.vaultStatus.mockResolvedValue({ passwordSet: false, unlocked: true })
    await mount()

    await type('vault-password', PASSWORD)
    await type('vault-confirm', `${PASSWORD} `)
    expect(hook('vault-mismatch')?.textContent).toBe(t('aiSettings.vault.mismatch'))
    expect(submitButton().disabled).toBe(true)

    submitButton().click()
    await flush()
    // Re-encrypting under an unchecked password is unrecoverable — `reencrypt_vault` deletes the
    // backup key when the swap commits — so the command must not be reached at all.
    expect(mocks.setMasterPassword).not.toHaveBeenCalled()
  })

  it('re-reads the vault after a command rather than trusting what was clicked', async () => {
    mocks.vaultStatus
      .mockResolvedValueOnce({ passwordSet: false, unlocked: true })
      .mockResolvedValue({ passwordSet: true, unlocked: true })
    await mount()

    await type('vault-password', PASSWORD)
    await type('vault-confirm', PASSWORD)
    submitButton().click()
    await flush()

    expect(mocks.vaultStatus).toHaveBeenCalledTimes(2)
    // The state line is the backend's new answer, not the form's assumption.
    expect(hook('vault-state')?.textContent).toBe(t('aiSettings.vault.unlocked'))
    expect(submitButton().textContent?.trim()).toBe(t('aiSettings.vault.change'))
  })

  it('keeps what was typed after a wrong password, so a typo can be fixed', async () => {
    mocks.vaultStatus.mockResolvedValue({ passwordSet: true, unlocked: false })
    mocks.unlockVault.mockRejectedValue({ code: 'wrongPassword', message: 'incorrect master password' })
    await mount()

    await type('vault-password', 'almoast right')
    submitButton().click()
    await flush()

    expect(field('vault-password').value).toBe('almoast right')
  })
})
