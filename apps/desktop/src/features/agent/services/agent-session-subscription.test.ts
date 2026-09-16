/**
 * The handshake's own rules: what it tells the caller, and the order it does its work in.
 *
 * The store's tests drive the interleavings through the view the reader sees; these are the
 * answers the subscription module owes the store, which the view alone cannot show — whether
 * a snapshot was committed, whether a listener was registered, and which of those came first.
 * The memory double provides a real session and real snapshots; the two calls that decide an
 * outcome are the ones a test replaces.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  AgentFailure,
  type AgentSession,
} from '../../../platform/gateways/agent-contracts'
import { createMemoryAgentGateway, type MemoryAgentGateway } from '../../../platform/gateways/memory-agent'
import {
  closeSubscription,
  createSubscription,
  hasNothingToPreserve,
  openSubscription,
} from './agent-session-subscription'
import { initialAgentSessionView, startAgentRun, type AgentSessionView } from './agent-session-view'

const AGENT_ID = 'agent-1'
const PROFILE_ID = 'profile-1'

/** A started gateway with one open session, the way the composition site hands them over. */
async function opened(vaultId = 'vault-1'): Promise<{ gateway: MemoryAgentGateway; session: AgentSession }> {
  const gateway = createMemoryAgentGateway({ agentId: AGENT_ID, profileId: PROFILE_ID })
  await gateway.start()
  const session = await gateway.openSession({ vaultId, cwd: '/tmp/vault' })
  return { gateway, session }
}

/**
 * The view a handshake is re-established into, and every view it handed over to be published.
 *
 * It stands in for the store's record on purpose: what the handshake must not do is decide on
 * the view's behalf, so this counts what it was told rather than modelling the store.
 */
function targetFor(session: AgentSession): {
  target: { view: () => AgentSessionView; commit: (next: AgentSessionView) => void }
  commits: AgentSessionView[]
} {
  let view = initialAgentSessionView(session)
  const commits: AgentSessionView[] = []
  return {
    target: {
      view: () => view,
      commit: (next) => {
        commits.push(next)
        view = next
      },
    },
    commits,
  }
}

/** Hold the next snapshot until the test releases it: the window between the host reading its
 *  record and the subscription continuing from it is where abandonment happens. */
function holdNextSnapshot(gateway: MemoryAgentGateway): () => void {
  const take = gateway.snapshot.bind(gateway)
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  gateway.snapshot = async (session) => {
    const snapshot = await take(session)
    await held
    return snapshot
  }
  return release
}

describe('the subscription handshake', () => {
  it('refuses a snapshot from another identity without committing or subscribing', async () => {
    const { gateway, session } = await opened()
    const elsewhere = await gateway.openSession({ vaultId: 'vault-2', cwd: '/tmp/other' })
    const foreign = await gateway.snapshot(elsewhere)
    gateway.snapshot = async () => foreign
    const subscribe = vi.spyOn(gateway, 'subscribe')
    const { target, commits } = targetFor(session)

    const outcome = await openSubscription(createSubscription(gateway, session), target, () => {})

    // A snapshot belonging to another session cannot be continued from: subscribing from it
    // would deliver another session's frames, so none of it is used.
    expect(outcome).toEqual({ status: 'refused', reason: 'identity-mismatch', field: 'vaultId' })
    expect(commits).toEqual([])
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('records a snapshot the host could not answer instead of throwing at the caller', async () => {
    const { gateway, session } = await opened()
    gateway.snapshot = async () => {
      throw new AgentFailure('runtime-unavailable', 'the agent runtime is not started')
    }
    const { target, commits } = targetFor(session)

    const outcome = await openSubscription(createSubscription(gateway, session), target, () => {})

    // The panel's mount is a floating promise, so what a handshake cannot do is throw: the
    // failure belongs on the view, where the panel can say it — the rule every other call in
    // this feature already follows.
    expect(outcome).toEqual({ status: 'failed', code: 'runtime-unavailable' })
    expect(commits).toHaveLength(1)
    expect(commits[0].failure).toEqual({
      code: 'runtime-unavailable',
      message: 'the agent runtime is not started',
    })
  })

  it('commits nothing and registers nothing when the subscription is closed while it waits', async () => {
    const { gateway, session } = await opened()
    const subscription = createSubscription(gateway, session)
    const subscribe = vi.spyOn(gateway, 'subscribe')
    const { target, commits } = targetFor(session)

    const release = holdNextSnapshot(gateway)
    const opening = openSubscription(subscription, target, () => {})
    closeSubscription(subscription)
    release()

    // The attempt was abandoned: no view is told about a snapshot nobody is waiting for, and
    // no listener is registered for a session that is no longer being listened to.
    expect(await opening).toEqual({ status: 'abandoned' })
    expect(commits).toEqual([])
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('publishes the view before it registers the subscription', async () => {
    const { gateway, session } = await opened()
    await gateway.prompt(session, 'earlier')
    const subscription = createSubscription(gateway, session)
    const order: string[] = []
    let view = initialAgentSessionView(session)
    const target = {
      view: () => view,
      commit: (next: AgentSessionView) => {
        order.push('commit')
        view = next
      },
    }
    const subscribe = gateway.subscribe.bind(gateway)
    gateway.subscribe = async (from, onEvent) => {
      order.push('subscribe')
      return subscribe(from, onEvent)
    }

    expect(await openSubscription(subscription, target, () => {})).toEqual({ status: 'open' })

    // The order is the rule. The frames the subscription delivers — the host's replay of
    // what the snapshot did not include, and every live frame after it — have to land on top
    // of the snapshot; committing afterwards overwrites them with state that is older.
    expect(order).toEqual(['commit', 'subscribe'])
    expect(view.sequence).toBeGreaterThan(0)
    closeSubscription(subscription)
  })

  it('does not register a second listener on a session that is already being listened to', async () => {
    const { gateway, session } = await opened()
    const subscription = createSubscription(gateway, session)
    const subscribe = vi.spyOn(gateway, 'subscribe')
    const { target } = targetFor(session)

    // The repair a hole in the stream asks for: the subscription has been delivering the
    // whole time, so a second registration would deliver the same frames twice — and closing
    // it first would open the very window §6.2 forbids.
    expect(await openSubscription(subscription, target, () => {})).toEqual({ status: 'open' })
    expect(await openSubscription(subscription, target, () => {})).toEqual({ status: 'open' })
    expect(subscribe).toHaveBeenCalledTimes(1)
    closeSubscription(subscription)
  })
})

describe('what a rebuild would take from the reader', () => {
  it('is a rebuild only for a view that holds nothing', async () => {
    const { session } = await opened()
    expect(hasNothingToPreserve(initialAgentSessionView(session))).toBe(true)
  })

  it('is not a rebuild for a view holding the user’s own turn', async () => {
    const { session } = await opened()
    const started = startAgentRun(initialAgentSessionView(session), 'the question I typed')
    // The host's own row is not an engine event: no snapshot carries it back.
    expect(hasNothingToPreserve(started.view)).toBe(false)
  })

  it('is not a rebuild for a view holding only what the session published', async () => {
    const { session } = await opened()
    const view = initialAgentSessionView(session)
    expect(hasNothingToPreserve({ ...view, commands: [{ name: '/review' }] })).toBe(false)
    expect(hasNothingToPreserve({ ...view, failure: { code: 'cancelled', message: 'stopped' } })).toBe(false)
  })
})
