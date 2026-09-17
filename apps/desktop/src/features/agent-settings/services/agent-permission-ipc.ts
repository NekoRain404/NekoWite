/**
 * The permission page's client, implemented over the profile the backend already serves.
 *
 * ## Why this page reads the profile rather than a command of its own
 *
 * `AgentPermissionClient` was declared by the permission page and implemented by nothing, because
 * there was nothing for it to read: this app wrote no `permission` member and the rules lived in a
 * document nothing here opened (`permission-is-the-only-lever.md` §3c cost 2). The rules are this
 * app's own now — `profile.rs`'s `SHIPPED_PERMISSION_RULES`, written into the engine's
 * configuration when the profile is opened — so the facts the page needs are already on the wire,
 * as one more member of the profile readout. A command of its own would be a second read of the
 * same document by a second command, one more registration in the composition root, and a second
 * answer that could disagree with the one the session path acted on.
 *
 * ## What it will not do
 *
 * **It does not list the option kinds.** §6.3 makes the offered options a property of the *request*
 * the engine sends, and this page is read with no session running and no request in hand — so the
 * honest list is empty, and the page's own copy says why. Filling it from a constant here would be
 * the invention that rule forbids, done by the client instead of by the prompt.
 *
 * **It does not report rules that are not in force.** `state` is three arms and two of them list
 * nothing: a profile whose engine configuration already carries its own `permission` member is a
 * profile where this app's rules were deliberately not written (a user's own rules, made in this
 * app's own settings editor), and a profile that reuses the user's installation is one where this
 * host wrote nothing at all. Drawing the shipped rules under either would be a page telling a user
 * they are protected by a rule the engine was never given.
 */

import type { PermissionState, PermissionView } from './agent-settings-policy'
import type { AgentProfileWire } from './agent-profile-ipc'

/**
 * The limitation ids the page renders — §6.3's own sentences, fixed here.
 *
 * Constants rather than something read back, because they are statements about what this app has
 * *not* built rather than facts about a document: there is no measurement that would remove one,
 * and the page exists partly to keep them in front of a user.
 */
const PERMISSION_LIMITS = [
  'not-a-sandbox',
  'no-isolation',
  'stale-requests',
  'no-silent-approval',
] as const

export type PermissionLimitId = (typeof PERMISSION_LIMITS)[number]

/** Where one value on the page came from. Structurally `SettingOrigin` in the tree's own index. */
export type PermissionRuleOrigin =
  | { kind: 'host'; variable: string | null; path: string }
  | { kind: 'engine'; what: string }
  | { kind: 'session'; what: string }

export interface PermissionRule {
  /** The engine's own tool name, exactly as its configuration spells it. */
  tool: string
  /** The engine's own action for it, exactly as its configuration spells it. */
  action: string
  origin: PermissionRuleOrigin
}

export interface PermissionReadout {
  state: PermissionState
  rules: PermissionRule[]
  optionKinds: readonly string[]
  limits: readonly PermissionLimitId[]
}

/** The page's port, structurally — `AgentPermissionClient` in the component. */
export interface AgentPermissionClient {
  read(): Promise<PermissionReadout>
}

/**
 * Build the page's client for one engine and one profile.
 *
 * The pair is bound here rather than taken by `read()`, because the page's port has no arguments:
 * a permission page is about one profile, and a client that could be asked about another would be
 * one more place for a value to appear under an engine it does not belong to (§8.1).
 */
export function createAgentPermissionClient(request: {
  wire: AgentProfileWire
  agentId: string
  profileId: string
}): AgentPermissionClient {
  return {
    async read(): Promise<PermissionReadout> {
      const answer = await request.wire.read(request.agentId, request.profileId)
      const permissions = permissionsOf(answer)
      return {
        state: permissions.state,
        rules: rulesFor(permissions),
        // Always empty, and the page's copy says why (see the module comment): the offered options
        // arrive with a request, and this page is read with none in hand.
        optionKinds: [],
        limits: PERMISSION_LIMITS,
      }
    },
  }
}

/**
 * The rules to draw, which is the whole of what `state` decides.
 *
 * `written` is the only arm where this app's rules are the ones the engine was given, and it is the
 * only arm that draws a row. The origin carries the document's path, so the page can say which file
 * a reader would open to see them — `host` with no environment variable, because it is a file this
 * host chose the location of rather than a root it injected.
 */
function rulesFor(permissions: PermissionView): PermissionRule[] {
  if (permissions.state !== 'written') return []
  const path = permissions.document
  if (path === null) return []
  return permissions.rules.map((rule) => ({
    tool: rule.tool,
    action: rule.action,
    origin: { kind: 'host', variable: null, path },
  }))
}

/**
 * The record's `permissions` member, checked rather than assumed.
 *
 * The wire is `unknown` (`platform/.../profile.ts` says why), so the shape is this file's
 * responsibility: a member this build cannot read is a rejection, which the page renders as its own
 * "could not be read from the backend" state with a retry, rather than a readout with a hole in it.
 */
function permissionsOf(value: unknown): PermissionView {
  const record = asRecord(value, 'the profile')
  const permissions = asRecord(record['permissions'], 'permissions')
  const state = asString(permissions['state'], 'permissions.state')
  if (state !== 'written' && state !== 'engine-own' && state !== 'not-this-host') {
    return malformed('permissions.state')
  }
  return {
    state,
    document: nullableString(permissions['document'], 'permissions.document'),
    rules: asList(permissions['rules'], 'permissions.rules').map((rule, index) => {
      const entry = asRecord(rule, `permissions.rules[${index}]`)
      return {
        tool: asString(entry['tool'], `permissions.rules[${index}].tool`),
        action: asString(entry['action'], `permissions.rules[${index}].action`),
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

/** The message names the *field* and never the value: what a malformed answer held is unknown. */
function malformed(what: string): never {
  throw new Error(`the profile answered something this window does not understand: ${what}`)
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return malformed(what)
  return value as Record<string, unknown>
}

function asList(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) return malformed(what)
  return value
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') return malformed(what)
  return value
}

function nullableString(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null
  return asString(value, what)
}
