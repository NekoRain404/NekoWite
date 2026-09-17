/**
 * The connection: one listener for the host's frame channel, and who receives what.
 *
 * Two facts decide its shape, and both are §6.2's.
 *
 * **There is exactly one registration, and it can be removed.** An event listener that cannot be
 * removed leaks across a panel remount, and a second `listen` on the same channel would leave
 * the first installed — every frame delivered twice, with nothing on screen to say so. So the
 * registration is taken once, kept by {@link handleChannel} while anything wants it (a turn in
 * flight, or an open subscription), and removed through the function `listen` itself answered
 * with when the last of them is gone.
 *
 * **A subscription is a handshake, not a call.** A window that subscribes without a snapshot
 * misses whatever happened while it was not listening; a window that takes a snapshot and then
 * subscribes misses whatever happened in between. The caller's snapshot is the lower bound of
 * what it already has, and this module takes the host's *after* the listener is up: the frames
 * that arrive during the call are buffered, the host's tail fills the rest, and the two can
 * only overlap where they agree — the sequences decide which of the buffered frames are new.
 * That is what lets the caller's remedy for a refused subscription (take a fresh snapshot) be
 * correct rather than hopeful.
 */

import {
  AgentFailure,
  isAgentSessionState,
  type AgentEvent,
  type AgentSessionSnapshot,
} from '../agent-contracts'
import { mapHostFrame, readFrameShape } from './frames'
import type { AgentIpc, AgentHostSnapshot } from './ipc'
import type { SessionRecord } from './session'
import type { ToolProjection } from './tools'

/** One open subscription, and the frames it has received but not yet delivered. */
interface Subscriber {
  /** The session this subscription follows: one channel carries every session the runtime
   *  holds, so a frame has to be matched before it is delivered (§6.1's composite boundary —
   *  the id *and* the epoch, because the ids are the engine's). */
  sessionId: string
  runtimeEpoch: string
  reader: (event: AgentEvent) => void
  /** False while the handshake is in flight: frames are buffered, and the host's own sequence
   *  decides which of them are new when it lands. */
  live: boolean
  buffered: AgentEvent[]
  closed: boolean
}

export interface ChannelDeps {
  ipc: AgentIpc
  tools: ToolProjection
  /** A mapped frame that ends a turn, before it is delivered: the gateway settles the turn's
   *  promise with it. */
  onFrame(event: AgentEvent): void
  /** A frame that could not be attributed to a session — the caller is the only place left to
   *  report it. */
  report(failure: AgentFailure): void
}

export interface EventChannel {
  /** Take the registration, or join the one already held. */
  handle(): Promise<void>
  /** Give it back, and remove it when nothing wants it any more. */
  release(): Promise<void>
  /** Forget every subscription, and remove the registration. Used when the runtime is over:
   *  nothing a subscriber was following survives it. */
  closeAll(): Promise<void>
  /** Open a subscription from a snapshot the caller holds. Rejects when the snapshot cannot be
   *  continued from, and leaves nothing registered when it does. */
  subscribe(
    record: SessionRecord,
    from: AgentSessionSnapshot,
    onEvent: (event: AgentEvent) => void,
  ): Promise<() => void>
}

