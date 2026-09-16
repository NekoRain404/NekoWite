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
 *
 * ## The two rules the order in here exists for
 *
 * **The snapshot is published before the subscription is registered.** The frames a
 * subscription delivers — the host's replay of what the snapshot did not include, and every
 * live frame after it — are applied *on top of* the state the snapshot describes. A handshake
 * that returns a view for the caller to commit afterwards inverts that: the replay has been
 * delivered by the time the caller assigns, so a snapshot older than those frames overwrites
 * them. That is a rollback, and the frames it covers were delivered already and never come
 * again.
 *
 * **An attempt is an attempt only while its generation is current.** Waiting for a host is
 * waiting for something that may no longer be wanted — a panel that unmounted, a second
 * attempt that took over — so a handshake stamps itself with {@link AgentSubscription}'s
 * generation and re-reads it after every await. A superseded handshake publishes nothing and
 * releases whatever listener it was handed. The view outlives the attempt: it must not be
 * told about a snapshot nobody is waiting for, and a listener nobody owns can never be
 * released by anyone.
 */

import {
  AgentFailure,
  type AgentEvent,
  type AgentFailureCode,
  type AgentGateway,
  type AgentSession,
  type AgentSessionSnapshot,
} from '../../../platform/gateways/agent-contracts'
import { adoptSnapshot, repairFromSnapshot, type AgentSnapshotRefusal } from './agent-session-snapshot'
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

/**
 * One session's subscription, and the attempt currently being made on it.
 *
 * The generation is a counter rather than a boolean because a handle outlives any one
 * attempt: a repair reuses the subscription that is already delivering, and the previous
 * attempt has to be recognisable as the previous one. It is the shape `WatcherState`'s own
 * generation has for the folder watcher — a number bumped when work is installed or retired,
 * re-read by the work that was already in flight — rather than a second way of saying it.
 */
export interface AgentSubscription {
  readonly gateway: AgentGateway
  readonly session: AgentSession
  /**
   * Which attempt this handle is answering. Bumped when a handshake begins and when the
   * subscription is closed, so a handshake that is still waiting learns that its result is
   * nobody's.
   */
  generation: number
  /** The live unsubscribe, or null while no subscription has been registered yet. */
  unsubscribe: (() => void) | null
}

/**
 * The view a handshake is re-established into, and where its result goes.
 *
 * Both are read in one synchronous step, and that is the point rather than a convenience: a
 * handshake must not decide against a view it captured before an await, because frames that
 * arrive while it waits are applied to the view as it is now. Reading `view()` at the moment
 * of `commit()` is what makes an older snapshot unable to overwrite them.
 */
export interface AgentHandshakeTarget {
  view(): AgentSessionView
  commit(view: AgentSessionView): void
}

/** What became of one attempt at a session's subscription. */
export type AgentHandshakeOutcome =
  /** The snapshot's state is published and the subscription that continues from it is live. */
  | { status: 'open' }
  /** The attempt was abandoned while it waited: nothing was published, nothing is listening. */
  | { status: 'abandoned' }
  /** The host could not be continued from, so the view was left exactly as it was. */
  | AgentSnapshotRefusal
  /** The handshake itself failed; the view records why. */
  | { status: 'failed'; code: AgentFailureCode }

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
  return { gateway, session, generation: 0, unsubscribe: null }
}

/**
 * Whether a rebuild from a snapshot would take something from the reader.
 *
 * A snapshot carries the state, the run binding, the pending requests and a bounded tail of
 * the session's events — and nothing else. It cannot carry the rows the *host itself* wrote
 * (the user's own turns), the commands the session has published, the failure the last turn
 * ended with, or the row ids the panel's list is keyed by; and its tail is bounded, so a long
 * session's earlier events are not in it either. So a rebuild is the right handshake for a
 * view that holds nothing at all, and every other view has something to preserve.
 *
 * It is a question about the view rather than a flag kept beside it: a flag would have to be
 * set by every path that writes to a view, and the paths that forget are exactly the ones
 * where the loss is silent.
 */
export function hasNothingToPreserve(view: AgentSessionView): boolean {
  return (
    view.state === 'ready' &&
    view.runId === null &&
    view.sequence === 0 &&
    view.gap === null &&
    view.lastResult === null &&
    view.failure === null &&
    view.usage === null &&
    view.title === null &&
    view.updatedAt === null &&
    view.timeline.length === 0 &&
    view.permissions.length === 0 &&
    view.commands.length === 0 &&
    view.plan.length === 0 &&
    view.config.length === 0 &&
    view.changedFiles.length === 0
  )
}

