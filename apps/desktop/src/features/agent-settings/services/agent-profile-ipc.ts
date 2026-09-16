/**
 * The profile client: the backend's answers, narrowed into the port the provider page calls.
 *
 * `agent-settings-policy.ts` declares what the page needs (`AgentProfileReadout`, `ProfileWrite`,
 * `ProfileUpdate`); this is the implementation of the one client that reads and writes them,
 * `AgentProviderClient`, and the two files sit together because they are one vocabulary — the
 * policy's types are the *domain* types, while what arrives from `R/src/commands/agent_settings.rs`
 * is JSON that this file has to narrow.
 *
 * **Why it validates instead of casting.** The wire is `unknown` (`platform/.../profile.ts` says
 * why: `platform` may not name a feature's types), so the shape is this file's responsibility. A
 * cast would be a promise about a foreign process: a renamed field, a mode this build does not
 * know, or a storage record that claims encryption this app does not do would reach the page and
 * render as a value nobody chose. Anything this file cannot read is a *rejection*, which is the
 * page's "could not be read from the backend" state with a retry — never a readout with a hole in
 * it.
 *
 * **The two failure channels, and which arm each becomes.** A rejection (the call did not
 * complete) is a thrown `Error`, and a refusal the backend returned for a call that *did* run is
 * the same shape of rejection *here* — because that is what it is on this wire: `agent_settings.rs`
 * answers a refusal by rejecting with its own sentence, and `ProfileUpdate`'s `refused` arm is the
 * page's *pre-flight* answer (`decideProfileWrite` in the policy), not a second rendering of the
 * backend's prose. So this file maps the two arms the backend really sends — `written` and
 * `conflict` — and lets a rejection stay a rejection.
 *
 * **One profile, never "the app".** Every call carries the (agentId, profileId) pair it is about,
 * and `read` answers with the pair the backend recorded rather than the one that was asked for:
 * the page compares them (`profileProblem`) and shows nothing when they disagree, because §8.1's
 * rule is that no value may be rendered under an engine it does not belong to.
 *
 * **Never a credential value.** The readout's credentials arrive as names and the backend's own
 * redacted placeholder; this file passes them through and invents nothing, and no message it throws
 * carries a value — only the name of the field that failed.
 */

import {
  CONFIG_MODES,
  type AgentProfileReadout,
  type ConfigMode,
  type ConfigSourceView,
  type CredentialStorageView,
  type CredentialView,
  type ProfileFields,
  type ProfileUpdate,
} from './agent-settings-policy'

/**
 * The provider page's client, declared by the page itself.
 *
 * Repeated here as a structural type rather than imported from the `.vue` file for the reason the
 * registry's client repeats its port: `features/settings` may not reach into another feature's
 * components, and the two meet at the composition site, where a method that drifted is a compile
 * error.
 */
export interface AgentProviderClient {
  read(agentId: string, profileId: string): Promise<AgentProfileReadout>
  write(write: ProfileWriteLike): Promise<ProfileUpdate>
}

/** `ProfileWrite` plus the pair, as the page builds it — `profileWrite()` in the policy. */
export interface ProfileWriteLike {
  agentId: string
  profileId: string
  revision: string
  fields: ProfileFields
}

/**
 * The window's IPC, as this client uses it: two calls whose answers are not trusted.
 *
 * Structurally the port `platform/gateways/tauri-agent/profile.ts` implements — declared rather
 * than imported, because `platform` may not reach into `features` (plan §6.1) and this module may
 * not depend on Tauri. The composition site is where the two meet.
 */
export interface AgentProfileWire {
  read(agentId: string, profileId: string): Promise<unknown>
  write(request: {
    agentId: string
    profileId: string
    revision: string
    submission: ProfileFields
  }): Promise<unknown>
}

/** One writing, as `agent_settings.rs` names its status arms. A literal list, so a new one is loud. */
const WRITE_STATUSES = ['written', 'conflict'] as const
type WriteStatus = (typeof WRITE_STATUSES)[number]

/** The port, implemented over the window's IPC. */
export function createAgentProviderClient(wire: AgentProfileWire): AgentProviderClient {
  return {
    async read(agentId: string, profileId: string): Promise<AgentProfileReadout> {
      return readout(await wire.read(agentId, profileId))
    },
    async write(write: ProfileWriteLike): Promise<ProfileUpdate> {
      const answer = asRecord(
        await wire.write({
          agentId: write.agentId,
          profileId: write.profileId,
          revision: write.revision,
          submission: write.fields,
        }),
        'a write answer',
      )
      const status = oneOf(answer['status'], WRITE_STATUSES, 'a write answer.status')
      return update(status, answer, write.fields)
    },
  }
}

