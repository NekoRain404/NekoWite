/**
 * The runtime client: what it does with each answer `agent_runtime.rs` can give.
 *
 * The wire literals below are the *shape* `agent_runtime_read` serializes, written out by hand
 * rather than derived from the Rust types, because the coupling this file guards is between two
 * processes: a renamed JSON field keeps every Rust assertion green and would leave the page drawing
 * a runtime with a hole in it.
 *
 * Four properties, one per group:
 *
 *  - **The handshake is a tagged union, and its two arms carry different fields.** `protocolVersion`
 *    on a `not-read` answer is a shape this window refuses rather than a version drawn beside a
 *    sentence saying there is none — the page's whole rebuild is that those two cannot be confused.
 *  - **The absence's two ids are a closed set, and the client does not guess one.** Which of the two
 *    states this host is in is the host's own knowledge; a client that derived it from `process`
 *    would be wrong half the time, because an engine before its first session reads `ready` exactly
 *    like one that has negotiated. A third id arriving here is a rejection rather than a sentence.
 *  - **The closed sets are read as closed sets.** `process` in particular: it was four arms wide
 *    before this readout existed and only two of them are states the host can be in, so a third
 *    arriving from a backend that grew one is a rejection rather than a row with no sentence.
 *  - **A malformed answer is a rejection, not an empty runtime.** "No engine is running" is a claim
 *    about the host; a shape this window cannot read is a fact about this window. Collapsing them
 *    would let a renamed field render as a runtime that has stopped.
 */

import { describe, expect, it, vi } from 'vitest'

import { createAgentRuntimeClient, type AgentRuntimeWire } from './agent-runtime-ipc'
import type { AgentRuntimeReadout } from '../components/AgentRuntimeSettings.vue'

/** The readout as the backend serializes it, with the handshake arm the caller asks for. */
function readout(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: 'bundled-engine',
    displayName: "NekoWite's engine",
    source: 'bundled',
    program: '/opt/nekowite/binaries/opencode',
    reportedVersion: '1.18.29',
    adapterId: 'opencode',
    process: 'ready',
    updatePolicy: 'host-managed',
    handshake: {
      status: 'read',
      protocolVersion: 1,
      agentName: 'FakeAgent',
      agentVersion: '0.0.1',
      authMethods: [{ id: 'fake-login', name: 'Fake login' }],
    },
    capabilities: [
      { feature: 'session-list', declared: 'advertised', finding: { status: 'available' } },
      {
        feature: 'audio-attachments',
        declared: 'not-advertised',
        finding: {
          status: 'unavailable',
          detail: "the engine's handshake does not advertise `promptCapabilities.audio`",
        },
      },
      {
        feature: 'model-selection',
        declared: 'advertised',
        finding: { status: 'unverified', detail: 'no session response has been read' },
      },
    ],
    ...overrides,
  }
}

function wire(answer: unknown): { wire: AgentRuntimeWire; read: ReturnType<typeof vi.fn> } {
  const read = vi.fn(async () => answer)
  return { wire: { read }, read }
}

function client(answer: unknown) {
  const parts = wire(answer)
  return { parts, port: createAgentRuntimeClient(parts.wire) }
}

/** The `not-read` arm, which has no protocol version and one id. */
const NOT_READ = { status: 'not-read', reason: 'no-engine' }

