/**
 * How long this window waits for a turn's ending before it reports the turn instead.
 *
 * A turn ends as an *event* (`frames.ts`, and the gateway's own header), so a turn whose ending is
 * never published used to leave its session's latch closed for the life of the session — nothing
 * in this app could release it, and every later send on that session was refused. That state was
 * reached by an instrument rather than reasoned about (`e2e/webkit/probe-agent-scroll.mjs`'s own
 * comment records it against the stand-in host), and the shape of it is a fact about this layer
 * rather than about any one engine: **nothing is promised to arrive**. A frame can be lost, a host
 * can publish none, a transport can say nothing — so the only bound this window can hold a latch
 * to is its own, and it has to have one.
 *
 * ## Why the number is the host's plus a minute
 *
 * The runtime already bounds a generation: `runs.rs`'s `PROMPT_BOUND`, whose comment calls it "a
 * net for a wedged engine, not a budget for the answer". A turn the host has given up on is one it
 * will never end another way, so a bound derived from that one is the only bound that cannot be
 * wrong in the dangerous direction. Both halves of it are read here:
 *
 *  - {@link HOST_TURN_BOUND_MS} restates the Rust constant rather than importing it — the two
 *    halves of this boundary are written in parallel (`agent-contracts-parity.test.ts` says why) —
 *    and `tauri-agent/turn-liveness.test.ts` reads `runs.rs` to hold the two together. The
 *    direction is what matters: this window's bound may only ever sit *above* the host's, because a
 *    deadline below it would fire on a turn the host was still willing to finish, and would report
 *    a live generation as a dead one.
 *  - {@link TURN_ENDING_ALLOWANCE_MS} is the delivery allowance. The host's net fires *at* its
 *    bound, and the ending it then publishes still has to cross the emitter, the event channel and
 *    this adapter's reader before it settles anything; a deadline set on the host's number exactly
 *    would race the very frame it exists to wait for.
 *
 * What this costs is a delay, not a decision: a session held by a turn that will never end is
 * unsendable for the length of the bound, and then it is *reported* — with the vocabulary's own
 * word for it ({@link expiredTurn}) — rather than kept in silence. The releases that need no
 * deadline (`closeSession`, `stop`, the ending frame itself) are in the gateway, because they are
 * proofs rather than waits.
 */

import { AgentFailure } from '../agent-contracts'

const MINUTE_MS = 60_000

/**
 * The runtime's own bound on one generation, as `runs.rs` states it (`PROMPT_BOUND`).
 *
 * Exported because it is the number the two sides have to agree on, which is a thing a test can
 * check and a reader cannot: see this module's header.
 */
export const HOST_TURN_BOUND_MS = 30 * MINUTE_MS

/**
 * What this window adds to that bound before it concludes that no ending is coming.
 *
 * A minute, and it is a delivery allowance rather than a rounding: see this module's header for
 * what it covers. Nothing legitimate is hidden by it — a generation the host's own net has passed
 * is one the host will never end — so the extra minute cannot make this window report a turn that
 * is still running.
 */
const TURN_ENDING_ALLOWANCE_MS = MINUTE_MS

/** How long a session's latch is held before the turn holding it is reported as timed out. */
export const TURN_LIVENESS_BOUND_MS = HOST_TURN_BOUND_MS + TURN_ENDING_ALLOWANCE_MS

/**
 * The failure a turn is ended with when its bound passes and nothing has been said about it.
 *
 * `timeout` is this vocabulary's word for exactly this condition — "no answer within the caller's
 * bound" (`events.rs`, on `TransportError::Timeout`) — and it is deliberately the code the host
 * would have used had its own net fired first: the two nets report one fact, so a reader cannot
 * tell from the code which of them ran, and does not need to.
 *
 * The sentence names both the number and the reason it exists, because it is read by a person: it
 * is what the panel's bar draws under the state word.
 */
export function expiredTurn(): AgentFailure {
  return new AgentFailure(
    'timeout',
    `the turn did not end within ${TURN_LIVENESS_BOUND_MS / MINUTE_MS} minutes: the runtime’s own ` +
      'bound on a generation passed with no ending, so the turn is reported as timed out rather ' +
      'than waited on',
  )
}
