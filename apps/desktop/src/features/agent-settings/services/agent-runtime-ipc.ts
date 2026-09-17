/**
 * The runtime client: the backend's answer, narrowed into the port the settings page calls.
 *
 * The same split `agent-catalogue-ipc.ts` makes, one subject over. The port and its vocabulary live
 * where the page that renders them lives (`components/AgentRuntimeSettings.vue`), and this file is
 * the implementation of it that talks to the window's IPC: what arrives is JSON that has to be
 * narrowed, because the wire is `unknown` (`platform` may not name a feature's types, §6.1) and a
 * cast would be a promise about a foreign process.
 *
 * **A malformed answer is a rejection, not a runtime with nothing in it.** "No engine is running"
 * is a claim about the host; a shape this window cannot read is a fact about this window. Collapsing
 * them would let a renamed field render as a runtime that has stopped, which is the one reading the
 * page's whole honesty rule exists to prevent — a page may not say an engine is absent because it
 * could not read one.
 *
 * **The two closed sets are read as closed sets.** `source`, `process`, `updatePolicy` and the two
 * standings are checked against their own lists rather than cast to their unions, so a fourth
 * provenance or a third process state is a rejection here and a compile error in the list — the one
 * place a new arm has to be acknowledged. That matters more on this wire than on most: `process`
 * was four arms wide until this readout existed, and only two of them were states the host could
 * ever be in.
 *
 * **The handshake's absence is an arm, not a missing member.** `status: 'not-read'` carries the
 * backend's own id for which of the two states this host is in, and this file checks it against the
 * two the page has sentences for — the split `RegistryRefusal` makes between a `kind` and the
 * sentence a user reads. Nothing here derives a reason from `process`: a running engine before its
 * first session and one that has negotiated both read `ready`, so a guessed reason would be wrong
 * half the time.
 */

import {
  asList,
  asNullableString,
  asNumber,
  asRecord,
  asString,
  malformed,
  oneOf,
} from './agent-wire-narrowing'
import type {
  AgentRuntimeClient,
  AgentRuntimeReadout,
  CapabilityStanding,
  RuntimeAuthMethod,
  RuntimeCapabilityRow,
  RuntimeHandshakeAbsent,
  RuntimeHandshakeState,
} from '../components/AgentRuntimeSettings.vue'

/**
 * The window's IPC, as this client uses it: one call whose answer is not trusted.
 *
 * Structurally the port the platform gateway implements — declared rather than imported, because
 * `platform` may not reach into `features` and this module may not depend on Tauri.
 */
export interface AgentRuntimeWire {
  read(): Promise<unknown>
}

/** The three provenances a registration can have, listed once each. */
const SOURCES: readonly AgentRuntimeReadout['source'][] = ['bundled', 'managed', 'external']

/**
 * The two process states this host can answer — and there are two.
 *
 * Narrow because the backing fact is narrow: the readout is read from the one instance slot, which
 * is empty or holds the running engine. A `starting` arm would be a state nothing can be read in
 * (the slot is filled only after `Registry::start` has returned) and a `failed` arm would be a
 * refusal that went to whoever asked for the start, not a state left behind.
 */
const PROCESS: readonly AgentRuntimeReadout['process'][] = ['stopped', 'ready']

/** The two update policies provenance implies. */
const POLICIES: readonly AgentRuntimeReadout['updatePolicy'][] = ['host-managed', 'reported-only']

/** The two states in which nothing has been negotiated. */
const ABSENCES: readonly RuntimeHandshakeAbsent[] = ['no-engine', 'not-yet']

/** The port, implemented over the window's IPC. */
export function createAgentRuntimeClient(wire: AgentRuntimeWire): AgentRuntimeClient {
  return {
    async read(): Promise<AgentRuntimeReadout> {
      return readout(await wire.read())
    },
  }
}

function readout(value: unknown): AgentRuntimeReadout {
  const record = asRecord(value, 'the runtime readout')
  return {
    agentId: asString(record['agentId'], 'agentId'),
    displayName: asString(record['displayName'], 'displayName'),
    source: oneOf(record['source'], SOURCES, 'source'),
    program: asString(record['program'], 'program'),
    reportedVersion: asNullableString(record['reportedVersion'], 'reportedVersion'),
    adapterId: asString(record['adapterId'], 'adapterId'),
    process: oneOf(record['process'], PROCESS, 'process'),
    updatePolicy: oneOf(record['updatePolicy'], POLICIES, 'updatePolicy'),
    handshake: handshake(record['handshake']),
    capabilities: asList(record['capabilities'], 'capabilities').map(row),
  }
}

/**
 * The handshake's two arms, read per-arm.
 *
 * Per-arm rather than by a shared reader, for the reason the catalogue client gives for its
 * standings: a field a page reads is checked against the arm that carries it, and a `protocolVersion`
 * arriving on `not-read` would otherwise slip through and leave the page drawing a version beside a
 * sentence saying there is none.
 */
function handshake(value: unknown): RuntimeHandshakeState {
  const record = asRecord(value, 'handshake')
  const status = oneOf(record['status'], ['read', 'not-read'] as const, 'handshake.status')
  if (status === 'not-read') {
    return { status, reason: oneOf(record['reason'], ABSENCES, 'handshake.reason') }
  }
  return {
    status,
    protocolVersion: asNumber(record['protocolVersion'], 'handshake.protocolVersion'),
    agentName: asNullableString(record['agentName'], 'handshake.agentName'),
    agentVersion: asNullableString(record['agentVersion'], 'handshake.agentVersion'),
    authMethods: asList(record['authMethods'], 'handshake.authMethods').map(method),
  }
}

function method(value: unknown, index: number): RuntimeAuthMethod {
  const record = asRecord(value, `handshake.authMethods[${index}]`)
  return {
    id: asString(record['id'], `handshake.authMethods[${index}].id`),
    name: asString(record['name'], `handshake.authMethods[${index}].name`),
  }
}

/**
 * One capability row, from the backend's `CapabilityReport`.
 *
 * `declared` is deliberately not read. It is the installation's claim about the pinned version, and
 * it travels beside the finding on the wire — but nothing on this page acts on a declaration, and a
 * row that drew one would be describing what the pinned version was measured to do under a heading
 * that says what this engine reported. The finding is the answer; the claim is left where it is.
 */
function row(value: unknown, index: number): RuntimeCapabilityRow {
  const record = asRecord(value, `capabilities[${index}]`)
  const at = (field: string) => `capabilities[${index}].${field}`
  const finding = asRecord(record['finding'], at('finding'))
  const status = asString(finding['status'], at('finding.status'))
  return {
    feature: asString(record['feature'], at('feature')),
    standing: standingOf(status, at('finding')),
    // A finding that answers has nothing to add; the two that refuse carry the engine's or the
    // runtime's own words, and a page that rendered neither would be refusing without saying why.
    detail: status === 'available' ? null : asString(finding['detail'], at('finding.detail')),
  }
}

/**
 * The three arms, spelled once.
 *
 * `available` is the only one `finding` may build without a detail — the backend's own rule — so the
 * two refusing arms are read for one, and a `status` outside the three is a rejection rather than a
 * row that falls into whichever branch happened to be last.
 */
function standingOf(status: string, what: string): CapabilityStanding {
  switch (status) {
    case 'available':
      return 'advertised'
    case 'unavailable':
      return 'not-advertised'
    case 'unverified':
      return 'unverified'
    default:
      return malformed(`${what}.status`)
  }
}
