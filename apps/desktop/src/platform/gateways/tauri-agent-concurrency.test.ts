import { describe, expect, it, vi } from 'vitest'
import { AgentFailure, type AgentSession } from './agent-contracts'
import { createTauriAgentGateway, createTauriAgentIpc } from './tauri-agent'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function fixture() {
  let listener: (frame: unknown) => void = () => {}
  let nextSession = 0
  const replies = new Map<string, ReturnType<typeof deferred<string>>>()
  const ipc = {
    ...createTauriAgentIpc(),
    start: async () => ({ agentId: 'agent', profileId: 'profile', runtimeEpoch: 'epoch' }),
    openSession: async () => ({ sessionId: `session-${++nextSession}`, configOptions: [], modelOptionId: null }),
    closeSession: async () => {},
    cancel: async () => {},
    stop: async () => {},
    onEvent: async (receive: (frame: unknown) => void) => { listener = receive; return () => {} },
    prompt: vi.fn((sessionId: string) => {
      const reply = deferred<string>()
      replies.set(sessionId, reply)
      return reply.promise
    }),
  }
  const gateway = createTauriAgentGateway({ vaultId: 'vault', ipc })
  await gateway.start()
  const a = await gateway.openSession({ vaultId: 'vault', cwd: '/vault' })
  const b = await gateway.openSession({ vaultId: 'vault', cwd: '/vault' })
  const finish = (session: AgentSession, runId: string, overrides = {}) => listener({
    ...session, runId, sequence: 1, kind: 'run-finished',
    payload: { stopReason: 'end_turn', usage: null }, ...overrides,
  })
  return { gateway, ipc, a, b, replies, finish }
}

describe('concurrent session prompts', () => {
  it.each([false, true])('keeps early endings for both sessions (reverse replies: %s)', async (reverse) => {
    const f = await fixture()
    const outcomes = [f.gateway.prompt(f.a, 'a'), f.gateway.prompt(f.b, 'b')]
      .map((promise) => promise.catch((error: unknown) => error))
    await vi.waitFor(() => expect(f.ipc.prompt).toHaveBeenCalledTimes(2))
    f.finish(f.a, 'run-a')
    f.finish(f.b, 'run-b')
    const order = reverse ? [f.b, f.a] : [f.a, f.b]
    for (const session of order) {
      f.replies.get(session.sessionId)!.resolve(session === f.a ? 'run-a' : 'run-b')
      await Promise.resolve()
    }
    expect(await Promise.all(outcomes)).toEqual([
      { stopReason: 'end-turn', usage: null }, { stopReason: 'end-turn', usage: null },
    ])
    await f.gateway.stop()
  })

  it('rejecting one prompt leaves the other session early ending intact', async () => {
    const f = await fixture()
    const failed = f.gateway.prompt(f.a, 'a').catch((error: unknown) => error)
    const survived = f.gateway.prompt(f.b, 'b').catch((error: unknown) => error)
    await vi.waitFor(() => expect(f.ipc.prompt).toHaveBeenCalledTimes(2))
    f.finish(f.b, 'run-b')
    f.replies.get(f.a.sessionId)!.reject(new AgentFailure('process-exited', 'refused'))
    await expect(failed).resolves.toMatchObject({ code: 'process-exited' })
    f.replies.get(f.b.sessionId)!.resolve('run-b')
    await expect(survived).resolves.toEqual({ stopReason: 'end-turn', usage: null })
    await f.gateway.stop()
  })

  it('close cancels a starting turn without affecting another session', async () => {
    const f = await fixture()
    const cancelled = f.gateway.prompt(f.a, 'a').catch((error: unknown) => error)
    const survived = f.gateway.prompt(f.b, 'b').catch((error: unknown) => error)
    await vi.waitFor(() => expect(f.ipc.prompt).toHaveBeenCalledTimes(2))
    await f.gateway.closeSession(f.a.sessionId)
    f.finish(f.b, 'run-b')
    f.replies.get(f.a.sessionId)!.resolve('run-a')
    f.replies.get(f.b.sessionId)!.resolve('run-b')
    expect(await cancelled).toMatchObject({ code: 'cancelled' })
    expect(await survived).toEqual({ stopReason: 'end-turn', usage: null })
    await f.gateway.stop()
  })

  it.each(['agentId', 'profileId', 'runtimeEpoch', 'vaultId', 'runId'])('ignores early endings from another %s', async (field) => {
    const f = await fixture()
    const outcome = f.gateway.prompt(f.a, 'a')
    await vi.waitFor(() => expect(f.ipc.prompt).toHaveBeenCalledOnce())
    f.finish(f.a, 'run-a', { [field]: 'foreign', payload: { stopReason: 'cancelled', usage: null } })
    f.finish(f.a, 'run-a')
    f.replies.get(f.a.sessionId)!.resolve('run-a')
    await expect(outcome).resolves.toEqual({ stopReason: 'end-turn', usage: null })
    await f.gateway.stop()
  })

  it('cancel preserves both starting turns until their ending events arrive', async () => {
    const f = await fixture()
    const first = f.gateway.prompt(f.a, 'a')
    const second = f.gateway.prompt(f.b, 'b')
    await vi.waitFor(() => expect(f.ipc.prompt).toHaveBeenCalledTimes(2))
    await f.gateway.cancel(f.a)
    await expect(f.gateway.prompt(f.a, 'duplicate')).rejects.toMatchObject({ code: 'turn-in-flight' })
    f.finish(f.a, 'run-a', { payload: { stopReason: 'cancelled', usage: null } })
    f.finish(f.b, 'run-b')
    f.replies.get(f.a.sessionId)!.resolve('run-a')
    f.replies.get(f.b.sessionId)!.resolve('run-b')
    await expect(first).resolves.toMatchObject({ stopReason: 'cancelled' })
    await expect(second).resolves.toMatchObject({ stopReason: 'end-turn' })
    await f.gateway.stop()
  })
})
