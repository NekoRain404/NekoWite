/**
 * The registry client: the backend's answers, narrowed into the port the settings page calls.
 *
 * `agent-registry-policy.ts` declares what the page needs (`AgentRegistryClient`); this is the
 * implementation of it that talks to the window's IPC, and the two files sit together because they
 * are one vocabulary — the port's types are the *domain* types, while what arrives from Rust is
 * JSON that this file has to narrow. It is the same split `tauri-agent.ts` makes between its
 * adapter and the contract next door, one feature over.
 *
 * **Why it validates instead of casting.** The wire is `unknown` (`platform/.../registry.ts` says
 * why: `platform` may not name a feature's types), so the shape is this file's responsibility. A
 * cast would be a promise about a foreign process: a renamed field, an arm the backend grew, or a
 * value that is not what its name says would reach the page and render as a blank row — the one
 * failure T13a's copy guard exists to make loud. Anything this file cannot read is a *rejection*,
 * which is the port's "the call did not complete" arm and drops the page into its unreadable state
 * with a retry — never "no engines are registered", which is a claim about the backend.
 *
 * **Two failure channels, and the type says which is which.** A *refusal* is this module's return
 * value (`null` = accepted), and a *rejection* is a thrown `Error`. Nothing here turns a refusal
 * into a throw or the other way round, so the page cannot confuse "the backend said no, here is
 * why" with "this page could not reach the backend".
 *
 * **Never a value in a message.** What a malformed answer contains is unknown by construction — the
 * whole point of the check that failed — so a thrown message names the *field*, not the value it
 * held. `envExtra` is masked by the backend and masked again by the page; a third path that copied
 * wire text into an error would be the one that had no mask at all.
 */

import { isAgentFailureCode } from '../../../platform/gateways/agent-contracts'
import {
  asBoolean,
  asList,
  asNullableString,
  asNumber,
  asRecord,
  asString,
  asStringList,
  asStringRecord,
  malformed,
  oneOf,
} from './agent-wire-narrowing'
import type {
  AgentDraft,
  AgentRegistryClient,
  AgentRegistryEntry,
  AgentRegistryReadout,
  EnvPolicy,
  InstallSource,
  ProgramState,
  RegistryRefusal,
  RegistryRefusalKind,
} from './agent-registry-policy'

/**
 * The window's IPC, as this client uses it: three calls whose answers are not trusted.
 *
 * Structurally the port `platform/gateways/tauri-agent/registry.ts` implements — declared rather
 * than imported, because `platform` may not reach into `features` (plan §6.1) and this module may
 * not depend on Tauri. The two meet at the composition site, where a method that drifted is a
 * compile error rather than a call that fails at runtime.
 */
export interface AgentRegistryWire {
  read(): Promise<unknown>
  add(draft: AgentDraft): Promise<unknown>
  setEnabled(agentId: string, enabled: boolean): Promise<unknown>
}

/** The three vocabularies the wire uses, listed once each so a new arm is a compile error here. */
const SOURCES: readonly InstallSource[] = ['bundled', 'managed', 'external']
const ENV_POLICIES: readonly EnvPolicy[] = ['profile-isolated', 'user-environment']
const PROGRAM_STATES: readonly ProgramState[] = [
  'launchable',
  'not-absolute',
  'missing',
  'not-a-file',
  'not-executable',
]
/**
 * The refusal kinds, which are `RegistryError`'s arms: one sentence per kind lives in the catalogue
 * (`agent.registry.refusal.*`) and the page's copy record is keyed by this union, so a kind this
 * list does not carry is a refusal the page could not say anything about — which is why an unknown
 * one is refused here rather than passed through.
 */
const REFUSAL_KINDS: readonly RegistryRefusalKind[] = [
  'id',
  'program',
  'argument',
  'environment',
  'unknown-adapter',
  'duplicate-agent',
  'unknown-agent',
  'profile-unbound',
  'disabled',
  'already-running',
  'instance-running',
  'is-default',
  'launch-failed',
]

/** The port, implemented over the window's IPC. */
export function createAgentRegistryClient(wire: AgentRegistryWire): AgentRegistryClient {
  return {
    async read(): Promise<AgentRegistryReadout> {
      return readout(await wire.read())
    },
    async add(draft: AgentDraft): Promise<RegistryRefusal | null> {
      return nullableRefusal(await wire.add(draft))
    },
    async setEnabled(agentId: string, enabled: boolean): Promise<RegistryRefusal | null> {
      return nullableRefusal(await wire.setEnabled(agentId, enabled))
    },
  }
}

// ---------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------

/** `null` is the accepted arm; anything else is a refusal and must read as one. */
function nullableRefusal(value: unknown): RegistryRefusal | null {
  return value === null ? null : refusal(value)
}

