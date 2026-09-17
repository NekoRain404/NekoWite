<script setup lang="ts">
/**
 * The master password: what state the key vault is in, and the one control that state calls for.
 *
 * This is the surface `set_master_password` and `unlock_vault` were built for and never had. Both
 * commands existed, were tested in Rust, and were named in `build.rs`'s manifest and in
 * `capabilities/default.json` — and no window could reach either, so a user could store a provider
 * key (the section above this one) and could never set the password that protects it, nor enter it
 * on the machine where it had been set. `docs/PRIVACY.md:46` is where that was visible from
 * outside: it tells the reader 「当前版本还没有设置主密码的界面」.
 *
 * ## Why it is a block in the AI section rather than a section of its own
 *
 * The sentence directly above it — `aiSettings.keyNote`, "Keys are encrypted and protected by your
 * master password (local)" — is a claim about this control. It was written when there was no way
 * to set one, which made it a claim the page could not honour. The vault holds *provider
 * credentials* and guards nothing else in this app (`docs/SECURITY.md:147`: 「主密码不是完整的应用锁。
 * 它保护 stronghold 金库，而不是 OS/用户会话」), so the page that owns the keys is the page that
 * owns the password, and a `security` section in the rail would be a second front door onto one
 * file.
 *
 * ## What it draws, and why each state is drawn the way it is
 *
 * The vault is in one of three states and the block says which, then offers exactly the control
 * for it. §5.2's rule — 「不可用选项说明原因，不显示可点击但无效果的控件」 — is why the block never
 * shows a disabled change-password form: while the vault is locked, `set_master_password` refuses
 * by design (its own message sends the caller to `unlock_vault` first), so the form for it is not
 * drawn and the sentence says where it went. The read can also fail on its own, and that is a
 * fourth thing on screen rather than a state guessed at.
 *
 * ## The password
 *
 * Two `<input type="password">` bound to refs created by `useVaultKey` — component state, in no
 * store, watched by nothing, written nowhere. They are cleared the moment a command answers `Ok`,
 * and nothing on this page ever renders them back: the state sentence is built from the two
 * booleans the backend answers with, never from what was typed. A refusal is shown by its `code`,
 * and the backend builds none of its sentences from the password (`commands/key_vault.rs`).
 */
import { computed, onMounted } from 'vue'
import { t } from '../../../i18n'
import type { VaultFailureCode } from '../../../platform/gateways/contracts'
import { useVaultKey } from '../composables/use-vault-key'

const {
  statusError,
  passwordSet,
  reading,
  failure,
  busy,
  password,
  confirm,
  unlockMode,
  mismatch,
  ready,
  refresh,
  setPassword,
  unlock,
} = useVaultKey()

onMounted(() => {
  // Read once, on mount. The panel mounts a section at a time, so this is one call per visit to
  // the AI section — the vault's state is not something to poll, and a cached copy carried across
  // a switch would be this page describing a vault that has since moved.
  void refresh()
})

/**
 * Which state the vault is in, in one sentence.
 *
 * `passwordSet` and `unlockMode` are read off the backend's answer rather than inferred from
 * anything on this page: a vault whose password is set but not entered and a vault with no
 * password at all look identical from the field, which is empty in both.
 */
const stateSentence = computed(() => {
  if (reading.value) return t('aiSettings.vault.reading')
  if (statusError.value !== null) return t('aiSettings.vault.unreadable', { msg: statusError.value })
  if (unlockMode.value) return t('aiSettings.vault.locked')
  if (passwordSet.value) return t('aiSettings.vault.unlocked')
  return t('aiSettings.vault.noPassword')
})

/**
 * One sentence per arm, because they are six different next moves.
 *
 * A map of literal keys rather than a `t()` call at each use site: the arms belong to the backend
 * (`VaultCommandError`), and a code added there without a sentence here is a missing key rather
 * than a line that goes blank — the same shape `AgentProviderLabels.changes` uses for the same
 * reason.
 */
const FAILURE_KEYS: Record<VaultFailureCode, string> = {
  noMasterPassword: 'aiSettings.vault.fail.noMasterPassword',
  wrongPassword: 'aiSettings.vault.fail.wrongPassword',
  vaultLocked: 'aiSettings.vault.fail.vaultLocked',
  emptyPassword: 'aiSettings.vault.fail.emptyPassword',
  keyFilesUnreadable: 'aiSettings.vault.fail.keyFilesUnreadable',
  changeFailed: 'aiSettings.vault.fail.changeFailed',
}

