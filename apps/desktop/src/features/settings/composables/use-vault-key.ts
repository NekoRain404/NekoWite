/**
 * The key vault's master password: which state it is in, and the two commands that change it.
 *
 * ## Why this is not part of the settings store
 *
 * Every other section of this dialog reads the Pinia store, whose slices persist their refs to
 * `localStorage` through a watcher. A password must not be one of them. So the two password fields
 * are plain refs created here, held by the component that renders them, watched by nothing, and
 * gone with the component — there is no code path from either of them to disk, and none to
 * `localStorage`, and adding one would mean putting them in the store, which this module does not
 * import. What *is* shared state is the vault's status and the last refusal, and those are per
 * mount on purpose too: they are a read of the backend rather than a preference, and a cached copy
 * surviving a section switch would be a page describing a vault that may have moved.
 *
 * ## Why a refusal keeps its arm
 *
 * `unlock_vault` can be refused for six different reasons and they are six different next moves —
 * retype the password, set one because there is none, unlock before changing, look at the key
 * files, or try again because the change did not go through. The backend answers with a `code` and
 * a `message` and this module carries both, so the component can say which one it was instead of
 * one sentence that sends every user at the password field. A rejection that is *not* one of those
 * codes did not come from the command at all — no backend, a renamed command — and that is the
 * `unreachable` arm rather than a refusal, the same division `agent-profile-ipc.ts` draws for the
 * same wire.
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { getSharedGateways } from '../../../platform/runtime/gateway-runtime'
import type { VaultFailureCode, VaultKeyStatus } from '../../../platform/gateways/contracts'

/** Every arm `VaultCommandError` can answer with, as a literal list so a new one is loud. */
export const VAULT_FAILURE_CODES: readonly VaultFailureCode[] = [
  'noMasterPassword',
  'wrongPassword',
  'vaultLocked',
  'emptyPassword',
  'keyFilesUnreadable',
  'changeFailed',
]

/**
 * What went wrong, in the two channels the window has to tell apart.
 *
 * `refused` is a command that ran and said no, and its `code` is the backend's own arm.
 * `unreachable` is a call that did not complete — no backend in this build, or a command this
 * window no longer knows — which says nothing about the vault and must not be drawn as if it did.
 */
export type VaultFailure =
  | { kind: 'refused'; code: VaultFailureCode; message: string }
  | { kind: 'unreachable'; message: string }

/**
 * The refusal in `error`, as one of the two channels.
 *
 * The shape is *probed* rather than cast: `String(e)` on a structured rejection yields
 * `[object Object]` and throws away the sentence, and a code this build does not know is not one
 * of its arms — so an answer that is not a `VaultCommandError` is `unreachable` and keeps whatever
 * text it arrived with.
 */
export function vaultFailure(error: unknown): VaultFailure {
  const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null
  const code = record?.['code']
  if (typeof code === 'string' && (VAULT_FAILURE_CODES as readonly string[]).includes(code)) {
    const message = record?.['message']
    return { kind: 'refused', code: code as VaultFailureCode, message: typeof message === 'string' ? message : '' }
  }
  return { kind: 'unreachable', message: failureText(error) }
}

/** The text of a rejection that is not a refusal — the backend's sentence, or the string itself. */
function failureText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return String(error)
}

