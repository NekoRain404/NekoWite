/**
 * A session's own runtime state in the double: its event stream, the bounded
 * replay behind it, the subscribers resuming from it, its unanswered permission
 * requests, and the turn in flight.
 *
 * It is apart from `memory-agent.ts` because that file is about the calls the app
 * makes — is the runtime up, does this handle still belong to it, which failure
 * does each call get — while this one is about what a session *is* once it exists.
 * The rules that make the snapshot→subscribe window closable live here: a sequence
 * that never goes backwards, a buffer with a stated bound, permission requests
 * that outlive that bound, and registration and replay in one synchronous block.
 */

import {
  AgentFailure,
  readAgentEvent,
  type AgentEvent,
  type AgentEventKind,
  type AgentIdentity,
  type AgentConfigOption,
  type AgentModelOption,
  type AgentPayloads,
  type AgentSession,
  type AgentSessionSnapshot,
  type AgentSessionState,
} from '../agent-contracts'
import type { MemoryEventPatches } from './scenario'

/** A turn in flight. */
export interface LiveRun {
  readonly runId: string
  /**
   * Set by `cancel`: the user stopped this turn while the runtime stayed alive, so
   * the turn ends as a cancelled turn — which the runtime reports the way the
   * protocol does — and the caller's prompt resolves with it.
   */
  cancelled: boolean
  /**
   * Set by `crash` and `stop`: the runtime cannot answer the prompt request any
   * more, so the caller's promise rejects with this and the turn's event is
   * `run-failed`. The distinction matters to the caller, which has to know whether
   * a turn ended (show it) or a call was never completed (retry, or tell the user
   * the agent is gone).
   */
  failure: AgentFailure | null
  /** The single slot an ending resumes the suspended turn through. */
  wake: (() => void) | null
}

export interface LiveSession {
  readonly identity: AgentIdentity
  /** The bound this session's replay buffer keeps to. */
  readonly replayLimit: number
  state: AgentSessionState
  /** Last sequence handed out; events start at 1, so 0 means "nothing yet". */
  sequence: number
  /** The run of the most recent turn-scoped event — what
   *  {@link AgentSessionSnapshot.runId} reports. */
  lastRunId: string | null
  /** The bounded replay tail, oldest first. */
  buffer: AgentEvent[]
  /** Unanswered permission requests, in arrival order. */
  permissions: Extract<AgentEvent, { kind: 'permission-request' }>[]
  subscribers: Set<(event: AgentEvent) => void>
  run: LiveRun | null
}

export function createSession(identity: AgentIdentity, replayLimit: number): LiveSession {
  return {
    identity,
    replayLimit,
    state: 'ready',
    sequence: 0,
    lastRunId: null,
    buffer: [],
    permissions: [],
    subscribers: new Set(),
    run: null,
  }
}

/**
 * The one place a session handle is minted.
 *
 * The brand is a phantom property — the unique symbol exists only in the type — so
 * what makes this factory the sole producer of a handle is that a plain object is not
 * castable to `AgentSession` in one step: TypeScript refuses the conversion, which
 * keeps a feature from writing `… as AgentSession` and addressing a session id it
 * made up (§6.2 「不能编造 sessionId」). The two-step cast below is this module saying
 * that it means it.
 */
export function mintSession(
  identity: AgentIdentity,
  models: readonly AgentModelOption[],
  initialModelId: string,
  options: readonly AgentConfigOption[],
): AgentSession {
  return { ...identity, models, initialModelId, options } as unknown as AgentSession
}

/**
 * Append one event to a session's stream and hand it to every subscriber.
 *
 * Every event takes this path, including the ones a test injects: building the
 * envelope once, here, is what keeps the sequence counter, the replay buffer and
 * the subscribers consistent with each other, and running the result through
 * `readAgentEvent` is what keeps the double from emitting something the real
 * adapter could not.
 */
export function pushEvent<K extends AgentEventKind>(
  record: LiveSession,
  kind: K,
  payload: AgentPayloads[K],
  runId: string | null,
  patches?: MemoryEventPatches,
): Extract<AgentEvent, { kind: K }> {
  const sequence = patches?.sequence ?? record.sequence + 1
  const read = readAgentEvent({
    ...record.identity,
    ...patches?.identity,
    runId,
    sequence,
    kind,
    payload,
  })
  if (read instanceof AgentFailure) throw read
  // The cast is what the validator's return type cannot carry: `K` correlates kind
  // with payload in this signature, and TypeScript cannot follow that through the
  // lookup above.
  const event = read as Extract<AgentEvent, { kind: K }>
  // A duplicate sequence must not walk the counter backwards, or the next real
  // event would collide with an event already in the stream.
  record.sequence = Math.max(record.sequence, sequence)
  if (runId) record.lastRunId = runId
  record.buffer.push(event)
  if (record.buffer.length > record.replayLimit) {
    record.buffer.splice(0, record.buffer.length - record.replayLimit)
  }
  // Iterating a copy: a subscriber is allowed to unsubscribe from inside its own
  // callback, and that must not cut the delivery to the others short.
  for (const subscriber of [...record.subscribers]) subscriber(event)
  return event
}

