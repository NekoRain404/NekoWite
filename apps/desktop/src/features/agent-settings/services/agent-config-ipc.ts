/**
 * The configuration-document client: the backend's answers, narrowed into the port the page calls.
 *
 * The same split `agent-profile-ipc.ts` makes, one document over: `agent-settings-policy.ts`
 * declares the domain types and the rules — {@link ConfigRead}, {@link ConfigEdit},
 * {@link decideConfigWrite}, {@link configEditor} — and this file narrows the wire into them. The
 * wire is `unknown` (`platform` may not name a feature's types), so the shape is this file's
 * responsibility: a cast would be a promise about a foreign process, and a renamed field would reach
 * the page as a blank version of a document it then offered to edit.
 *
 * **Why the policy already existed and this file did not.** The document editor's rules were written
 * and tested with the profile page and then left with no client in front of them — `ConfigRead`,
 * `ConfigWrite` and `decideConfigWrite` had no caller outside their own test, which is this
 * repository's signature failure in its quietest form. So there is deliberately **no second policy
 * module here**: the arms, the refusals and the revision rule are the ones already written, and this
 * file only turns IPC answers into them.
 *
 * **Which document, and why that is not this file's decision.** The relative path is the engine's
 * layout (§3.4.5), it arrives on the profile readout (`configDocument`), and this client reads it
 * there rather than holding one. So the client is built for one (engine, profile) pair, the way the
 * permission client is, and every call it makes is about that pair: §8.1's 「配置归属」 is a property
 * of how it is constructed rather than a check somebody remembers to run.
 *
 * **The pair guard is a refusal, not a rendered state.** The profile page reports a mismatch as a
 * sentence, because it only *shows* what it read. This page *writes*: a document read from another
 * profile's record would be edited at a revision and a path that belong to it, so a mismatch rejects
 * here and the page draws its unreadable state with a retry. A wrong document opened is a worse
 * outcome than a document not opened.
 *
 * **A malformed answer is a rejection, not an empty document.** "The engine has written nothing" is
 * a claim about the file; a shape this window cannot read is a fact about this window. Collapsing
 * them would draw an editor over a document whose text failed to arrive, which is the one state in
 * which an edit could be built from nothing.
 */

import type { AgentProviderClient } from './agent-profile-ipc'
import type { ConfigEdit, ConfigRead } from './agent-settings-policy'

/**
 * What the page read.
 *
 * `no-document` is not an error state: it is `user-config`, the mode where the engine reads the
 * user's own installation. There *is* a configuration — it is that installation's file, and this
 * app did not write it and will not open it. The arm is separate from an unreadable read for that
 * reason: one is a fact about the profile, the other is a fact about the connection, and they lead
 * a user to two different next moves (§5.2's 「不可用选项要说明原因」).
 */
export type AgentConfigReadout =
  | { state: 'document'; document: ConfigRead }
  | { state: 'no-document' }

/**
 * What an edit did, as `agent_config_edit` reports it.
 *
 * Both arms are the backend's, and they are *not* the pre-flight's: `decideConfigWrite` answers
 * `applied`/`conflict`/`refused` about a write that has not been sent, and this answers what came
 * back. `conflict` carries the document that is there instead — `null` when the file is gone —
 * because the caller reloads and rebuilds its edit from that; merging is how a change made elsewhere
 * gets undone, so there is no arm here for it.
 */
export type AgentConfigEditOutcome =
  | { status: 'written'; revision: string }
  | { status: 'conflict'; current: { revision: string; text: string } | null }

/**
 * The window's IPC, as this client uses it: two calls whose answers are not trusted.
 *
 * Structurally the port `platform/gateways/tauri-agent/config.ts` implements — declared rather than
 * imported, because `platform` may not reach into `features` and this module may not depend on
 * Tauri.
 */
export interface AgentConfigWire {
  read(agentId: string, profileId: string, relative: string): Promise<unknown>
  edit(request: {
    agentId: string
    profileId: string
    relative: string
    /** The revision the read answered, or `null` for a document that is not there. */
    revision: string | null
    edits: readonly ConfigEdit[]
  }): Promise<unknown>
}