/**
 * Register a subscription, and make the view say what the host says.
 *
 * The snapshot decides how the view is re-established: a view that holds nothing is rebuilt
 * from it, and any other view is *merged* — its timeline is what the reader has been reading,
 * and the host's word replaces the state machine, the run binding and the pending requests
 * around it. That choice is made when the snapshot arrives rather than when the call is made,
 * because the view is read at that moment too.
 *
 * A refused snapshot publishes nothing and leaves no subscription behind; a failure the host
 * will not recover from is recorded on the view rather than thrown, because the caller is a
 * component's mount and has no reader for a rejection.
 */
export async function openSubscription(
  subscription: AgentSubscription,
  target: AgentHandshakeTarget,
  onEvent: (event: AgentEvent) => void,
): Promise<AgentHandshakeOutcome> {
  const { gateway, session } = subscription
  // Beginning an attempt supersedes whatever this handle was answering: a second resync, or a
  // first handshake that has not finished waiting, must not publish over what this one says.
  const attempt = (subscription.generation += 1)
  const current = (): boolean => subscription.generation === attempt

  let snapshot: AgentSessionSnapshot
  try {
    snapshot = await gateway.snapshot(session)
  } catch (error) {
    return recordFailure(target, current, error)
  }

  for (let retry = 0; ; retry += 1) {
    if (!current()) return { status: 'abandoned' }
    const held = target.view()
    const derived = hasNothingToPreserve(held)
      ? adoptSnapshot(held, snapshot)
      : repairFromSnapshot(held, snapshot)
    if (derived.outcome.status === 'refused') {
      // A refusal is the view being ahead of the host (`rewind`) or a snapshot belonging to
      // another identity. Subscribing from it would either rewind what the user has read or
      // deliver another session's frames, so nothing is published and nothing is subscribed:
      // the state the view already has stands. The refusal is passed through rather than
      // collapsed, because the three are acted on differently.
      return derived.outcome
    }
    // Published before the subscription exists, and in the same synchronous step as the
    // check above — so no frame can be applied between the view being read and the state
    // derived from it being published.
    target.commit(derived.view)
    // Already subscribed: a repair on a session that is being listened to. The subscription
    // has been delivering the whole time, so registering a second one would deliver the same
    // frames twice — and unsubscribing first would open the very window §6.2 forbids.
    if (subscription.unsubscribe !== null) return { status: 'open' }
    let release: () => void
    try {
      release = await gateway.subscribe(snapshot, onEvent)
    } catch (error) {
      const failure = describeFailure(error)
      if (failure.code !== 'buffer-conflict' || retry + 1 >= MAX_HANDSHAKE_ATTEMPTS) {
        return recordFailure(target, current, error)
      }
      // The contract names exactly one recoverable refusal, and the remedy for it: the
      // snapshot is older than anything the gateway can still replay, so take a fresh one and
      // continue from there.
      try {
        snapshot = await gateway.snapshot(session)
      } catch (next) {
        return recordFailure(target, current, next)
      }
      continue
    }
    if (!current()) {
      // The panel detached, or a newer attempt took over, while the host was answering. This
      // listener has no owner left — the store's map no longer names this subscription — so
      // releasing it here is the only chance anything gets.
      release()
      return { status: 'abandoned' }
    }
    subscription.unsubscribe = release
    return { status: 'open' }
  }
}

/**
 * Report what the host refused to do, for the attempt that is still current.
 *
 * A handshake that has been abandoned records nothing: the failure belongs to a session
 * nobody is looking at, and a view that outlives the attempt must not be told about it. The
 * caller is never given a rejection to handle — see {@link openSubscription}.
 */
function recordFailure(
  target: AgentHandshakeTarget,
  current: () => boolean,
  error: unknown,
): AgentHandshakeOutcome {
  if (!current()) return { status: 'abandoned' }
  const failure = describeFailure(error)
  target.commit(failAgentRun(target.view(), failure.code, failure.message))
  return { status: 'failed', code: failure.code }
}

/**
 * Release the subscription, and any handshake still waiting on it.
 *
 * Idempotent: an unmount that never attached, or one that runs twice, must not leave a
 * subscription behind or throw. The generation is bumped so a handshake that is between its
 * snapshot and its `subscribe` gives up rather than registering a listener nobody owns.
 */
export function closeSubscription(subscription: AgentSubscription): void {
  subscription.generation += 1
  subscription.unsubscribe?.()
  subscription.unsubscribe = null
}