// ---------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------

/**
 * The two arms the backend sends, in the shape the page reads.
 *
 * `written` becomes `applied` with the fields that were submitted — the backend echoes the new
 * *revision* rather than the record, and the revision is checked but not carried: the record is
 * re-read after a write (the page does that, because a form left holding the old revision would
 * read its own next write as a conflict).
 */
function update(
  status: WriteStatus,
  answer: Record<string, unknown>,
  fields: ProfileFields,
): ProfileUpdate {
  if (status === 'written') {
    asString(answer['revision'], 'a write answer.revision')
    return { status: 'applied', fields }
  }
  return { status: 'conflict', current: readout(answer['current']) }
}

/** The record as the settings page reads it — `profile_view()`'s JSON, field for field. */
function readout(value: unknown): AgentProfileReadout {
  const record = asRecord(value, 'the profile')
  return {
    profileId: asString(record['profileId'], 'profileId'),
    agentId: asString(record['agentId'], 'agentId'),
    mode: oneOf(record['mode'], CONFIG_MODES, 'mode') as ConfigMode,
    root: asString(record['root'], 'root'),
    revision: asString(record['revision'], 'revision'),
    provider: asNullableString(record['provider'], 'provider'),
    modelId: asNullableString(record['modelId'], 'modelId'),
    editable: asBoolean(record['editable'], 'editable'),
    sources: asList(record['sources'], 'sources').map(source),
    credentials: asList(record['credentials'], 'credentials').map(credential),
    credentialStorage: storage(record['credentialStorage']),
  }
}

/** One configuration source: the host's injection (named) or the engine's own discovery. */
function source(value: unknown, index: number): ConfigSourceView {
  const record = asRecord(value, `sources[${index}]`)
  const kind = asString(record['kind'], `sources[${index}].kind`)
  if (kind === 'injected') {
    return {
      kind,
      variable: asString(record['variable'], `sources[${index}].variable`),
      path: asString(record['path'], `sources[${index}].path`),
    }
  }
  if (kind === 'engine-discovery') {
    return { kind, what: asString(record['what'], `sources[${index}].what`) }
  }
  return malformed(`sources[${index}].kind`)
}

/** A name and the backend's placeholder. A value that is not a string is refused, not printed. */
function credential(value: unknown, index: number): CredentialView {
  const record = asRecord(value, `credentials[${index}]`)
  return {
    name: asString(record['name'], `credentials[${index}].name`),
    value: asString(record['value'], `credentials[${index}].value`),
  }
}

/**
 * Where the credentials are.
 *
 * The two flags are checked against `false` rather than read: the page's sentence is "not
 * encrypted, no keychain" (§8.1: 不宣称已经使用系统钥匙串或加密), and a backend that one day answered
 * `true` would be describing a promise this window cannot render — refused here instead of drawn as
 * the opposite of what it says.
 */
function storage(value: unknown): CredentialStorageView {
  const record = asRecord(value, 'credentialStorage')
  const kind = asString(record['kind'], 'credentialStorage.kind')
  if (kind === 'none') return { kind }
  if (kind !== 'host-file') return malformed('credentialStorage.kind')
  if (record['encrypted'] !== false || record['keychain'] !== false) {
    return malformed('credentialStorage.encrypted')
  }
  return {
    kind,
    path: asString(record['path'], 'credentialStorage.path'),
    mode: asString(record['mode'], 'credentialStorage.mode'),
    encrypted: false,
    keychain: false,
  }
}

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

/**
 * A failed call, not a refused one: the page's unreadable state is the answer to this.
 *
 * The message names the *field* and never the value it held — what a malformed answer contains is
 * unknown by construction, and a credential is the field this file exists to keep out of
 * sentences.
 */
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

function asNullableString(value: unknown, what: string): string | null {
  if (value === null) return null
  return asString(value, what)
}

function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') return malformed(what)
  return value
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  const text = asString(value, what)
  if (!(allowed as readonly string[]).includes(text)) return malformed(what)
  return text as T
}