export interface VaultKeyModel {
  /** The vault's state, or `null` until the read has answered. */
  status: Ref<VaultKeyStatus | null>
  /** The read itself failed — the key files could not be read. A state the page draws on its own. */
  statusError: Ref<string | null>
  passwordSet: ComputedRef<boolean>
  unlocked: ComputedRef<boolean>
  /** The read has not answered yet: the two controls must not be offered on a guess. */
  reading: ComputedRef<boolean>
  /** How the last attempt was refused, or `null` when it was not. */
  failure: Ref<VaultFailure | null>
  /** A command is in flight. */
  busy: Ref<boolean>
  /**
   * The typed password, and its confirmation.
   *
   * Held here and nowhere else — no store, no persistence, no watcher — and cleared as soon as the
   * command they were typed for answers `Ok`. A refusal leaves them, because the one refusal the
   * user can act on by typing is a mistyped password.
   */
  password: Ref<string>
  confirm: Ref<string>
  /**
   * Which of the two forms this is: `true` when a password is set and has not been entered yet, so
   * the only thing to do with the field is unlock with it.
   *
   * Everything else — no password at all, or a password that is already unlocked — is the *other*
   * form, which asks twice. Not a detail of drawing: the confirm field exists exactly where
   * submitting re-encrypts the vault, and being wrong about which form this is means either asking
   * for a confirmation that has nothing to confirm or, far worse, re-encrypting under a password
   * nobody checked.
   */
  unlockMode: ComputedRef<boolean>
  /** The confirmation is filled in and different. Drives the sentence, not a disabled button. */
  mismatch: ComputedRef<boolean>
  /** Whether the form can be submitted at all: something typed, and (when setting) confirmed. */
  ready: ComputedRef<boolean>
  refresh: () => Promise<void>
  setPassword: () => Promise<void>
  unlock: () => Promise<void>
}

/**
 * State and commands for the master-password block.
 *
 * `confirmRequired` is the caller's answer to "is this a set or a change", because it is what the
 * form *is* rather than what the vault is: unlocking asks for the password that already exists and
 * there is nothing to confirm, while setting one re-encrypts the vault under whatever was typed.
 * A mistyped password there is not a retry — `reencrypt_vault` deletes the backup key when the
 * swap commits, so the stored provider keys become unreadable for good — which is why the
 * confirmation is not optional on that path.
 */
export function useVaultKey(): VaultKeyModel {
  const status = ref<VaultKeyStatus | null>(null)
  const statusError = ref<string | null>(null)
  const failure = ref<VaultFailure | null>(null)
  const busy = ref(false)
  const password = ref('')
  const confirm = ref('')

  const passwordSet = computed(() => status.value?.passwordSet === true)
  const unlocked = computed(() => status.value?.unlocked === true)
  const reading = computed(() => status.value === null && statusError.value === null)
  const unlockMode = computed(() => passwordSet.value && !unlocked.value)
  const mismatch = computed(
    () => !unlockMode.value && confirm.value.length > 0 && password.value !== confirm.value,
  )
  const ready = computed(
    () =>
      password.value.trim().length > 0 &&
      (unlockMode.value || (confirm.value.length > 0 && password.value === confirm.value)),
  )

  async function refresh(): Promise<void> {
    statusError.value = null
    try {
      status.value = await getSharedGateways().keys.vaultStatus()
    } catch (e) {
      // A read that failed is not a state: the block says the key files could not be read rather
      // than picking one of the three to guess at.
      status.value = null
      statusError.value = failureText(e)
    }
  }

  /** Run one of the two commands, then re-read: the answer is what the vault now is, not what
   *  the call returned. */
  async function run(command: () => Promise<void>): Promise<void> {
    if (busy.value) return
    busy.value = true
    failure.value = null
    let ok = false
    try {
      await command()
      ok = true
    } catch (e) {
      failure.value = vaultFailure(e)
    } finally {
      busy.value = false
    }
    if (ok) {
      password.value = ''
      confirm.value = ''
    }
    await refresh()
  }

  return {
    status,
    statusError,
    passwordSet,
    unlocked,
    reading,
    failure,
    busy,
    password,
    confirm,
    unlockMode,
    mismatch,
    ready,
    refresh,
    // The password goes to the command as typed: the backend derives the key from the bytes it is
    // given and trims only to decide whether there is one, so a trimmed copy here would be a
    // different password from the one the user will type next time.
    setPassword: () => run(() => getSharedGateways().keys.setMasterPassword(password.value)),
    unlock: () => run(() => getSharedGateways().keys.unlockVault(password.value)),
  }
}