describe('the runtime read', () => {
  it('reads the wire shape into the page’s own, arm for arm', async () => {
    const { port } = client(readout())
    const answer: AgentRuntimeReadout = await port.read()

    expect(answer).toEqual({
      agentId: 'bundled-engine',
      displayName: "NekoWite's engine",
      source: 'bundled',
      program: '/opt/nekowite/binaries/opencode',
      reportedVersion: '1.18.29',
      adapterId: 'opencode',
      process: 'ready',
      updatePolicy: 'host-managed',
      handshake: {
        status: 'read',
        protocolVersion: 1,
        agentName: 'FakeAgent',
        agentVersion: '0.0.1',
        authMethods: [{ id: 'fake-login', name: 'Fake login' }],
      },
      // The backend's `Finding` arms, as the page's three standings — and the declaration beside
      // them, read into its own member rather than folded into the standing. The two halves are
      // two claims: `declared` is what this build has on file about the version it was measured
      // against, and the page draws it as such wherever the two disagree.
      capabilities: [
        { feature: 'session-list', declared: 'advertised', standing: 'advertised', detail: null },
        {
          feature: 'audio-attachments',
          declared: 'not-advertised',
          standing: 'not-advertised',
          detail: "the engine's handshake does not advertise `promptCapabilities.audio`",
        },
        {
          feature: 'model-selection',
          declared: 'advertised',
          standing: 'unverified',
          detail: 'no session response has been read',
        },
      ],
    })
  })

  it('carries the backend’s own reason id through when nothing has been negotiated', async () => {
    // Two ids, not two sentences: the page has one sentence per id in its catalogue, and the host
    // owns which of the two states it is in. Both are read, so a second arm the backend grows is a
    // rejection here rather than a page drawing the wrong one of the two it knows.
    const { port } = client(readout({ process: 'stopped', handshake: NOT_READ, capabilities: [] }))
    expect((await port.read()).handshake).toEqual(NOT_READ)

    const { port: later } = client(
      readout({ handshake: { status: 'not-read', reason: 'not-yet' }, capabilities: [] }),
    )
    expect((await later.read()).handshake).toEqual({ status: 'not-read', reason: 'not-yet' })
  })

  it('refuses a reason outside the two this host has states for', async () => {
    const { port } = client(
      readout({ handshake: { status: 'not-read', reason: 'crashed' } }),
    )
    await expect(port.read()).rejects.toThrow(/reason/)
  })

  it('refuses a protocol version arriving on the arm that says there is none', async () => {
    // The old page's defect in one assertion: it drew `{version: null, negotiated: false}` out of a
    // readout that had never asked an engine anything. A `not-read` answer carrying a version is
    // that same confusion arriving from the other side, and the answer is to read nothing at all.
    const { port } = client(
      readout({ handshake: { ...NOT_READ, protocolVersion: 1 } }),
    )
    expect(await port.read()).toEqual(
      expect.objectContaining({ handshake: NOT_READ }),
    )
  })

  it('refuses a process state this host cannot be in', async () => {
    // `starting` and `failed` were two of the four arms the readout used to declare. Neither is a
    // state a read can be taken in, so a backend that produced one would be describing a runtime
    // the page has no sentence for — and the page's `process` is a two-arm union precisely so that
    // cannot pass silently.
    const { port } = client(readout({ process: 'starting' }))
    await expect(port.read()).rejects.toThrow(/process/)
  })

  it('refuses an engine whose provenance this window has no arm for', async () => {
    const { port } = client(readout({ source: 'sidecar' }))
    await expect(port.read()).rejects.toThrow(/source/)
  })

  it('refuses a finding whose status is not one of the three', async () => {
    // `report` has exactly three arms and every non-available one requires a detail. A fourth
    // arriving here is a backend this build does not match, and a row that fell into whichever
    // branch happened to be last would say "not supported" about something nobody measured.
    const { port } = client(
      readout({ capabilities: [{ feature: 'x', declared: 'advertised', finding: { status: 'maybe' } }] }),
    )
    await expect(port.read()).rejects.toThrow(/status/)
  })

  it('refuses a declaration outside the three arms the backend has', async () => {
    // The declaration half is a closed set for the same reason `process` is: a fourth arm is a
    // backend this build does not match, and a row that fell into a default would be stating a
    // claim about the pinned version that no file made.
    const { port } = client(
      readout({
        capabilities: [{ feature: 'x', declared: 'probably', finding: { status: 'available' } }],
      }),
    )
    await expect(port.read()).rejects.toThrow(/declared/)
  })

  it('refuses a row that carries no declaration at all', async () => {
    // `report` writes both halves for every row, so a row missing one did not come from this
    // backend. Reading its absence as `unverified` would put a claim in the file's mouth.
    const { port } = client(
      readout({ capabilities: [{ feature: 'x', finding: { status: 'available' } }] }),
    )
    await expect(port.read()).rejects.toThrow(/declared/)
  })

  it('refuses a nullable field sent as an absent member rather than as null', async () => {
    // The host writes its nullables explicitly (`agent_runtime.rs` sends `agentName` as a string or
    // as `null`), so a member that is not there at all is an answer that did not come from this
    // host — and reading it as `null` would turn "the engine did not send agentInfo" into a claim
    // about a field the answer never carried.
    const { port } = client(
      readout({
        handshake: {
          status: 'read',
          protocolVersion: 1,
          agentVersion: '0.0.1',
          authMethods: [],
        },
      }),
    )
    await expect(port.read()).rejects.toThrow(/agentName/)
  })

  it('refuses an answer that is not an object at all', async () => {
    const { port } = client('the runtime could not be read')
    await expect(port.read()).rejects.toThrow(/runtime readout/)
  })
})
