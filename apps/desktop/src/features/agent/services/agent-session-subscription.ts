/**
 * The subscription to one session's event stream: opening it, replacing it, and taking the
 * host's word for where it stands.
 *
 * It is apart from the store because it is the only part of this feature that is *about the
 * connection* rather than about what the connection says: which session is being listened to,
 * where the subscription resumes from, and what happens when the host refuses to continue.
 * The store holds one of these per session and keeps the state they produce.
 *
 * §6.2 requires the window to fetch a snapshot before it subscribes (「先获取宿主快照再接事件，
 * 避免订阅空窗」), and the two calls are one operation here: a subscriber must say where its
 * state ends, and a snapshot is how it learns that. Opening a subscription always adopts or
 * repairs a view from the snapshot it subscribed with, so the two cannot disagree about the
 * sequence the stream continues from.
 */

import {
  AgentFailure,
  type AgentEvent,
  type AgentFailureCode,
  type AgentGateway,
  type AgentSession,
} from '../../../platform/gateways/agent-contracts'
import { adoptSnapshot, repairFromSnapshot } from './agent-session-snapshot'
import { failAgentRun, type AgentSessionView } from './agent-session-view'

/**
 * How many fresh snapshots a refused subscription is retried with.
 *
 * One retry is what the contract's remedy needs — a refused `subscribe` is answered by taking
 * a fresh snapshot, and a fresh snapshot is at the head of the buffer, so a second attempt can
 * only fail if the stream is outrunning the handshake. The bound exists so that "outrunning"
 * cannot become a loop.
 */
const MAX_HANDSHAKE_ATTEMPTS = 3

/** One session's subscription. */
export interface AgentSubscription {
  readonly gateway: AgentGateway
  readonly session: AgentSession
  /** The live unsubscribe, or null while no subscription has been registered yet. */
  unsubscribe: (() => void) | null
}

/**
 * A failure code and message from anything a gateway rejected with.
 *
 * `AgentFailure` is the contract's own error and is what every gateway method throws, so a
 * rejection that is one is read as itself. Anything else is reported as `invalid-response`: it
 * is a rejection this host cannot classify, and the rule is that an unclassifiable answer is
 * reported rather than swallowed — the alternative is a call that appears to have succeeded.
 */
export function describeFailure(error: unknown): { code: AgentFailureCode; message: string } {
  if (error instanceof AgentFailure) return { code: error.code, message: error.message }
  return { code: 'invalid-response', message: `the agent gateway rejected the call: ${String(error)}` }
}

export function createSubscription(gateway: AgentGateway, session: AgentSession): AgentSubscription {
  return { gateway, session, unsubscribe: null }
}

/**
 * Register a subscription, and say what the view should be afterwards.
 *
 * `mode` says what the view is: `adopt` rebuilds it from the snapshot, which is what a window
 * that has nothing needs; `repair` keeps the timeline the user is reading and takes the host's
 * word for the rest, which is what a hole in the stream or a drifted state needs.
 *
 * The returned view is the caller's to commit. A refused snapshot returns the view it was
 * given, unchanged, and a failure the host will not recover from returns the view with the
 * failure recorded — in both cases with no subscription left behind.
 */
export async function openSubscription(
  subscription: AgentSubscription,
  view: AgentSessionView,
  mode: 'adopt' | 'repair',
  onEvent: (event: AgentEvent) => void,
): Promise<AgentSessionView> {
  const { gateway, session } = subscription
  let snapshot = await gateway.snapshot(session)
  for (let attempt = 0; ; attempt++) {
    const adopted =
      mode === 'adopt' && attempt === 0
        ? adoptSnapshot(view, snapshot)
        : repairFromSnapshot(view, snapshot)
    if (adopted.outcome.status === 'refused') {
      // A refusal is the view being ahead of the host (`rewind`) or a snapshot belonging to
      // another identity. Subscribing from it would either rewind what the user has read or
      // deliver another session's frames, so nothing is subscribed and the state the view
      // already has stands.
      return view
    }
    // Already subscribed: a repair on a session that is being listened to. The subscription
    // has been delivering the whole time, so registering a second one would deliver the same
    // frames twice — and unsubscribing first would open the very window §6.2 forbids.
    if (subscription.unsubscribe !== null) return adopted.view
    try {
      subscription.unsubscribe = await gateway.subscribe(snapshot, onEvent)
      return adopted.view
    } catch (error) {
      const failure = describeFailure(error)
      if (failure.code !== 'buffer-conflict' || attempt + 1 >= MAX_HANDSHAKE_ATTEMPTS) {
        return failAgentRun(adopted.view, failure.code, failure.message)
      }
      // The contract names exactly one recoverable refusal, and the remedy for it: the
      // snapshot is older than anything the gateway can still replay, so take a fresh one and
      // continue from there.
      snapshot = await gateway.snapshot(session)
    }
  }
}

/** Release the subscription. Idempotent: an unmount that never attached, or one that runs
 *  twice, must not leave a subscription behind or throw. */
export function closeSubscription(subscription: AgentSubscription): void {
  subscription.unsubscribe?.()
  subscription.unsubscribe = null
}
