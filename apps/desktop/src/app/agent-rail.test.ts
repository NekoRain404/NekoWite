/**
 * The rail's agent half, driven without a window.
 *
 * What this file is for: the four rules `agent-rail.ts` states — the work starts on demand and
 * is not owned by the panel, a vault change replaces the runtime rather than adding one, a
 * refusal is data with both ways out, and a request that has been superseded never becomes the
 * state. Every one of them is a race or an ordering rather than a shape, so none of them can be
 * asserted from a rendered tree.
 *
 * The compositions below wrap a **real** memory gateway (`createMemoryAgentGateway`) instead of
 * a stub object: `AgentSession` is branded so that a session nobody opened cannot be written by
 * hand, and a test that cast one would stop checking the thing the rail passes on.
 */
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createAgentRail, failureSentence, railKey } from './agent-rail'
import type { AgentComposition } from './agent-composition'
import { createMemoryAgentGateway } from '../platform/gateways/memory-agent'
import type { AgentOpenRequest, AgentSession } from '../platform/gateways/agent-contracts'

/** A composition that answers from the memory runtime, with its three calls observable. The
 *  gateway can be shared between two compositions, which is what a vault switch is: the same
 *  adapter wrapped by a new composition, and a new runtime epoch under it. */
function fakeComposition(
  options: { refuseWith?: string; gateway?: ReturnType<typeof createMemoryAgentGateway> } = {},
) {
  const gateway = options.gateway ?? createMemoryAgentGateway({ agentId: 'opencode', profileId: 'default' })
  const start = vi.fn(async () => {
    await gateway.start()
  })
  const stop = vi.fn(async () => {
    await gateway.stop()
  })
  const opened: AgentOpenRequest[] = []
  const composition: AgentComposition = {
    gateway,
    start,
    openSession: async (request: AgentOpenRequest): Promise<AgentSession> => {
      opened.push(request)
      await gateway.start()
      if (options.refuseWith !== undefined) throw options.refuseWith
      return gateway.openSession(request)
    },
    stop,
    // T11's insertion binding is part of the interface and none of these tests asks for it: the
    // rail hands the composition to a caller that does, and a stand-in here would be a claim
    // about a path this file does not exercise.
    connectSvgInsertion: () => {
      throw new Error('connectSvgInsertion is not part of this test')
    },
  }
  return { composition, start, stop, opened }
}

/**
 * Every step of the rail is queued behind the previous one, so `open`, `retry` and `close` are
 * awaited rather than guessed at: they resolve when the attempt has settled, which is the
 * property the API was shaped for.
 */

/** Wait for a condition that a promise cannot express (a callback that has not fired yet). */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !condition(); i += 1) await Promise.resolve()
  if (!condition()) throw new Error('the condition never became true')
}

