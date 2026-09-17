/**
 * The host half of the double: the tasks it is tracking, and the frames it receives.
 *
 * It validates what §6.1 gives the host — identity (a frame from another runtime
 * instance is not applied), order (a sequence already accepted is not applied again) and
 * terminal state (a settled run is not revived by a later work event) — and it reports
 * replays and gaps rather than deciding what they mean. That decision is §6.3's ledger,
 * a later task's, and it can only make it badly if this layer has already thrown the
 * evidence away.
 *
 * Frames it hands out pass `readAgentEvent` on the way out, so the double cannot invent
 * an event the ACP contract does not allow. What it *can* do — deliberately — is stamp a
 * foreign identity or a reused sequence on one: those are the late, replayed and stale
 * frames §6.3 has to survive, and refusing to model them would be refusing to model the
 * race.
 */
import {
  AgentFailure,
  readAgentEvent,
  type AgentEvent,
  type AgentEventKind,
  type AgentFailureCode,
  type AgentIdentity,
  type AgentStopReason,
} from '../agent-contracts'
import {
  isPetTaskSettled,
  petKeyToken,
  petOutcomeFromEvent,
  petOutcomeFromRuntimeLoss,
  petOutcomeFromSessionState,
  petTaskToken,
  type PetRuntimeLoss,
  type PetTaskKey,
  type PetTaskProjection,
  type PetTaskState,
} from '../pet-contracts'
import {
  MEMORY_PET_AGENT,
  MEMORY_PET_PROFILE,
  MEMORY_PET_VAULT,
  type MemoryRunOptions,
  type PetFrameOrder,
  type PetIngestOutcome,
} from './scenario'

/** What the host holds for one run. */
interface LiveTask {
  key: PetTaskKey
  state: PetTaskState
  permissionRequestId: string | null
  updatedAt: number
}

/** What the host can be asked, by the gateway that composes it. */
export interface PetTaskHost {
  /** Every task the pet shows. The order is the gateway contract's business, not this. */
  tasks(): PetTaskProjection[]
  /** Call `onTasks` with the current list now, and on every change after that. */
  subscribe(onTasks: (tasks: PetTaskProjection[]) => void): () => void
  startRun(options?: MemoryRunOptions): PetTaskKey
  finishRun(key: PetTaskKey, stopReason: AgentStopReason): PetIngestOutcome
  failRun(key: PetTaskKey, code: AgentFailureCode): PetIngestOutcome
  requestPermission(key: PetTaskKey, requestId: string): PetIngestOutcome
  loseRuntime(loss: PetRuntimeLoss): PetTaskProjection[]
  ingest(frame: unknown): PetIngestOutcome
}

