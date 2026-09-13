import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  AI_WRITE_POLICIES,
  DEFAULT_AI_PERMISSION,
  decideAiWrite,
  grantForSession,
  revokeAllGrants,
  type AiPermissionState,
  type AiWritePolicy,
  type AiWriteRequest,
} from '../services/aiPermissions'
import { persistence } from '../services/persistence'

const LS_AI_WRITE_POLICY = 'nekowite.ai.writePolicy'
/** The master switch. Stored as '0'/'1'; anything else (including no value at
 *  all) means on, so an install that predates the switch keeps its AI. */
const LS_AI_ENABLED = 'nekowite.ai.enabled'

/**
 * The write-permission state for AI edits, plus the pending-approval queue the
 * prompt renders.
 *
 * The policy is a user setting and persists; the session grants deliberately do
 * NOT. A grant means "for this sitting", so restarting the app returns to the
 * configured policy rather than silently inheriting a permission the user gave
 * in a different context.
 *
 * `ask()` is the single entry point every AI write goes through: it returns a
 * boolean and only resolves once the question (if any) is answered, so callers
 * cannot accidentally treat "not decided yet" as approval.
 *
 * `enabled` is the master switch from the same settings block. It is checked
 * first by `decideAiWrite`, so switching AI off refuses every kind of write
 * without touching the policy the user configured — turning it back on restores
 * exactly what they had. The AI features that only READ (the ghost writer's
 * Tab, chat, the plugin AI adapter) consult it separately, so off means no
 * request leaves the app either.
 */

/** One question waiting for the user. `resolve` is called exactly once. */
export interface PendingAiWrite {
  request: AiWriteRequest
  resolve(approved: boolean): void
}

function readEnabled(): boolean {
  // Only '0' is off: an absent key is an install from before the switch.
  return persistence.get(LS_AI_ENABLED) !== '0'
}

function readPolicy(): AiWritePolicy {
  const raw = persistence.get(LS_AI_WRITE_POLICY)
  return (AI_WRITE_POLICIES as readonly string[]).includes(raw ?? '')
    ? (raw as AiWritePolicy)
    : DEFAULT_AI_PERMISSION.policy
}

export const useAiPermissionStore = defineStore('aiPermission', () => {
  const policy = ref<AiWritePolicy>(readPolicy())
  const enabled = ref<boolean>(readEnabled())
  // Session-only: rebuilt empty on every launch (see the module comment).
  const sessionGrants = ref<ReadonlySet<string>>(new Set())
  const pending = ref<PendingAiWrite | null>(null)

  const state = computed<AiPermissionState>(() => ({
    policy: policy.value,
    sessionGrants: sessionGrants.value,
    enabled: enabled.value,
  }))

  /** True when an approval question is on screen (the shell renders it). */
  const awaitingApproval = computed<boolean>(() => pending.value !== null)

  function setPolicy(next: AiWritePolicy): void {
    if (!(AI_WRITE_POLICIES as readonly string[]).includes(next)) return
    policy.value = next
    persistence.set(LS_AI_WRITE_POLICY, next)
  }

  /** Switch every AI feature on or off. Effects the policy itself cannot
   *  express: with AI off, no completion request is made at all, so nothing in
   *  the document is sent to a provider, and every write is refused. */
  function setEnabled(next: boolean): void {
    enabled.value = next
    persistence.set(LS_AI_ENABLED, next ? '1' : '0')
  }

  /** Drop the session grants without touching the policy: the user's
   *  "stop trusting the AI for now" reset. */
  function forgetGrants(): void {
    sessionGrants.value = revokeAllGrants(state.value).sessionGrants
  }

  function grant(request: AiWriteRequest): void {
    sessionGrants.value = grantForSession(state.value, request).sessionGrants
  }

  /** Answer the on-screen question. A no-op when nothing is pending, so a
   *  double-click on an action button cannot resolve twice. */
  function respond(approved: boolean, rememberForSession = false): void {
    const current = pending.value
    if (!current) return
    pending.value = null
    if (approved && rememberForSession) grant(current.request)
    current.resolve(approved)
  }

  /**
   * Whether the AI may perform `request` now. `ask` policy shows the prompt and
   * waits; every other answer resolves immediately.
   */
  function ask(request: AiWriteRequest): Promise<boolean> {
    const decision = decideAiWrite(state.value, request)
    if (decision === 'allow') return Promise.resolve(true)
    if (decision === 'deny') return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      // A second question while one is on screen would leave the first promise
      // pending forever (nothing can answer it), which would hang the write it
      // gates. Deny the newcomer instead: the user is asked one thing at a time.
      if (pending.value) {
        resolve(false)
        return
      }
      pending.value = { request, resolve }
    })
  }

  return {
    policy,
    enabled,
    sessionGrants,
    pending,
    /** The snapshot `decideAiWrite` takes. Exposed so callers that must decide
     *  synchronously (the plugin editor guard's un-awaitable writes) use the
     *  same pure table as `ask()` instead of a second copy of the rules. */
    state,
    awaitingApproval,
    setPolicy,
    setEnabled,
    forgetGrants,
    respond,
    ask,
  }
})
