import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionSnapshot } from '../agent-contracts'
import { createTauriAgentIpc } from './ipc'
import { createEventChannel } from './channel'
import type { AgentHostSnapshot } from './ipc'
import type { SessionRecord } from './session'
import { ToolProjection } from './tools'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

const identity = {
  agentId: 'agent', profileId: 'profile', runtimeEpoch: 'epoch',
  vaultId: 'vault', sessionId: 'session',
}
const record: SessionRecord = {
  identity, models: [], initialModelId: '', modelOptionId: null, options: [],
}
const from: AgentSessionSnapshot = {
  identity, state: 'idle', runId: null, sequence: 0, events: [], permissions: [],
}
const host: AgentHostSnapshot = {
  ...from, sequence: 1, events: [{
    ...identity, sequence: 1, runId: 'run', kind: 'text-delta', payload: { text: 'old' },
  }],
}

function fixture() {
  const unlisten = vi.fn()
  const ipc = {
    ...createTauriAgentIpc(),
    onEvent: vi.fn(async (): Promise<() => void> => unlisten),
    snapshot: vi.fn(async (): Promise<AgentHostSnapshot> => host),
  }
  const report = vi.fn()
  const channel = createEventChannel({ ipc, tools: new ToolProjection(), report, onFrame: vi.fn() })
  return { channel, ipc, unlisten, report }
}

describe('agent subscription lifecycle', () => {
  it('shutdown does not wait for a pending registration or resurrect its subscription', async () => {
    const f = fixture()
    const registration = deferred<() => void>()
    f.ipc.onEvent.mockReturnValueOnce(registration.promise)
    const old = f.channel.subscribe(record, from, vi.fn()).catch((error: unknown) => error)
    let stopped = false
    const closing = f.channel.closeAll().then(() => { stopped = true })
    for (let n = 0; n < 10; n++) await Promise.resolve()
    expect(stopped).toBe(true)
    registration.resolve(f.unlisten)
    await closing
    expect(await old).toMatchObject({ code: 'cancelled' })
    expect(f.ipc.snapshot).not.toHaveBeenCalled()
    expect(f.unlisten).toHaveBeenCalledOnce()
  })

  it('retries registration after an earlier subscription registration failed', async () => {
    const f = fixture()
    f.ipc.onEvent.mockRejectedValueOnce(new Error('registration failed'))
    await expect(f.channel.subscribe(record, from, vi.fn())).rejects.toThrow('registration failed')
    const stop = await f.channel.subscribe(record, from, vi.fn())
    expect(f.ipc.onEvent).toHaveBeenCalledTimes(2)
    stop()
    await vi.waitFor(() => expect(f.unlisten).toHaveBeenCalledOnce())
  })

  it('does not replay a snapshot that returns after shutdown', async () => {
    const f = fixture()
    const pending = deferred<AgentHostSnapshot>()
    f.ipc.snapshot.mockReturnValueOnce(pending.promise)
    const seen = vi.fn()
    const outcome = f.channel.subscribe(record, from, seen).catch((error: unknown) => error)
    await vi.waitFor(() => expect(f.ipc.snapshot).toHaveBeenCalledOnce())
    await f.channel.closeAll()
    pending.resolve(host)
    expect(await outcome).toMatchObject({ code: 'cancelled' })
    expect(seen).not.toHaveBeenCalled()
    expect(f.unlisten).toHaveBeenCalledOnce()
  })

  it('old snapshot failure cannot release a replacement listener', async () => {
    const f = fixture()
    const pending = deferred<AgentHostSnapshot>()
    f.ipc.snapshot.mockReturnValueOnce(pending.promise)
    const old = f.channel.subscribe(record, from, vi.fn()).catch((error: unknown) => error)
    await vi.waitFor(() => expect(f.ipc.snapshot).toHaveBeenCalledOnce())
    await f.channel.closeAll()
    const replacementRelease = vi.fn()
    f.ipc.onEvent.mockResolvedValueOnce(replacementRelease)
    const stop = await f.channel.subscribe(record, from, vi.fn())
    pending.resolve({ ...host, identity: { ...identity, runtimeEpoch: 'wrong' } })
    await old
    expect(replacementRelease).not.toHaveBeenCalled()
    stop()
    await vi.waitFor(() => expect(replacementRelease).toHaveBeenCalledOnce())
  })
})
