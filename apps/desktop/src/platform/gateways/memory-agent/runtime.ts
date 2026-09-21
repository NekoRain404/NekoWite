/**
 * The runtime instance the double is standing in for: whether it is up, which epoch it
 * minted, the sessions the engine's table holds, and which handles may be addressed
 * through it.
 *
 * The state is boxed here rather than closed over in one factory because the calls that
 * read it are split by what they are about, and every one of them asks the same question
 * first — may this handle be addressed by the runtime that is live now. The answer moves
 * for exactly one reason (a start, a stop or a crash), so the state and the rules that
 * read it change together.
 */

import { AgentFailure, type AgentConfigOption, type AgentSession } from '../agent-contracts'
import { DEFAULT_REPLAY_LIMIT, type MemoryAgentOptions, type MemoryRunScript } from './scenario'
import { wake, type LiveSession } from './session'

/**
 * Everything the gateway's calls share: the session table, the epoch a handle has to
 * belong to, the counters that name sessions and runs, and the script the next turn
 * follows.
 */
export interface LiveRuntime {
  readonly options: MemoryAgentOptions
  /** The bound every session's replay buffer keeps to, read once from the options. */
  readonly replayLimit: number
  /**
   * Every session the engine's table holds, keyed by the engine's own id — the closed
   * ones included, because closing a session stops the engine serving it rather than
   * removing it from the table.
   */
  readonly sessions: Map<string, LiveSession>
  /**
   * The options each session has published, seeded with the one the session opened with.
   *
   * Kept here rather than on the session record because it is the *gateway's* account of what
   * the engine would accept: the record is about the stream, and this is about the call. It is
   * what lets a test drive the frame the panel's row is built from — a value moved through
   * `setConfigOption` is published back as `config-changed`, which is how the pinned engine
   * announces its own change too (measured after every `session/set_config_option`).
   */
  readonly publishedOptions: Map<string, AgentConfigOption[]>
  /** The current runtime instance's epoch, or null while no runtime is up. */
  epoch: string | null
  /** `crash` leaves the runtime down for a different reason than `stop` does, and the
   *  code a later call gets has to say which of the two happened. */
  dead: boolean
  sessionCount: number
  runCount: number
  epochCount: number
  /** What subsequent turns do; set through the gateway's `script`. */
  script: MemoryRunScript
}

export function createLiveRuntime(options: MemoryAgentOptions): LiveRuntime {
  return {
    options,
    replayLimit: options.replayLimit ?? DEFAULT_REPLAY_LIMIT,
    sessions: new Map(),
    publishedOptions: new Map(),
    epoch: null,
    dead: false,
    sessionCount: 0,
    runCount: 0,
    epochCount: 0,
    script: {},
  }
}

/**
 * The epoch of the runtime instance a call addresses. A call that needs the engine
 * to *act* goes through this; a call that only reads what the host already knows
 * does not, or a crash would hide the state the UI needs in order to say what
 * happened.
 */
export function currentEpoch(runtime: LiveRuntime): string {
  const epoch = runtime.epoch
  if (!epoch) throw new AgentFailure('runtime-unavailable', 'the agent runtime is not started')
  return epoch
}

/** A session may only be addressed by a handle its own runtime instance minted. */
export function recordFor(runtime: LiveRuntime, sessionId: string): LiveSession {
  const record = runtime.sessions.get(sessionId)
  const current = currentEpoch(runtime)
  // An id minted under another epoch means the session outlived the runtime that
  // owned it: the live runtime never opened it, so the handle is stale rather than
  // unknown, and nothing read or written through it can be trusted. A *closed* one is
  // the same refusal for a different reason — the engine stopped serving it — and
  // both are `session-stale` because both mean the handle addresses nothing live.
  if (!record || record.closed || record.identity.runtimeEpoch !== current) {
    throw new AgentFailure(
      'session-stale',
      `session ${sessionId} belongs to an earlier runtime instance`,
    )
  }
  return record
}

/** A record named by a handle that `emit` addresses, live or not: a late frame, by
 *  definition, arrives for a runtime that is no longer the one running. */
export function anyRecord(runtime: LiveRuntime, sessionId: string): LiveSession {
  const record = runtime.sessions.get(sessionId)
  if (!record) {
    throw new AgentFailure(
      'session-stale',
      `session ${sessionId} was never opened by this gateway`,
    )
  }
  return record
}

/** A session whose engine can act: the runtime is up and the handle is current. */
export function engineCall(runtime: LiveRuntime, session: AgentSession): LiveSession {
  const record = recordFor(runtime, session.sessionId)
  if (runtime.dead) throw new AgentFailure('process-exited', 'the agent runtime exited')
  return record
}

export async function startRuntime(runtime: LiveRuntime): Promise<void> {
  // Starting an already-running runtime is a no-op rather than a restart: a
  // redundant call must not invalidate every open session. Coming up after
  // `crash` or `stop` is a new runtime instance and mints a new epoch, which is
  // what makes the handles of the previous one stale.
  if (runtime.epoch && !runtime.dead) return
  runtime.epochCount += 1
  runtime.epoch = `epoch-${runtime.epochCount}`
  runtime.dead = false
}

export async function stopRuntime(runtime: LiveRuntime): Promise<void> {
  if (runtime.epoch && !runtime.dead) {
    for (const record of runtime.sessions.values()) {
      const run = record.run
      if (!run) continue
      // The turn ends as cancelled — that is the turn's own record, and the
      // runtime is being taken down rather than failing — but the caller's
      // promise rejects: the request that would have answered it is gone with the
      // runtime, so the call did not complete.
      run.cancelled = true
      run.failure = new AgentFailure(
        'cancelled',
        'the runtime stopped while the turn was running',
      )
      wake(run)
    }
  }
  runtime.epoch = null
  runtime.dead = false
}

/** The runtime died. Turns in flight fail with `process-exited` and everything that
 *  needs the engine rejects until a later `start` brings a new runtime up; reads of a
 *  session still work, because a session's last known state outlives the process that
 *  produced it. */
export function crashRuntime(runtime: LiveRuntime, message = 'the agent runtime exited'): void {
  runtime.dead = true
  for (const record of runtime.sessions.values()) {
    const run = record.run
    // Only a turn suspended on a permission or on `hang` can be cut by a crash: a
    // turn with neither has already run to completion inside the synchronous burst
    // that started it.
    if (!run) continue
    run.failure = new AgentFailure('process-exited', message)
    wake(run)
  }
}
