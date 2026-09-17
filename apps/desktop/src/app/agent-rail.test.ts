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
import { AgentFailure } from '../platform/gateways/agent-contracts'
import type { AgentOpenRequest, AgentSession } from '../platform/gateways/agent-contracts'
import type {
  AgentRegistryClient,
  AgentRegistryEntry,
  AgentRegistryReadout,
} from '../features/agent-settings/services/agent-registry-policy'

/** A composition that answers from the memory runtime, with its three calls observable. The
 *  gateway can be shared between two compositions, which is what a vault switch is: the same
 *  adapter wrapped by a new composition, and a new runtime epoch under it. */
function fakeComposition(
  options: {
    refuseWith?: string
    gateway?: ReturnType<typeof createMemoryAgentGateway>
    registry?: AgentRegistryClient
  } = {},
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
    // T13a's registry client is part of the interface and most of these tests do not ask for it:
    // the rail hands the composition to whoever mounts the settings section, and a stand-in that
    // answered would be a claim about a path this file does not exercise. The exception is the
    // engine's own name, which the rail reads out of the registry — see `registryOf`.
    registry: options.registry ?? unsupportedRegistry(),
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
    // Nothing to reach either: a surface that asked for the composition before a runtime exists
    // gets nothing rather than an object that would answer for a vault nobody opened.
    expect(rail.composition.value).toBeNull()
  })

  it('publishes the live composition, and takes it back when the runtime goes down', async () => {
    // The editor pane's note surface is in another subtree and reaches this file through the
    // shell: `connectSvgInsertion` exists on the composition and nowhere else, so a composition
    // this file kept to itself was a binding no part of the app could mint. What is pinned here
    // is the pairing — published exactly while a runtime is up, and null the moment it is not,
    // which is what makes a binding minted after a stop a binding to nothing.
    const fake = fakeComposition()
    const rail = createAgentRail({ compose: () => fake.composition })

    await rail.open('vault-a', '/notes/a')
    expect(rail.composition.value).toBe(fake.composition)

    await rail.close()
    expect(rail.state.value).toEqual({ kind: 'idle' })
    expect(rail.composition.value).toBeNull()

    // And a reopen publishes the new one, which is a different object: a vault switch is a new
    // runtime, so a surface holding the previous binding would be holding a stopped engine's.
    const next = fakeComposition()
    const second = createAgentRail({ compose: () => next.composition })
    await second.open('vault-b', '/notes/b')
    expect(second.composition.value).toBe(next.composition)
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

  it('names the engine from the registration the backend holds, not from a constant here', async () => {
    const fake = fakeComposition({
      registry: registryOf([
        { agentId: 'someone-else', displayName: 'Another Engine' },
        { agentId: 'opencode', displayName: 'OpenCode' },
      ]),
    })
    const rail = createAgentRail({ compose: () => fake.composition })

    await rail.open('vault-a', '/notes/a')

    const state = rail.state.value
    if (state.kind !== 'live') throw new Error('unreachable')
    // §3.4's rule that no component learns an engine's name: the sentence the panel draws gets
    // the name for *this* session's agent, out of the entries beside it.
    expect(state.engineName).toBe('OpenCode')
  })

  it('falls back to the agent id when nothing answers for it — an id is a fact', async () => {
    const missing = fakeComposition({ registry: registryOf([]) })
    const rail = createAgentRail({ compose: () => missing.composition })

    await rail.open('vault-a', '/notes/a')

    const state = rail.state.value
    if (state.kind !== 'live') throw new Error('unreachable')
    // No registration describes this agent, so the panel is named by its id rather than by a
    // word this file chose. The same arm covers the registry below.
    expect(state.engineName).toBe('opencode')

    // And a registry that cannot be read at all is the same answer, not a refusal: the session
    // is already open, and everything else the panel needs arrived with it.
    const unreadable = fakeComposition({ registry: unsupportedRegistry() })
    const second = createAgentRail({ compose: () => unreadable.composition })
    await second.open('vault-a', '/notes/a')

    const after = second.state.value
    if (after.kind !== 'live') throw new Error('unreachable')
    expect(after.engineName).toBe('opencode')
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
      registry: unsupportedRegistry(),
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

/**
 * The other way between two sessions of one runtime, and the races it shares with `open`.
 *
 * A rail is driven into the state a history exists for — one session the engine still lists but
 * the current runtime no longer serves, and one it is serving now — by asking twice: the first
 * `open` is a session of the epoch that the second one replaced. Everything below is about the
 * step the panel's history control leads to, including the two orderings that would otherwise
 * arrive as "the loaded session is suddenly the live one".
 */
describe('the agent rail — reopening a session the engine holds', () => {
  /** A rail over one memory runtime, with a first session the runtime has since been replaced
   *  under and a second one it is serving. Returns what each case needs to ask for the older. */
  async function twoSessions(options: { onResumeFailed?: (error: unknown) => void } = {}) {
    const gateway = createMemoryAgentGateway({ agentId: 'opencode', profileId: 'default' })
    const fake = fakeComposition({ gateway })
    const loads: string[] = []
    const load = gateway.loadSession.bind(gateway)
    gateway.loadSession = async (sessionId, request) => {
      loads.push(sessionId)
      return load(sessionId, request)
    }
    const rail = createAgentRail({
      compose: () => fake.composition,
      ...(options.onResumeFailed ? { onResumeFailed: options.onResumeFailed } : {}),
    })
    await rail.open('vault-a', '/notes/a')
    const earlier = rail.state.value
    await rail.retry()
    const later = rail.state.value
    if (earlier.kind !== 'live' || later.kind !== 'live') throw new Error('unreachable')
    return { gateway, fake, rail, loads, earlier, later, load }
  }

  it('re-adopts the session and makes it the one on screen, under a new key', async () => {
    const { rail, loads, earlier, later, fake } = await twoSessions()

    await rail.resume(earlier.session.sessionId)

    expect(loads).toEqual([earlier.session.sessionId])
    const after = rail.state.value
    if (after.kind !== 'live') throw new Error('unreachable')
    expect(after.session.sessionId).toBe(earlier.session.sessionId)
    // The vault and folder are the ones the runtime was started for, not the ones the session
    // was recorded in: a load is a move within this runtime, and its vault does not change.
    expect(after.vaultId).toBe('vault-a')
    expect(after.cwd).toBe('/notes/a')
    // A session change is a remount: the panel is keyed by epoch and session id.
    expect(after.key).toBe(railKey(after.session))
    expect(after.key).not.toBe(later.key)
    // The same runtime throughout — one stop, from the retry that replaced the first epoch.
    expect(fake.stop).toHaveBeenCalledTimes(1)
  })

  /**
   * The point of the whole gesture: the conversation comes back.
   *
   * `session/load` exists for this and nothing else — ACP documents `resume` as the variant that
   * returns no previous messages — and the engine was measured handing the history over as
   * ordinary `session/update` frames during the call (`agent_session_replay_live_test.rs`:
   * `seq=1 run=Some("load-0") text-delta String("PONG")`). What the *window* then sees depends on
   * one detail that is easy to get wrong in the middle layer: a turn-scoped frame naming no run is
   * dropped by the reducer (`agent-event-reducer.ts`, `unattributed-run`), so a replay stamped
   * `runId: null` reaches the panel as an empty transcript.
   *
   * This is the test that fails when the double stamps one — it did, and this is why the double
   * now mints a load run the way `AgentRuntime::load_session` does.
   */
  it('brings the conversation back, as frames the window can attribute', async () => {
    const gateway = createMemoryAgentGateway({ agentId: 'opencode', profileId: 'default' })
    const fake = fakeComposition({ gateway })
    const rail = createAgentRail({ compose: () => fake.composition })
    await rail.open('vault-a', '/notes/a')
    const earlier = rail.state.value
    if (earlier.kind !== 'live') throw new Error('unreachable')

    // A turn, so there is a conversation to restore.
    await gateway.prompt(earlier.session, 'remember this')
    const before = await gateway.snapshot(earlier.session)
    expect(before.events.some((event) => event.kind === 'text-delta')).toBe(true)

    // The runtime is replaced, which is what makes the earlier session one the engine *holds*
    // rather than one this runtime serves — the state a history row is picked from.
    await rail.retry()

    await rail.resume(earlier.session.sessionId)
    const after = rail.state.value
    if (after.kind !== 'live') throw new Error('unreachable')
    expect(after.session.sessionId).toBe(earlier.session.sessionId)

    const replayed = await gateway.snapshot(after.session)
    const text = replayed.events.filter((event) => event.kind === 'text-delta')
    expect(text.length).toBeGreaterThan(0)
    // Attributed to a run, which is what keeps the reducer from dropping it. The id is the
    // double's own load run; that it is not null is the whole claim.
    expect(text.every((event) => event.runId !== null)).toBe(true)
    expect(text.map((event) => event.payload)).toEqual(
      before.events
        .filter((event) => event.kind === 'text-delta')
        .map((event) => event.payload),
    )
  })

  it('does not call for the session already on screen', async () => {
    const { rail, loads, later } = await twoSessions()

    await rail.resume(later.session.sessionId)

    // The engine refuses a load of a session it is serving, and the row is drawn as the open one
    // rather than offered as a call that cannot work.
    expect(loads).toEqual([])
    expect(rail.state.value).toBe(later)
  })

  it('does nothing at all when no runtime is up', async () => {
    const fake = fakeComposition()
    const rail = createAgentRail({ compose: () => fake.composition })

    await rail.resume('session-1')

    expect(rail.state.value).toEqual({ kind: 'idle' })
    expect(fake.opened).toEqual([])
    expect(fake.stop).not.toHaveBeenCalled()
  })

  it('reports a refusal and keeps the session that was open', async () => {
    const onResumeFailed = vi.fn()
    const { rail, gateway, later, earlier } = await twoSessions({ onResumeFailed })
    const failure = new AgentFailure('session-stale', 'the engine does not hold that session')
    gateway.loadSession = async () => {
      throw failure
    }

    await rail.resume(earlier.session.sessionId)

    expect(onResumeFailed).toHaveBeenCalledWith(failure)
    // The user stays where they were. A load that failed is not a reason to take a running
    // conversation off the screen, and the rail has no arm for "live, with a notice" — which is
    // why this is the one failure on this path the caller has to draw.
    expect(rail.state.value).toBe(later)
  })

  it('a close during a reopen wins: the loaded session never becomes the state', async () => {
    const { rail, gateway, earlier, later } = await twoSessions()
    let release: (() => void) | null = null
    const load = gateway.loadSession.bind(gateway)
    gateway.loadSession = async (sessionId, request) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return load(sessionId, request)
    }

    const reopening = rail.resume(earlier.session.sessionId)
    // Parked inside the load, which is the moment the switch can go off or the vault can change.
    await until(() => release !== null)
    const closing = rail.close()
    release!()
    await reopening
    await closing
    await nextTick()

    // The answer of a runtime that is on its way out must not arrive as if it were the current
    // one: same latch as `open`, because this is the same question.
    expect(rail.state.value).toEqual({ kind: 'idle' })
    expect(later.session.sessionId).not.toBe(earlier.session.sessionId)
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

/**
 * The registry client, as this file's compositions stand in for it.
 *
 * T13a's settings section is the only caller and it is mounted elsewhere; `AgentComposition` carries
 * the client so that section does not reach for a singleton, so a literal here has to name it. Every
 * method throws rather than answering, because an answer would be this file claiming something
 * about a path it does not exercise.
 */
function unsupportedRegistry(): AgentRegistryClient {
  const unsupported = (): never => {
    throw new Error('the registry is not part of this test')
  }
  return { read: unsupported, add: unsupported, setEnabled: unsupported }
}

/**
 * A registry that answers, for the one value the rail reads out of it: the engine's own name.
 *
 * Only the fields the name is read from are varied — everything else is the shape a bundled
 * registration has, because a test that filled in a program path would be asserting a fact
 * about the backend rather than about the rail.
 */
function registryOf(entries: Array<{ agentId: string; displayName: string }>): AgentRegistryClient {
  const readout: AgentRegistryReadout = {
    defaultAgentId: entries[0]?.agentId ?? 'opencode',
    entries: entries.map(
      (entry): AgentRegistryEntry => ({
        ...entry,
        source: 'bundled',
        program: '/usr/bin/opencode',
        args: [],
        env: 'profile-isolated',
        envExtra: [],
        enabled: true,
        adapterId: entry.agentId,
        reportedVersion: null,
        programState: 'launchable',
      }),
    ),
    adapterIds: entries.map((entry) => entry.agentId),
    runningAgentIds: [],
    profileOwners: Object.fromEntries(entries.map((entry) => ['default', entry.agentId])),
  }
  const notThisTest = (): never => {
    throw new Error('the rail reads the registry and writes nothing')
  }
  return { read: async () => readout, add: notThisTest, setEnabled: notThisTest }
}