function readout(value: unknown): AgentRegistryReadout {
  const record = asRecord(value, 'the readout')
  return {
    defaultAgentId: asString(record['defaultAgentId'], 'defaultAgentId'),
    entries: asList(record['entries'], 'entries').map(entry),
    adapterIds: asStringList(record['adapterIds'], 'adapterIds'),
    runningAgentIds: asStringList(record['runningAgentIds'], 'runningAgentIds'),
    profileOwners: asStringRecord(record['profileOwners'], 'profileOwners'),
  }
}

function entry(value: unknown, index: number): AgentRegistryEntry {
  const record = asRecord(value, `entries[${index}]`)
  const at = (field: string) => `entries[${index}].${field}`
  return {
    agentId: asString(record['agentId'], at('agentId')),
    displayName: asString(record['displayName'], at('displayName')),
    source: oneOf(record['source'], SOURCES, at('source')),
    program: asString(record['program'], at('program')),
    args: asStringList(record['args'], at('args')),
    env: oneOf(record['env'], ENV_POLICIES, at('env')),
    envExtra: asList(record['envExtra'], at('envExtra')).map((variable, position) => {
      const pair = asRecord(variable, `${at('envExtra')}[${position}]`)
      return {
        name: asString(pair['name'], `${at('envExtra')}[${position}].name`),
        value: asString(pair['value'], `${at('envExtra')}[${position}].value`),
      }
    }),
    enabled: asBoolean(record['enabled'], at('enabled')),
    adapterId: asString(record['adapterId'], at('adapterId')),
    reportedVersion: asNullableString(record['reportedVersion'], at('reportedVersion')),
    programState: oneOf(record['programState'], PROGRAM_STATES, at('programState')),
  }
}

/**
 * The refusal, arm for arm — `RegistryError`'s own vocabulary.
 *
 * Written out per arm rather than table-driven, so every field a page reads is checked against the
 * arm that carries it: a shared reader would let `path` arrive on `argument` and leave the sentence
 * with a hole in it. Two facts the Rust error has are absent here on purpose, and the backend is
 * where that decision is made: `already-running` and `instance-running` carry no epoch (§6.1's
 * incarnation token belongs in a runtime-status surface, not in a row a user reads).
 */
function refusal(value: unknown): RegistryRefusal {
  const record = asRecord(value, 'a refusal')
  const kind = oneOf(record['kind'], REFUSAL_KINDS, 'kind')
  switch (kind) {
    case 'id':
      return {
        kind,
        field: asString(record['field'], 'id.field'),
        value: asString(record['value'], 'id.value'),
      }
    case 'program':
      return {
        kind,
        path: asString(record['path'], 'program.path'),
        state: oneOf(record['state'], PROGRAM_STATES, 'program.state'),
      }
    case 'argument':
      return { kind, index: asNumber(record['index'], 'argument.index') }
    case 'environment':
      return { kind, name: asString(record['name'], 'environment.name') }
    case 'unknown-adapter':
      return { kind, adapterId: asString(record['adapterId'], 'unknown-adapter.adapterId') }
    case 'duplicate-agent':
      return { kind, agentId: asString(record['agentId'], 'duplicate-agent.agentId') }
    case 'unknown-agent':
      return { kind, agentId: asString(record['agentId'], 'unknown-agent.agentId') }
    case 'profile-unbound':
      return {
        kind,
        profileId: asString(record['profileId'], 'profile-unbound.profileId'),
        agentId: asString(record['agentId'], 'profile-unbound.agentId'),
        owner: asNullableString(record['owner'], 'profile-unbound.owner'),
      }
    case 'disabled':
      return { kind, agentId: asString(record['agentId'], 'disabled.agentId') }
    case 'already-running':
      return { kind, agentId: asString(record['agentId'], 'already-running.agentId') }
    case 'instance-running':
      return { kind, agentId: asString(record['agentId'], 'instance-running.agentId') }
    case 'is-default':
      return { kind, agentId: asString(record['agentId'], 'is-default.agentId') }
    case 'launch-failed': {
      const code = record['code']
      if (!isAgentFailureCode(code)) {
        return malformed('launch-failed.code')
      }
      return {
        kind,
        agentId: asString(record['agentId'], 'launch-failed.agentId'),
        code,
        message: asString(record['message'], 'launch-failed.message'),
      }
    }
  }
  // Unreachable: `REFUSAL_KINDS` is typed against the union, so a kind that is not one of the arms
  // above fails to compile in the list rather than arriving here. Kept so the function has a total
  // return without a cast, and so a build that somehow got past that is a rejection rather than a
  // refusal with no sentence.
  return malformed('kind')
}

