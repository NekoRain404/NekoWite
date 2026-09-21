import { describe, expect, it, vi } from 'vitest'
import { createAgentRail, type AgentRail } from './agent-rail'
import type { AgentComposition } from './agent-composition'
import { createMemoryAgentGateway } from '../platform/gateways/memory-agent'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => { resolve = yes })
  return { promise, resolve }
}

function current(rail: AgentRail) {
  const state = rail.state.value
  if (state.kind !== 'live') throw new Error(`expected live, got ${state.kind}`)
  return state
}

async function fixture() {
  const gateway = createMemoryAgentGateway({ agentId: 'agent', profileId: 'profile' })
  const composition: AgentComposition = {
    gateway, start: () => gateway.start(), stop: () => gateway.stop(),
    openSession: async (request) => { await gateway.start(); return gateway.openSession(request) },
    connectSvgInsertion: () => { throw new Error('unused') },
    registry: {
      read: async () => { throw new Error('unavailable') },
      add: async () => { throw new Error('unused') },
      setEnabled: async () => { throw new Error('unused') },
    },
  }
  const onResumeFailed = vi.fn()
  const rail = createAgentRail({ compose: () => composition, onResumeFailed })
  await rail.open('vault-a', '/a')
  return { rail, gateway, composition, onResumeFailed }
}

describe('rail operation generations', () => {
  it('rechecks acquired handles when a second resume queues behind the first load', async () => {
    const f = await fixture()
    const historical = current(f.rail).session
    await f.rail.retry()
    const gate = deferred()
    const load = f.gateway.loadSession.bind(f.gateway)
    const loads = vi.spyOn(f.gateway, 'loadSession').mockImplementationOnce(async (sessionId, request) => {
      const session = await load(sessionId, request)
      await gate.promise
      return session
    })
    const first = f.rail.resume(historical.sessionId)
    await vi.waitFor(() => expect(loads).toHaveBeenCalledOnce())
    const second = f.rail.resume(historical.sessionId)
    gate.resolve()
    await Promise.all([first, second])
    expect(current(f.rail).session.sessionId).toBe(historical.sessionId)
    expect(loads).toHaveBeenCalledOnce()
    expect(f.onResumeFailed).not.toHaveBeenCalled()
    await f.rail.close()
  })

  it.each([
    { action: 'open', rejectSnapshot: false },
    { action: 'close', rejectSnapshot: false },
    { action: 'open', rejectSnapshot: true },
    { action: 'close', rejectSnapshot: true },
  ])('a superseded snapshot cannot override newer $action (rejected: $rejectSnapshot)', async ({ action, rejectSnapshot }) => {
    const f = await fixture()
    const first = current(f.rail).session
    await f.rail.newSession()
    const gate = deferred()
    const snapshot = f.gateway.snapshot.bind(f.gateway)
    const read = vi.spyOn(f.gateway, 'snapshot').mockImplementation(async (session) => {
      await gate.promise
      if (rejectSnapshot) throw new Error('session no longer served')
      return snapshot(session)
    })
    const resume = f.rail.resume(first.sessionId)
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    const newer = action === 'open' ? f.rail.open('vault-b', '/b') : f.rail.close()
    gate.resolve()
    await Promise.all([resume, newer])
    if (action === 'open') expect(current(f.rail).vaultId).toBe('vault-b')
    else expect(f.rail.state.value).toEqual({ kind: 'idle' })
    expect(f.onResumeFailed).not.toHaveBeenCalled()
    await f.rail.close()
  })

  it.each(['new', 'load'] as const)('retains a superseded successful %s acquisition', async (action) => {
    const f = await fixture()
    const historical = current(f.rail).session
    if (action === 'load') await f.rail.retry()
    const gate = deferred()
    let acquired = ''
    if (action === 'new') {
      const open = f.composition.openSession.bind(f.composition)
      vi.spyOn(f.composition, 'openSession').mockImplementationOnce(async (request) => {
        const session = await open(request)
        acquired = session.sessionId
        await gate.promise
        return session
      })
    } else {
      const load = f.gateway.loadSession.bind(f.gateway)
      vi.spyOn(f.gateway, 'loadSession').mockImplementationOnce(async (sessionId, request) => {
        const session = await load(sessionId, request)
        acquired = session.sessionId
        await gate.promise
        return session
      })
    }
    const older = action === 'new' ? f.rail.newSession() : f.rail.resume(historical.sessionId)
    await vi.waitFor(() => expect(acquired).not.toBe(''))
    const newer = f.rail.newSession()
    gate.resolve()
    await Promise.all([older, newer])
    expect(current(f.rail).session.sessionId).not.toBe(acquired)
    const loads = vi.spyOn(f.gateway, 'loadSession')
    loads.mockClear()
    await f.rail.resume(acquired)
    expect(current(f.rail).session.sessionId).toBe(acquired)
    expect(loads).not.toHaveBeenCalled()
    expect(f.onResumeFailed).not.toHaveBeenCalled()
    await f.rail.close()
  })

  it.each(['new', 'load'] as const)('a successful superseded %s cannot restore a stopped runtime', async (action) => {
    const f = await fixture()
    const historical = current(f.rail).session
    if (action === 'load') await f.rail.retry()
    const gate = deferred()
    const acquired: { session: typeof historical | null } = { session: null }
    if (action === 'new') {
      const open = f.composition.openSession.bind(f.composition)
      vi.spyOn(f.composition, 'openSession').mockImplementationOnce(async (request) => {
        const session = await open(request)
        acquired.session = session
        await gate.promise
        return session
      })
    } else {
      const load = f.gateway.loadSession.bind(f.gateway)
      vi.spyOn(f.gateway, 'loadSession').mockImplementationOnce(async (sessionId, request) => {
        const session = await load(sessionId, request)
        acquired.session = session
        await gate.promise
        return session
      })
    }
    const older = action === 'new' ? f.rail.newSession() : f.rail.resume(historical.sessionId)
    await vi.waitFor(() => expect(acquired.session).not.toBeNull())
    const closing = f.rail.close()
    gate.resolve()
    await Promise.all([older, closing])
    expect(f.rail.state.value).toEqual({ kind: 'idle' })
    expect(f.rail.composition.value).toBeNull()
    await f.rail.open('vault-a', '/a')
    const stoppedSession = acquired.session!
    await f.rail.resume(stoppedSession.sessionId)
    expect(current(f.rail).session.runtimeEpoch).not.toBe(stoppedSession.runtimeEpoch)
    expect(f.onResumeFailed).not.toHaveBeenCalled()
    await f.rail.close()
  })
})