/**
 * The arms whose backend sentence is shown as well as the page's own.
 *
 * Three of the six carry a fact the copy cannot: the file that could not be read, the storage
 * error a change died on, and whatever a build with no backend answered. The other three are
 * `wrongPassword`, `noMasterPassword` and `emptyPassword` — where the backend's sentence is the
 * same fact the page has already stated, or (for `vaultLocked`) an instruction addressed to a
 * caller, "call unlock_vault with the CURRENT password", which is not something to put in front of
 * a user. Showing it there would be noise dressed as diagnosis.
 */
const FAILURE_DETAIL: ReadonlySet<VaultFailureCode> = new Set<VaultFailureCode>([
  'keyFilesUnreadable',
  'changeFailed',
])

const failureSentence = computed(() => {
  const refused = failure.value
  if (refused === null) return null
  if (refused.kind === 'unreachable') {
    return t('aiSettings.vault.fail.unreachable', { msg: refused.message })
  }
  const sentence = t(FAILURE_KEYS[refused.code])
  return FAILURE_DETAIL.has(refused.code) && refused.message
    ? `${sentence} ${refused.message}`
    : sentence
})

/** What the submit button says: the two forms are two different commands. */
const submitLabel = computed(() =>
  unlockMode.value
    ? t('aiSettings.vault.unlock')
    : passwordSet.value
      ? t('aiSettings.vault.change')
      : t('aiSettings.vault.set'),
)

const submit = computed(() => (unlockMode.value ? unlock : setPassword))
</script>

<template>
  <div class="vault-key">
    <span class="settings-label">{{ t('aiSettings.vault.title') }}</span>
    <span
      class="settings-note"
      data-test="vault-state"
    >{{ stateSentence }}</span>

    <!-- The read failed: the key files are the problem and no password fixes it, so no form is
         drawn. `stateSentence` already carries the reason. -->
    <template v-if="statusError === null && !reading">
      <!-- Which password this field is for is the whole of what its label has to say, and it is
           two different answers. Unlocking asks for the one the vault already has; the two-field
           form below asks for the one it will have (`set_master_password` is reached with only
           that one). A single label for both would put the words of a *current*-password prompt on
           a field where the current password is deliberately not asked for — the form's shape
           already reads as the conventional change form, so the words are the only thing that can
           tell the two apart. -->
      <label class="settings-field">
        <span v-if="unlockMode">{{ t('aiSettings.vault.password') }}</span>
        <span v-else>{{ t('aiSettings.vault.newPassword') }}</span>
        <input
          v-model="password"
          class="input"
          type="password"
          :autocomplete="unlockMode ? 'current-password' : 'new-password'"
          spellcheck="false"
          data-test="vault-password"
          @keyup.enter="ready && !busy && submit()"
        >
      </label>
      <label
        v-if="!unlockMode"
        class="settings-field"
      >
        <span>{{ t('aiSettings.vault.newConfirm') }}</span>
        <input
          v-model="confirm"
          class="input"
          type="password"
          autocomplete="new-password"
          spellcheck="false"
          data-test="vault-confirm"
          @keyup.enter="ready && !busy && submit()"
        >
      </label>
      <span
        v-if="mismatch"
        class="settings-note is-warn"
        data-test="vault-mismatch"
      >{{ t('aiSettings.vault.mismatch') }}</span>
      <button
        class="btn btn-secondary vault-submit"
        :disabled="busy || !ready"
        data-test="vault-submit"
        @click="submit"
      >
        {{ submitLabel }}
      </button>
      <!-- §5.2, stated: the change is not offered while the vault is locked, and this is why. -->
      <span
        v-if="unlockMode"
        class="settings-note"
        data-test="vault-change-hint"
      >{{ t('aiSettings.vault.changeHint') }}</span>
    </template>

    <span
      v-if="failureSentence !== null"
      class="settings-note is-error"
      data-test="vault-failure"
    >{{ failureSentence }}</span>
    <span
      class="settings-note"
      :class="{ 'is-warn': !passwordSet }"
      data-test="vault-storage"
    >{{ passwordSet ? t('aiSettings.vault.storagePassword') : t('aiSettings.vault.storagePlain') }}</span>
  </div>
</template>

<style scoped>
/* `.settings-label`, `.settings-field` and `.settings-note` are restated in each section that
   renders them, for the reason `AiSettings.vue` gives: a scoped block belongs to the component
   that renders the element. */
.vault-key {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--app-border) 70%, transparent);
}
.settings-label {
  margin-top: 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--app-muted);
}
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--app-text); }
.settings-field > span { color: var(--app-muted); font-size: 11px; }
.settings-note { font-size: 11px; line-height: 1.5; color: var(--app-muted); }
.settings-note.is-warn { color: var(--app-warn); }
.settings-note.is-error { color: var(--app-danger); }
.vault-submit { align-self: flex-start; }
</style>