describe('the agent rail', () => {
  it('composes nothing until it is asked to', () => {
    const compose = vi.fn()
    const rail = createAgentRail({ compose })
    expect(rail.state.value).toEqual({ kind: 'idle' })
    expect(compose).not.toHaveBeenCalled()
  })

  it('starts a runtime and opens a session for the vault it was asked for', async () => {
    const fake = fakeComposition()
    const rail = createAgentRail({ compose: () => fake.composition })

    await rail.open('vault-a', '/notes/a')

    const state = rail.state.value
    expect(state.kind).toBe('live')
    if (state.kind !== 'live') throw new Error('unreachable')
    expect(state.vaultId).toBe('vault-a')
    expect(fake.opened).toEqual([{ vaultId: 'vault-a', cwd: '/notes/a' }])
    expect(state.gateway).toBe(fake.composition.gateway)
    expect(state.session.vaultId).toBe('vault-a')
    // The key is the epoch and the session, which is what makes a session change a remount
    // rather than a re-point (T6's report §8.2).
    expect(state.key).toBe(railKey(state.session))
    expect(state.key).toContain(state.session.runtimeEpoch)
  })

  it('is idempotent for the vault already live', async () => {
    const fake = fakeComposition()
    const compose = vi.fn(() => fake.composition)
    const rail = createAgentRail({ compose })

    await rail.open('vault-a', '/notes/a')
    rail.open('vault-a', '/notes/a')
    await rail.open('vault-a', '/notes/a')

    expect(compose).toHaveBeenCalledTimes(1)
    expect(fake.opened).toHaveLength(1)
    expect(fake.stop).not.toHaveBeenCalled()
  })

  it('replaces the runtime when the vault changes, and never shows the old session as current', async () => {
    const gateway = createMemoryAgentGateway({ agentId: 'opencode', profileId: 'default' })
    const first = fakeComposition({ gateway })
    const second = fakeComposition({ gateway })
    const made = [first, second]
    const rail = createAgentRail({ compose: () => made.shift()!.composition })

    await rail.open('vault-a', '/notes/a')
    const before = rail.state.value
    expect(before.kind).toBe('live')

    await rail.open('vault-b', '/notes/b')

    const after = rail.state.value
    expect(after.kind).toBe('live')
    if (after.kind !== 'live' || before.kind !== 'live') throw new Error('unreachable')
    expect(first.stop).toHaveBeenCalledTimes(1)
    expect(after.session.vaultId).toBe('vault-b')
    // A different session under a new key: the panel is mounted fresh rather than re-pointed.
    expect(after.key).not.toBe(before.key)
    expect(second.opened).toEqual([{ vaultId: 'vault-b', cwd: '/notes/b' }])
  })

  it('shows a refusal as the backend said it, and asks again on retry', async () => {
    const refused = fakeComposition({ refuseWith: 'the bundled engine was not found beside /usr/bin' })
    const accepted = fakeComposition()
    const made = [refused, accepted]
    const compose = vi.fn(() => made.shift()!.composition)
    const rail = createAgentRail({ compose })

    await rail.open('vault-a', '/notes/a')
    expect(rail.state.value).toEqual({
      kind: 'refused',
      vaultId: 'vault-a',
      reason: 'the bundled engine was not found beside /usr/bin',
    })

    // A refusal is terminal for that attempt: the caller watching the switch and the vault is
    // not what asks again, so two identical opens do not hammer a runtime that just said no.
    await rail.open('vault-a', '/notes/a')
    expect(compose).toHaveBeenCalledTimes(1)

    await rail.retry()
    expect(compose).toHaveBeenCalledTimes(2)
    expect(rail.state.value.kind).toBe('live')
    expect(accepted.opened).toEqual([{ vaultId: 'vault-a', cwd: '/notes/a' }])
  })

  it('does nothing on a retry that has never been asked anything', async () => {
    const compose = vi.fn()
    const rail = createAgentRail({ compose })
    await rail.retry()
    expect(compose).not.toHaveBeenCalled()
    expect(rail.state.value).toEqual({ kind: 'idle' })
  })

  it('a close during a start wins: the session it was opening never becomes the state', async () => {
    let release: (() => void) | null = null
    const gateway = createMemoryAgentGateway({ agentId: 'opencode', profileId: 'default' })
    const stop = vi.fn(async () => {
      await gateway.stop()
    })
    const composition: AgentComposition = {
      gateway,
      start: async () => {
        await gateway.start()
      },
      openSession: async (request: AgentOpenRequest): Promise<AgentSession> => {
        await gateway.start()
        // Parked here while the switch goes off, which is the race the generation guards.
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return gateway.openSession(request)
      },
      stop,
      connectSvgInsertion: () => {
        throw new Error('connectSvgInsertion is not part of this test')
      },
    }
    const rail = createAgentRail({ compose: () => composition })

    const opening = rail.open('vault-a', '/notes/a')
    // Parked inside the session call, which is the moment the switch can go off.
    await until(() => release !== null)
    // Queued behind the start, so it runs only once that parked call has answered — and the
    // answer must not be allowed to become the state.
    const closing = rail.close()
    release!()
    await opening
    expect(rail.state.value.kind).not.toBe('live')
    await closing
    await nextTick()

    expect(rail.state.value).toEqual({ kind: 'idle' })
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('stops the runtime on close and reports a stop that failed', async () => {
    const fake = fakeComposition()
    const failure = new Error('the backend was gone')
    fake.stop.mockRejectedValueOnce(failure)
    const onStopFailed = vi.fn()
    const rail = createAgentRail({ compose: () => fake.composition, onStopFailed })

    await rail.open('vault-a', '/notes/a')
    await rail.close()

    expect(fake.stop).toHaveBeenCalledTimes(1)
    expect(onStopFailed).toHaveBeenCalledWith(failure)
    // The window still has to be able to say the runtime is gone: a stop that failed is
    // reported and the rail moves on rather than staying on a state it no longer holds.
    expect(rail.state.value).toEqual({ kind: 'idle' })
  })

  it('closing twice, and closing before anything was opened, is not an error', async () => {
    const fake = fakeComposition()
    const rail = createAgentRail({ compose: () => fake.composition })
    await rail.close()
    await rail.open('vault-a', '/notes/a')
    await rail.close()
    await rail.close()
    expect(fake.stop).toHaveBeenCalledTimes(1)
  })
})

describe('failureSentence', () => {
  it('passes the backend’s own sentence through, unchanged', () => {
    // The Rust commands answer `Result<_, String>`, and every refusal is written for the reader:
    // paraphrasing one here would be inventing a second, worse answer.
    expect(failureSentence('no profile "default" is bound to opencode')).toBe(
      'no profile "default" is bound to opencode',
    )
  })

  it('uses an Error’s message, and says so when there is neither', () => {
    expect(failureSentence(new Error('boom'))).toBe('boom')
    expect(failureSentence(undefined)).not.toBe('')
    expect(failureSentence({ weird: true })).not.toBe('')
    expect(failureSentence('   ')).not.toBe('')
  })
})
