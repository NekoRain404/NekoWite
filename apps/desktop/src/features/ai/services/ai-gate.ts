/**
 * The gate every request and every write passes through.
 *
 * This is the only place the AI permission state is read, so "may the AI run,
 * and may it write" has one place to review. The policy itself is a pure
 * table in `services/aiPermissions.ts`; what lives here is the app-side
 * application of it — resolving the store, and the two questions the
 * lifecycles ask.
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