export function snapshotOf(record: LiveSession): AgentSessionSnapshot {
  return {
    identity: record.identity,
    state: record.state,
    runId: record.lastRunId,
    sequence: record.sequence,
    events: [...record.buffer],
    permissions: [...record.permissions],
  }
}

/**
 * Resume a session from a snapshot: validate that the snapshot is one this session
 * can be continued from, replay what it did not include, then register for live
 * events.
 */
export function subscribeTo(
  record: LiveSession,
  from: AgentSessionSnapshot,
  onEvent: (event: AgentEvent) => void,
): () => void {
  // The snapshot is a value, so it may have been stored and read back; comparing
  // the identity it was taken under is what catches the one that no longer matches
  // — the same composite boundary the events are held to (§6.2 「权限响应、快照和
  // 持久化索引使用相同的复合身份边界」).
  const keys = ['agentId', 'profileId', 'runtimeEpoch', 'vaultId', 'sessionId'] as const
  if (keys.some((key) => from.identity[key] !== record.identity[key])) {
    throw new AgentFailure(
      'session-stale',
      'the snapshot was taken under a different identity than the live session',
    )
  }
  if (from.sequence > record.sequence) {
    throw new AgentFailure(
      'invalid-response',
      `the snapshot claims sequence ${from.sequence}, which this session never reached`,
    )
  }

  const first = from.sequence + 1
  const oldest = record.buffer[0]?.sequence ?? record.sequence + 1
  // The buffer is the only place the events after the snapshot still exist. Once it
  // no longer reaches back to the subscriber's continuation point, the gap cannot
  // be filled, and closing it by pretending would hide a hole in the stream — so
  // the subscription is refused and the caller takes a fresh snapshot instead
  // (§6.2: back pressure may merge text, never drop data).
  if (first < oldest) {
    throw new AgentFailure(
      'buffer-conflict',
      `events ${first}..${oldest - 1} are no longer replayable; take a fresh snapshot`,
    )
  }

  // Registration and replay happen in one synchronous block — nothing is awaited
  // between them — so an event cannot be delivered live and also missed by the
  // replay, and no event can be delivered twice.
  record.subscribers.add(onEvent)
  for (const event of record.buffer) {
    if (event.sequence >= first) onEvent(event)
  }
  return () => {
    record.subscribers.delete(onEvent)
  }
}

/**
 * Answer one pending permission request.
 *
 * `others` is every session the gateway knows, because an answer that matches no
 * request of this session has to be told apart from an answer that matches another
 * session's — the cross-session case §11.1 requires to be rejected, and a
 * different mistake from a click that arrived after the request was resolved.
 */
export function answerPermissionOn(
  record: LiveSession,
  requestId: string,
  optionId: string,
  others: Iterable<LiveSession>,
): void {
  const request = record.permissions.find((event) => event.payload.requestId === requestId)
  if (!request) {
    const owner = [...others].find((other) =>
      other.permissions.some((event) => event.payload.requestId === requestId),
    )
    throw owner
      ? new AgentFailure(
          'permission-denied',
          `permission request ${requestId} belongs to another session`,
        )
      : new AgentFailure(
          'invalid-response',
          `permission request ${requestId} is no longer pending`,
        )
  }
  if (!request.payload.options.some((option) => option.optionId === optionId)) {
    throw new AgentFailure(
      'invalid-response',
      `the engine never offered option ${optionId} for ${requestId}`,
    )
  }
  const run = record.run
  // An answer is bound to the turn it was asked for, not to the request id alone
  // (§6.3 「请求绑定运行时、库、会话、任务和 request ID」). This double's own flow cannot
  // reach the refusal — a request is dropped in the same tick its turn ends — so the
  // branch is what keeps the binding true for a host that keeps requests across turns.
  if (!run || run.runId !== request.runId) {
    throw new AgentFailure(
      'permission-denied',
      `permission request ${requestId} does not belong to the turn in flight`,
    )
  }
  record.permissions.splice(record.permissions.indexOf(request), 1)
  record.state = 'running'
  wake(run)
}

/**
 * Drop the requests a finished turn left unanswered. Those buttons are dead (§6.2
 * 「进程退出使所有悬挂请求结束」), and leaving them in a snapshot would let a click
 * look answerable when nothing is listening for it.
 */
export function dropRunPermissions(record: LiveSession, runId: string): void {
  record.permissions = record.permissions.filter((request) => request.runId !== runId)
}

/**
 * Suspend the turn until something ends it. Every ending — an answer, a cancel, a
 * crash, a stop — resumes through this one slot, so what the turn does afterwards
 * is decided in one place instead of once per ending.
 */
export function suspend(run: LiveRun): Promise<void> {
  return new Promise((resolve) => {
    run.wake = resolve
  })
}

export function wake(run: LiveRun): void {
  const wake = run.wake
  run.wake = null
  wake?.()
}