export function createEventChannel(deps: ChannelDeps): EventChannel {
  const { ipc, tools } = deps
  const subscribers = new Set<Subscriber>()
  let channel: Promise<() => void> | null = null
  let channelUsers = 0

  function dispatch(raw: unknown): void {
    const event = mapHostFrame(raw, tools)
    if (event instanceof AgentFailure) {
      deps.report(event)
      return
    }
    deps.onFrame(event)
    for (const subscriber of [...subscribers]) {
      if (subscriber.closed) continue
      if (event.sessionId !== subscriber.sessionId) continue
      if (event.runtimeEpoch !== subscriber.runtimeEpoch) continue
      if (!subscriber.live) {
        subscriber.buffered.push(event)
        continue
      }
      subscriber.reader(event)
    }
  }

  return {
    async handle(): Promise<void> {
      channelUsers += 1
      if (channel === null) channel = ipc.onEvent(dispatch)
      await channel
    },

    async release(): Promise<void> {
      channelUsers = Math.max(0, channelUsers - 1)
      if (channelUsers > 0 || channel === null) return
      const registration = channel
      channel = null
      // Removed by the function `listen` answered with, never by re-registering: a second
      // `listen` on the same channel installs a second listener rather than replacing the
      // first, and the leak would be invisible — every frame would simply be delivered twice.
      const unlisten = await registration
      unlisten()
    },

    async closeAll(): Promise<void> {
      for (const subscriber of [...subscribers]) subscriber.closed = true
      subscribers.clear()
      while (channelUsers > 0) await this.release()
    },

    async subscribe(record, from, onEvent): Promise<() => void> {
      if (from.identity.runtimeEpoch !== record.identity.runtimeEpoch) {
        throw new AgentFailure(
          'session-stale',
          `session ${from.identity.sessionId} belongs to an earlier runtime instance`,
        )
      }
      const subscriber: Subscriber = {
        sessionId: record.identity.sessionId,
        runtimeEpoch: record.identity.runtimeEpoch,
        reader: onEvent,
        live: false,
        buffered: [],
        closed: false,
      }
      // The registration comes first and the snapshot second, in this order and not the other
      // way round: a frame that arrives in between is then either in the host's tail or in the
      // buffer, never in neither.
      await this.handle()
      subscribers.add(subscriber)
      try {
        const host = await ipc.snapshot(record.identity.sessionId)
        checkSnapshot(record, host)
        if (from.sequence > host.sequence) {
          throw new AgentFailure(
            'invalid-response',
            `the snapshot claims sequence ${from.sequence}, which the host never reached`,
          )
        }
        // The host's replay is bounded. A subscriber whose state ends before the tail begins
        // cannot be continued from it, and pretending otherwise would leave a hole the reducer
        // would never be told about — §6.2's one named recoverable refusal, and the caller's
        // remedy is to take a fresh snapshot and try again.
        let tailStart = host.sequence + 1
        for (const frame of host.events) {
          const shape = readFrameShape(frame)
          if (shape !== null && shape.sessionId === record.identity.sessionId) {
            tailStart = Math.min(tailStart, shape.sequence)
          }
        }
        if (from.sequence + 1 < tailStart) {
          throw new AgentFailure(
            'buffer-conflict',
            `sequence ${from.sequence + 1} is older than the host can still replay`,
          )
        }
        for (const event of mapAll(host.events, tools, deps.report)) {
          if (event.sequence > from.sequence) subscriber.reader(event)
        }
        subscriber.live = true
        for (const event of subscriber.buffered) {
          if (event.sequence > host.sequence) subscriber.reader(event)
        }
        subscriber.buffered = []
      } catch (error) {
        subscriber.closed = true
        subscribers.delete(subscriber)
        await this.release()
        throw error
      }
      return () => {
        if (subscriber.closed) return
        subscriber.closed = true
        subscribers.delete(subscriber)
        void this.release()
      }
    },
  }
}

/**
 * The host's state, where it is one the view can draw.
 *
 * The vocabulary is the contract's own list (`AGENT_SESSION_STATES`, the value
 * `AgentSessionState` is derived from), so this boundary is the type's one runtime
 * reader rather than a second copy of it. What it still does is *refuse*: a name the
 * contract does not have is a state the panel cannot draw, and the panel's vocabulary
 * is the union — so the name is rejected here, with the reason, instead of being
 * carried on as a string nothing renders.
 */
export function readHostState(raw: string): AgentSessionSnapshot['state'] {
  if (isAgentSessionState(raw)) return raw
  throw new AgentFailure('invalid-response', `the host reported a session state named ${raw}`)
}

/** The host's snapshot must be about the session the caller asked for — the same composite
 *  boundary every event is held to (§6.2: 「权限响应、快照和持久化索引使用相同的复合身份边界」). */
export function checkSnapshot(record: SessionRecord, host: AgentHostSnapshot): void {
  const identity = host.identity
  const same =
    typeof identity === 'object' &&
    identity !== null &&
    identity.agentId === record.identity.agentId &&
    identity.profileId === record.identity.profileId &&
    identity.runtimeEpoch === record.identity.runtimeEpoch &&
    identity.vaultId === record.identity.vaultId &&
    identity.sessionId === record.identity.sessionId
  if (!same) throw new AgentFailure('session-stale', 'the host answered about another session')
}

/**
 * Map a list of frames, dropping the ones that cannot be attributed to a session.
 *
 * A frame the host cannot place is reported and left out: the alternative is putting it in a
 * snapshot under an identity this window invented, which §6.1 forbids in as many words. The
 * snapshot's `sequence` is the host's and is not reduced by a frame that was dropped, so the
 * subscriber's position stays where the host says it is.
 */
export function mapAll(
  frames: unknown[],
  tools: ToolProjection,
  report: (failure: AgentFailure) => void,
): AgentEvent[] {
  const events: AgentEvent[] = []
  for (const frame of frames) {
    const mapped = mapHostFrame(frame, tools)
    if (mapped instanceof AgentFailure) report(mapped)
    else events.push(mapped)
  }
  return events
}
