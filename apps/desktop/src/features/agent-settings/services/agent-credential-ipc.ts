/**
 * The credential client: the one write, bound to one engine/profile pair.
 *
 * `agent_credentials_write` is the third of the commands this tree built and could not reach from
 * any window (`docs/development-log.md:135` records the other two). The page that owns its subject
 * — `AgentProviderSettings.vue`, §8.1's 「供应商/模型」 row — rendered the credential *names* and
 * the redacted placeholder and had no control that could change one.
 *
 * ## Why this is a client of its own rather than a third method on the profile's
 *
 * The profile's client carries the record: a revision, three fields, one answer that is a status
 * and a conflict. This one carries a *patch* to a different resource, whose answer is the whole
 * profile as it now stands. `agent-config-ipc.ts` and `agent-skills-ipc.ts` are built the same way
 * for the same reason — one port per command family, bound to the pair at construction — and this
 * one takes the profile's client as its reader for the reason `agent-config-ipc.ts` does: the
 * readout's shape is narrowed in ONE place, and a second narrowing of one answer is a second
 * opinion about which document a pair has.
 *
 * ## What it deliberately does not do
 *
 * **It never carries a credential value out.** The command answers the profile readout, whose
 * credentials are names and the placeholder (`profile::Credentials` has no `Serialize` for exactly
 * this reason) — and this client drops that answer rather than narrowing it, re-reading through
 * the profile client instead. So there is one path from a readout to a page, and it is the one
 * `agent-profile-ipc.ts` already validated. The values only ever travel the *other* way, in
 * {@link AgentCredentialClient.write}'s argument.
 *
 * **It does not decide what a submission contains.** {@link credentialWrite} in the policy does —
 * including the guard that refuses a value that is the placeholder — and the page calls it before
 * this client is reached. What arrives here is a patch the policy has already cleared.
 */

import {
  credentialWrite,
  type AgentProfileReadout,
  type CredentialField,
} from './agent-settings-policy'
import type { AgentProviderClient } from './agent-profile-ipc'

/**
 * The credentials page's client, declared by the page itself.
 *
 * Repeated as a structural type rather than imported from the `.vue` file for the reason the
 * profile's client repeats its port: `features/settings` may not reach into another feature's
 * components, and the two meet at the composition site, where a method that drifted is a compile
 * error.
 *
 * `write` answers the profile as it now stands, because a form left holding the old names would
 * offer to clear a credential the user has just set. A *refusal* is not one of its answers: the
 * backend rejects with its own sentence, and that stays a rejection here rather than becoming a
 * value the page would have to invent a reading for.
 */
export interface AgentCredentialClient {
  write(fields: readonly CredentialField[]): Promise<CredentialWriteOutcome>
}

/** What one submission did: written, or refused before it was sent. */
export type CredentialWriteOutcome =
  | { status: 'written'; readout: AgentProfileReadout }
  | { status: 'refused'; message: string }

/** The window's IPC, as this client uses it — one call, whose answer is not trusted. */
export interface AgentCredentialWire {
  write(request: { agentId: string; profileId: string; changes: unknown }): Promise<unknown>
}

/**
 * The port, implemented over the window's IPC and the profile client.
 *
 * The pair is bound at construction rather than passed per call, for the reason
 * `agent-permission-ipc.ts` gives: a credential page is about one profile, and a client that could
 * be asked about another is a value appearing under an engine it does not belong to (§8.1).
 */
export function createAgentCredentialClient(options: {
  wire: AgentCredentialWire
  profile: AgentProviderClient
  agentId: string
  profileId: string
}): AgentCredentialClient {
  const { wire, profile, agentId, profileId } = options
  return {
    async write(fields: readonly CredentialField[]): Promise<CredentialWriteOutcome> {
      const submission = credentialWrite([...fields])
      // The placeholder guard, and the reason it is here rather than at the backend: what this
      // refuses is a *form* mistake — a field submitted without being touched, carrying the value
      // the page itself displayed — and sending it would replace a working key with the literal
      // string `<redacted>` and show up much later as an authentication failure.
      if ('refused' in submission) return { status: 'refused', message: submission.refused }
      // An empty patch is nothing to send, and sending it would move the set for no reason. The
      // readout is re-read anyway, so the page ends up holding the truth either way.
      if (submission.changes.length === 0) {
        return { status: 'written', readout: await profile.read(agentId, profileId) }
      }
      // The answer is the new readout; it is dropped rather than narrowed here, because the one
      // narrowing of a readout is `agent-profile-ipc.ts`'s and this call is what makes it fresh.
      await wire.write({ agentId, profileId, changes: submission.changes })
      return { status: 'written', readout: await profile.read(agentId, profileId) }
    },
  }
}