/** The port, implemented over the window's IPC. */
export interface AgentConfigClient {
  /** The document this pair's engine reads, or the arm that says there is none to open. */
  read(): Promise<AgentConfigReadout>
  /**
   * Set members at the revision the read answered with.
   *
   * The revision is the caller's, not this client's, because a client holding one would be a client
   * that could edit a document it had not shown anybody. A revision that is not the shape the
   * backend issues is refused there rather than compared and reported as a conflict — two different
   * things for a user to act on.
   *
   * `null` is that same revision, for a read that answered there is no document: it is a claim the
   * backend checks against the disk, and the write it produces is the document's first content. It
   * is passed through as the caller's like every other field — this client holds no revision and
   * decides nothing about one.
   */
  edit(
    relative: string,
    revision: string | null,
    edits: readonly ConfigEdit[],
  ): Promise<AgentConfigEditOutcome>
}

/** The two halves this client is built over: the profile that names the document, and the document. */
export interface AgentConfigRequest {
  /** The profile's own client, read for the one field that names the document. */
  profile: AgentProviderClient
  config: AgentConfigWire
  agentId: string
  profileId: string
}

export function createAgentConfigClient(request: AgentConfigRequest): AgentConfigClient {
  return {
    async read(): Promise<AgentConfigReadout> {
      const record = await request.profile.read(request.agentId, request.profileId)
      if (record.agentId !== request.agentId || record.profileId !== request.profileId) {
        throw new Error(
          `the profile answered for ${record.agentId}/${record.profileId}, not for ` +
            `${request.agentId}/${request.profileId}: a document read from another profile's ` +
            'record would be edited at that profile\'s path',
        )
      }
      const relative = record.configDocument
      // The mode this host writes nothing in. Separate from an empty document on purpose: there is
      // a configuration, it is the user's own installation's, and the page says so in words.
      if (relative === null) return { state: 'no-document' }
      const answer = await request.config.read(request.agentId, request.profileId, relative)
      return { state: 'document', document: document(answer, relative) }
    },

    async edit(
      relative: string,
      revision: string | null,
      edits: readonly ConfigEdit[],
    ): Promise<AgentConfigEditOutcome> {
      const answer = await request.config.edit({
        agentId: request.agentId,
        profileId: request.profileId,
        relative,
        revision,
        edits,
      })
      return outcome(answer)
    },
  }
}

/**
 * The document as `agent_config_document` reports it.
 *
 * `relative` is the caller's and is echoed into `path` — the field `decideConfigWrite` compares, so
 * the path an edit carries is provably the path the read was for. The backend's `path` becomes
 * `resolved`: it is where the file really is, which a user needs in order to open it themselves and
 * which no edit may be submitted with.
 */
function document(value: unknown, relative: string): ConfigRead {
  const record = asRecord(value, 'the document')
  return {
    path: relative,
    resolved: asString(record['path'], 'the document.path'),
    exists: asBoolean(record['exists'], 'the document.exists'),
    revision: asNullableString(record['revision'], 'the document.revision'),
    // Absent *with* `exists: true` is a file this host could not hold as text, which the backend
    // answers as a refusal rather than as an answer. Narrowed as nullable so it lands in the page's
    // `creatable` arm rather than in an editor drawing text that never arrived.
    text: asNullableString(record['text'], 'the document.text'),
    editable: asBoolean(record['editable'], 'the document.editable'),
  }
}

/** The two arms `submit_document` answers with, checked per-arm. */
function outcome(value: unknown): AgentConfigEditOutcome {
  const record = asRecord(value, 'an edit answer')
  const status = oneOf(record['status'], ['written', 'conflict'] as const, 'status')
  if (status === 'written') {
    return { status, revision: asString(record['revision'], 'an edit answer.revision') }
  }
  const current = record['current']
  if (current === null) return { status, current: null }
  const held = asRecord(current, 'an edit answer.current')
  return {
    status,
    current: {
      revision: asString(held['revision'], 'an edit answer.current.revision'),
      text: asString(held['text'], 'an edit answer.current.text'),
    },
  }
}

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

/** A failed call. The page's unreadable state is the answer to this, and it is not "no document". */
function malformed(what: string): never {
  throw new Error(`the configuration document answered something this window does not understand: ${what}`)
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return malformed(what)
  return value as Record<string, unknown>
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
