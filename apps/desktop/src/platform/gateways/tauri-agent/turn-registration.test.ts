import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTauriAgentIpc } from '../tauri-agent'
import { createEventChannel } from './channel'
import { ToolProjection } from './tools'
import { createAgentTurns } from './turns'
import { TURN_LIVENESS_BOUND_MS } from './turn-bound'

const identity = {
  agentId: 'agent', profileId: 'profile', runtimeEpoch: 'epoch',
  vaultId: 'vault', sessionId: 'session',
}

function fixture() {
  let resolve!: (release: () => void) => void
  let reject!: (error: unknown) => void
  const registration = new Promise<() => void>((yes, no) => { resolve = yes; reject = no })
  const unlisten = vi.fn()
  const ipc = {
    ...createTauriAgentIpc(),
    onEvent: vi.fn(() => registration),
    prompt: vi.fn(async () => 'run'),
  }
  const channel = createEventChannel({
    ipc, tools: new ToolProjection(), onFrame: () => {}, report: () => {},
  })
  return { turns: createAgentTurns(ipc, channel), ipc, resolve, reject, unlisten }
}

afterEach(() => vi.useRealTimers())

describe('turn cancellation during listener registration', () => {
  it.each(['close', 'timeout', 'stop'] as const)('%s settles without waiting for registration', async (action) => {
    vi.useFakeTimers()
    const f = fixture()
    let result: unknown = 'pending'
    const outcome = f.turns.prompt(identity, 'must not be sent', [])
      .catch((error: unknown) => { result = error })
    if (action === 'close') f.turns.closeSession(identity.sessionId)
    else if (action === 'stop') f.turns.stop()
    else await vi.advanceTimersByTimeAsync(TURN_LIVENESS_BOUND_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toMatchObject({ code: action === 'timeout' ? 'timeout' : 'cancelled' })
    f.resolve(f.unlisten)
    await outcome
    await vi.advanceTimersByTimeAsync(0)
    expect(f.ipc.prompt).not.toHaveBeenCalled()
    // stop() pairs with channel.closeAll() in the gateway; the other paths release their hold.
    if (action !== 'stop') expect(f.unlisten).toHaveBeenCalledOnce()
  })

  it('a refused registration rejects without leaving an unhandled cleanup failure', async () => {
    const f = fixture()
    const outcome = f.turns.prompt(identity, 'not sent', []).catch((error: unknown) => error)
    f.reject(new Error('listener unavailable'))
    expect(await outcome).toMatchObject({ message: 'listener unavailable' })
    expect(f.ipc.prompt).not.toHaveBeenCalled()
  })
})
