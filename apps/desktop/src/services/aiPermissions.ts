/**
 * Write-permission policy for AI edits to the user's document.
 *
 * An AI answer only helps if it can land in the document, but the document is
 * the user's work: an unwanted insert is noise, and replacing a selection
 * destroys text they already wrote. A prompt per action is not the answer
 * either — completions stream, and a dialog on every chunk trains the user to
 * click "allow" without reading. So the decision comes from what the user
 * chose in settings, plus — under 'ask' — a grant for the *kind* of write
 * given for the rest of the session.
 *
 * Grants are keyed by kind, never by text or target: the text differs on every
 * request (such a key could never match twice), and approving an insert must
 * not approve a selection replacement. `decideAiWrite` treats anything it does
 * not recognise as 'ask', because state read back from an older persisted blob
 * must never be the reason a write into the user's document is allowed.
 *
 * Deliberately dependency-free (no store, no Tauri): the policy is a pure
 * function of `AiPermissionState`, so the whole decision table is testable.
 */

/** How much latitude the user has given the AI over the document: 'ask'
 *  prompts per kind of write until granted for the session, 'auto' writes
 *  without prompting, and 'readonly' never writes. */
export type AiWritePolicy = 'ask' | 'auto' | 'readonly'

/** The document mutations the AI can perform. `replace-document` is the
 *  whole-buffer rewrite a plugin's `editor.open()` performs: it destroys more
 *  than a selection replacement, so it is its own kind rather than another
 *  insert, and granting one must never grant the other. */
export type AiWriteKind = 'insert' | 'replace-selection' | 'replace-document'

/** Where a write came from. Used by the audit trail to say WHO asked - the
 *  user's own Tab press, the chat rail, a selection edit, or a plugin - since
 *  "the AI wrote to my note" is not an answer anyone can act on. */
export type AiWriteSource = 'ghost' | 'chat' | 'edit' | 'dialog' | 'plugin'

/** One pending write. `summary` and `target` describe it to the user in the
 *  prompt; they never take part in the decision. `source` never takes part in
 *  the decision either - it is recorded, not judged. */
export interface AiWriteRequest {
  kind: AiWriteKind
  summary: string
  target?: string
  source?: AiWriteSource
}

export type AiWriteDecision = 'allow' | 'ask' | 'deny'

/**
 * `sessionGrants` holds {@link grantKey} values rather than requests, since
 * the request text is different every time and could never match twice.
 *
 * `enabled` is the master switch: with it off NOTHING an AI feature asks for is
 * granted, and the features that would send the document to a provider do not
 * run at all. It is optional, and only `false` switches AI off: a state read
 * back from a build that predates the switch carries no field, and that user
 * had a working AI — treating the missing field as "off" would break their
 * setup, while treating it as "on" preserves exactly the previous behaviour.
 */
export interface AiPermissionState {
  policy: AiWritePolicy
  sessionGrants: ReadonlySet<string>
  enabled?: boolean
}

/** Every policy, in the order the settings UI lists them (default first). */
export const AI_WRITE_POLICIES: readonly AiWritePolicy[] = ['ask', 'auto', 'readonly']

/** Nothing granted and the cautious policy: the app asks before the AI's
 *  first write, so trust is given deliberately rather than assumed. AI itself
 *  starts switched on, because turning a feature off that the user may already
 *  rely on is not a default anyone asked for. */
export const DEFAULT_AI_PERMISSION: AiPermissionState = {
  policy: 'ask',
  sessionGrants: new Set(),
  enabled: true,
}

/** Whether AI features are switched on. An absent flag reads as on (see
 *  {@link AiPermissionState}); only an explicit `false` disables them. */
export const isAiEnabled = (state: AiPermissionState): boolean => state.enabled !== false

/** Stand-in for the grant set of a state that predates the field (a blob
 *  written by an older build), so an absent set reads as "no grants" instead
 *  of breaking the decision. */
const EMPTY_GRANTS: ReadonlySet<string> = new Set()

const grantsOf = (state: AiPermissionState): ReadonlySet<string> =>
  state.sessionGrants ?? EMPTY_GRANTS

/**
 * The key a session grant is stored under.
 *
 * It covers the kind of write, so one approval serves the streamed completion
 * that follows it, and it namespaces the kind so keys stay self-describing
 * wherever a grant set is persisted or logged.
 */
export const grantKey = (req: AiWriteRequest): string => `ai-write:${req.kind}`

/**
 * Whether the AI may perform `req` right now.
 *
 * Only the policies the user could actually have chosen are honoured; an
 * unknown or missing policy falls back to 'ask' rather than to the most
 * permissive branch.
 */
export const decideAiWrite = (
  state: AiPermissionState,
  req: AiWriteRequest,
): AiWriteDecision => {
  // The master switch short-circuits the whole table: with AI off there is no
  // policy under which a write may proceed, and no grant the user gave earlier
  // in the session may survive it.
  if (!isAiEnabled(state)) return 'deny'
  if (state.policy === 'auto') return 'allow'
  if (state.policy === 'readonly') return 'deny'
  // The unknown-policy case deliberately does not consult the grants: a state
  // we cannot interpret is a state whose grant set we cannot trust either, so
  // a legacy blob prompts instead of riding on a grant it may have carried.
  if (state.policy !== 'ask') return 'ask'
  return grantsOf(state).has(grantKey(req)) ? 'allow' : 'ask'
}

/**
 * A copy of `state` with `req`'s kind granted for the rest of the session.
 *
 * Returns a new state and copies the grant set rather than adding into it, so
 * a caller still holding the previous state (a store snapshot, an in-flight
 * decision) never sees it change behind its back.
 */
export const grantForSession = (
  state: AiPermissionState,
  req: AiWriteRequest,
): AiPermissionState => {
  const sessionGrants = new Set(grantsOf(state))
  sessionGrants.add(grantKey(req))
  return { ...state, sessionGrants }
}

/** A copy of `state` with the session grants dropped and the policy kept:
 *  the user's "stop trusting the AI for now" reset. */
export const revokeAllGrants = (state: AiPermissionState): AiPermissionState => ({
  ...state,
  sessionGrants: new Set(),
})

const POLICY_KEYS: Record<AiWritePolicy, string> = {
  ask: 'aiperm.policyAsk',
  auto: 'aiperm.policyAuto',
  readonly: 'aiperm.policyReadonly',
}

/**
 * The i18n key for a policy, not the wording.
 *
 * The UI owns translations, and this module is reachable before i18n is
 * initialised (a persisted state is read at startup), so it hands back a key.
 * An unknown value describes as 'ask', matching the decision it produces.
 * The keys are the flat ones the locales actually define — a nested spelling
 * here silently rendered as a missing label.
 */
export const describePolicy = (policy: AiWritePolicy): string => {
  return POLICY_KEYS[policy] ?? POLICY_KEYS.ask
}