export function createPetTaskHost(options: { epoch: string; now: () => number }): PetTaskHost {
  const { epoch, now } = options
  const live = new Map<string, LiveTask>()
  /**
   * Per session identity: the sequences accepted, and the highest number reached
   * without a hole. Keyed by the whole identity and not by the session id, because a
   * sequence belongs to an engine session and two agents can use the same session id —
   * the confusion §6.1's tuple rule exists to prevent.
   */
  const accepted = new Map<string, Set<number>>()
  const contiguous = new Map<string, number>()
  const listeners = new Set<(tasks: PetTaskProjection[]) => void>()
  let runCount = 0

  function projectionOf(task: LiveTask): PetTaskProjection {
    return {
      key: task.key,
      state: task.state,
      permissionRequestId: task.permissionRequestId,
      updatedAt: task.updatedAt,
    }
  }

  function currentTasks(): PetTaskProjection[] {
    return [...live.values()].map(projectionOf)
  }

  /** A complete list every time, which is why a subscriber needs no replay machinery. */
  function publish(): void {
    const snapshot = currentTasks()
    for (const listener of listeners) listener(snapshot)
  }

  /** The six identity fields of an event, or null when it names no run to file under. */
  function keyOf(event: AgentEvent): PetTaskKey | null {
    if (event.runId === null) return null
    return {
      agentId: event.agentId,
      profileId: event.profileId,
      runtimeEpoch: event.runtimeEpoch,
      vaultId: event.vaultId,
      sessionId: event.sessionId,
      runId: event.runId,
    }
  }

  /** The session an identity names, without its run: what a sequence number belongs to. */
  function sessionTokenOf(identity: AgentIdentity): string {
    return petKeyToken([
      identity.agentId,
      identity.profileId,
      identity.runtimeEpoch,
      identity.vaultId,
      identity.sessionId,
    ])
  }

  function orderOf(session: string, sequence: number): PetFrameOrder {
    const known = accepted.get(session)
    const missing: number[] = []
    if (known && !known.has(sequence)) {
      for (let n = (contiguous.get(session) ?? 0) + 1; n < sequence; n += 1) {
        if (!known.has(n)) missing.push(n)
      }
    }
    return { sequence, missing }
  }

  function remember(session: string, sequence: number): void {
    const known = accepted.get(session) ?? new Set<number>()
    accepted.set(session, known)
    known.add(sequence)
    let reached = contiguous.get(session) ?? 0
    while (known.has(reached + 1)) reached += 1
    contiguous.set(session, reached)
  }

  function nextSequence(session: string): number {
    let highest = 0
    for (const number of accepted.get(session) ?? []) highest = Math.max(highest, number)
    return highest + 1
  }

  /** A frame built by a verb below, in the shape the ACP validator accepts. */
  function frameFor(
    key: PetTaskKey,
    kind: AgentEventKind,
    payload: unknown,
  ): Record<string, unknown> {
    return {
      agentId: key.agentId,
      profileId: key.profileId,
      runtimeEpoch: key.runtimeEpoch,
      vaultId: key.vaultId,
      sessionId: key.sessionId,
      runId: key.runId,
      sequence: nextSequence(sessionTokenOf(key)),
      kind,
      payload,
    }
  }

  function ingest(frame: unknown): PetIngestOutcome {
    const event = readAgentEvent(frame)
    if (event instanceof AgentFailure) {
      return { status: 'rejected', code: event.code, message: event.message }
    }
    const session = sessionTokenOf(event)
    const order = orderOf(session, event.sequence)

    if (event.runtimeEpoch !== epoch) {
      return {
        status: 'foreign',
        key: keyOf(event),
        order,
        detail: `carried runtime instance ${event.runtimeEpoch}, and this host serves ${epoch}`,
      }
    }
    const key = keyOf(event)
    if (!key) {
      return { status: 'foreign', key: null, order, detail: 'belongs to no run' }
    }

    // A sequence already accepted is reported and not applied again: applying a frame
    // twice is not a policy choice the host is entitled to make.
    if (accepted.get(session)?.has(event.sequence)) {
      return { status: 'replayed', key, order }
    }
    remember(session, event.sequence)

    const outcome = petOutcomeFromEvent(event)
    if (outcome === null) return { status: 'no-change', key, order }

    const token = petTaskToken(key)
    const existing = live.get(token)
    if (existing && isPetTaskSettled(existing.state)) {
      // §6.3: a terminal state is not revived by a later work event, and §6.2's rows are
      // the record of how the run ended. A later turn of the same conversation is a new
      // run, and therefore a different key, not a reason to reopen this one.
      return {
        status: 'settled',
        key,
        order,
        detail: `${existing.state} is already how this run ended`,
      }
    }

    const task: LiveTask = {
      key,
      state: outcome.state,
      permissionRequestId: outcome.permissionRequestId,
      updatedAt: now(),
    }
    live.set(token, task)
    publish()
    return { status: 'applied', key, order, task: projectionOf(task) }
  }

  return {
    startRun(runOptions: MemoryRunOptions = {}) {
      runCount += 1
      const key: PetTaskKey = {
        agentId: MEMORY_PET_AGENT,
        profileId: MEMORY_PET_PROFILE,
        runtimeEpoch: epoch,
        vaultId: runOptions.vaultId ?? MEMORY_PET_VAULT,
        sessionId: runOptions.sessionId ?? `session-${runCount}`,
        runId: `run-${runCount}`,
      }
      // A run's start is not an event in the ACP vocabulary, so it comes from the host's
      // own view of the session — the route §6.2's first row describes, and the reason a
      // task can be `working` at all.
      const outcome = petOutcomeFromSessionState('running')
      if (outcome) {
        live.set(petTaskToken(key), {
          key,
          state: outcome.state,
          permissionRequestId: outcome.permissionRequestId,
          updatedAt: now(),
        })
        publish()
      }
      return key
    },

    finishRun(key: PetTaskKey, stopReason: AgentStopReason) {
      return ingest(frameFor(key, 'run-finished', { stopReason, usage: null }))
    },

    failRun(key: PetTaskKey, code: AgentFailureCode) {
      return ingest(frameFor(key, 'run-failed', { code, message: `the run failed: ${code}` }))
    },

    requestPermission(key: PetTaskKey, requestId: string) {
      return ingest(
        frameFor(key, 'permission-request', {
          requestId,
          // The tool call this prompt is about: the contract carries it so a
          // consumer can join the prompt to the row the timeline already shows.
          toolCallId: `${key.sessionId}:tool`,
          title: 'A tool wants to run',
          input: { state: 'absent' },
          // The request's own content blocks, which the contract requires a producer to state:
          // `[]` here is the honest one — this double's request proposes no change, so nothing
          // is drawn for it, and nothing is taken from anywhere else either. The pet itself
          // reads none of them (it shows that input is wanted and authorises nothing).
          content: [],
          // Exactly the options the engine offered (§6.3): the double must not look like
          // an engine that invents an answer, and the pet never offers one at all.
          // The kind is the wire's own (`allow_once`), not a collapsed allow/reject —
          // §6.3's rule that the UI uses the engine's options only means something if
          // the difference between a one-off and a lasting grant survives the contract.
          options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
        }),
      )
    },

    loseRuntime(loss: PetRuntimeLoss) {
      const outcome = petOutcomeFromRuntimeLoss(loss)
      const restated: PetTaskProjection[] = []
      for (const task of live.values()) {
        // A settled task keeps its result. §6.3 forbids an older event being read back
        // into a terminal state, and a runtime that went away went away *after* those
        // runs ended — so the loss says nothing about them.
        if (isPetTaskSettled(task.state)) continue
        task.state = outcome.state
        task.permissionRequestId = null
        task.updatedAt = now()
        restated.push(projectionOf(task))
      }
      if (restated.length > 0) publish()
      return restated
    },
    tasks: currentTasks,

    subscribe(onTasks: (tasks: PetTaskProjection[]) => void) {
      listeners.add(onTasks)
      // The list is complete, so delivering it now closes the window between reading and
      // subscribing without any replay buffer to maintain.
      onTasks(currentTasks())
      return () => {
        listeners.delete(onTasks)
      }
    },

    ingest,
  }
}
