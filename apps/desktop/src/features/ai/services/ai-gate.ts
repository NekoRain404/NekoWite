/**
 * The app-side application of the AI permission policy, for the request and
 * write lifecycles that ask it.
 *
 * `aiDisabled` answers "may a request leave the app at all", `aiWritesForbidden`
 * "may a write land". The policy itself is the pure table in
 * `services/aiPermissions.ts`; what lives here is the bridge from that table to
 * the store, plus the announcement a refusal owes the user.
 *
 * This is NOT the only place the permission state is read, and the readers
 * outside split by the question they ask:
 *
 *   - the SAME policy question, answered off the store directly:
 *     `services/plugin-ai.ts` reads the master switch before a plugin
 *     completion, `services/plugin-editor-guard.ts` asks the table
 *     synchronously for the plugin writes it cannot await, and
 *     `composables/use-ghost-writer-shortcut.ts` asks both questions to decide
 *     whether Tab has anything to offer;
 *   - a DIFFERENT one: `services/ai-edit.ts`, `features/chat/composables/
 *     use-chat-commands.ts` and the two prompting paths in
 *     `plugin-editor-guard.ts` call the store's `ask`, which puts the question
 *     to the user instead of reading the policy; the settings surface
 *     (`features/settings/composables/use-ai-permission-settings.ts`) renders
 *     and writes the policy; and `App.vue` carries the pending question at app
 *     level and answers it.
 *
 * Routing those reads through here is a design change nobody has made yet (D6
 * in `docs/audits/2026-09-21-code-review.md`), so do not restate this module as
 * the one place to review: that claim has been falsified once already.
 *
 * A state that cannot be read is not the same as a state that forbids: see
 * `permissionState` below. That distinction is the difference between "AI is
 * off" and "we cannot tell", and it is deliberate in both directions.
 */

import { useAiPermissionStore } from '../../../stores/ai-permission'
import { decideAiWrite, isAiEnabled, type AiPermissionState } from '../../../services/ai-permissions'
import { announceAiBlockOnce } from '../../../services/ai-block-announce'
import { notifyError } from '../../../services/errors'
import { t } from '../../../i18n'

/**
 * The permission state, or null when there is no Pinia instance (a bare unit
 * test, a plugin host). Same rule the ghost writer's settings lookup uses: a
 * state we cannot read is not evidence that AI is switched off, so the feature
 * keeps working rather than dying silently.
 */
function permissionState(): AiPermissionState | null {
  try {
    return useAiPermissionStore().state
  } catch {
    return null
  }
}

/** True when the user switched AI off outright: no request may leave the app,
 *  which is the only thing that also stops the document being sent away. */
export function aiDisabled(): boolean {
  const state = permissionState()
  return state !== null && !isAiEnabled(state)
}

/** True when the user forbade AI writes. The ghost writer is a write path — the
 *  suggestion exists only to be accepted into the document — and it ships the
 *  text around the cursor to a provider, so under this policy there is nothing
 *  to offer and the request is not made at all. */
export function aiWritesForbidden(): boolean {
  const state = permissionState()
  if (state === null) return false
  return decideAiWrite(state, { kind: 'insert', summary: '' }) === 'deny'
}

export function announceBlock(reason: string, messageKey?: string): void {
  // The default wording covers the two reasons that mean "the request never
  // ran"; `accept` overrides it, because its block discards a suggestion that
  // was already fetched.
  const key = messageKey ?? (reason === 'disabled' ? 'aiperm.blockedDisabled' : 'aiperm.blockedReadonly')
  announceAiBlockOnce(reason, () => notifyError(t(key)))
}
