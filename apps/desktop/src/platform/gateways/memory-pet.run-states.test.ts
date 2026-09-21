import { describe, expect, it } from 'vitest'
import { AGENT_FAILURE_CODES, AGENT_STOP_REASONS, type AgentStopReason } from './agent-contracts'
import {
  PET_ALERT_BY_STATE,
  PET_TASK_STATES,
  isPetTaskSettled,
  petStateFromFailure,
  samePetTask,
  type PetTaskKey,
  type PetTaskProjection,
  type PetTaskState,
} from './pet-contracts'
import {
  MEMORY_PET_VAULT,
  createMemoryPetGateway,
  type MemoryPetGateway,
  type PetIngestOutcome,
} from './memory-pet'

const IDENTITY = {
  agentId: 'memory',
  profileId: 'default',
  runtimeEpoch: 'epoch-1',
  vaultId: MEMORY_PET_VAULT,
  sessionId: 'session-1',
}

/**
 * A frame delivered by hand, for the cases no verb can express: a foreign identity, a
 * reused sequence, a payload that is not the one a verb builds.
 */
function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...IDENTITY,
    runId: 'run-1',
    sequence: 1,
    kind: 'run-finished',
    payload: { stopReason: 'end-turn', usage: null },
    ...overrides,
  }
}

/** The one task, for the many cases that drive a single run. */
async function onlyTask(pet: MemoryPetGateway): Promise<PetTaskProjection> {
  const tasks = await pet.tasks()
  expect(tasks).toHaveLength(1)
  return tasks[0]
}

/** The task a key names, or a failure that says which key was missing. */
async function taskFor(pet: MemoryPetGateway, key: PetTaskKey): Promise<PetTaskProjection> {
  const task = (await pet.tasks()).find((candidate) => samePetTask(candidate.key, key))
  if (!task) throw new Error(`no task for run ${key.runId}`)
  return task
}

/** The outcome of a frame that had to have been applied. */
function applied(outcome: PetIngestOutcome): PetTaskProjection {
  expect(outcome.status).toBe('applied')
  if (outcome.status !== 'applied') throw new Error(`expected an applied frame`)
  return outcome.task
}

describe('the states §6.2 maps runs onto', () => {
  it('shows a run the snapshot says is executing as working, and reads nothing into a lull', async () => {
    const pet = createMemoryPetGateway()
    pet.startRun()
    expect((await onlyTask(pet)).state).toBe('working')

    // A streamed chunk is not a start signal, and a pause in one is not a completion
    // (§6.2 row 1): neither changes what the pet shows.
    const chunk = pet.ingest(frame({ sequence: 1, kind: 'text-delta', payload: { text: 'hi' } }))
    expect(chunk.status).toBe('no-change')
    expect((await onlyTask(pet)).state).toBe('working')
  })

  it('shows a permission request as waiting-input, and carries nothing to answer it with', async () => {
    const pet = createMemoryPetGateway()
    const key = pet.startRun()
    const outcome = applied(pet.requestPermission(key, 'p-1'))

    expect(outcome.state).toBe('waiting-input')
    expect(outcome.permissionRequestId).toBe('p-1')
    // §6.2: the pet points at the host's own permission UI and authorises nothing. The
    // field list is the check, not a rule: there is no option, title or argument here
    // for a component to act on even by accident.
    expect(Object.keys(outcome).sort()).toEqual([
      'key',
      'permissionRequestId',
      'state',
      'updatedAt',
    ])
  })

  it('says a turn finished on end-turn, and claims nothing beyond that turn', async () => {
    const pet = createMemoryPetGateway()
    const key = pet.startRun()
    expect(applied(pet.finishRun(key, 'end-turn')).state).toBe('turn-finished')
    // §6.2: "this turn finished" is the whole claim. A goal-level completion would need a
    // goal identifier, and the ACP contract carries none — so the pet state that would
    // assert it does not exist rather than being guessed from a stop reason.
    expect(PET_ALERT_BY_STATE['turn-finished']).toBe('turn-finished')
  })

  it('shows a limit as stopped and a refusal as refused, neither of them a celebration', async () => {
    for (const reason of ['max-tokens', 'max-turn-requests'] as const) {
      const pet = createMemoryPetGateway()
      const key = pet.startRun()
      const state = applied(pet.finishRun(key, reason)).state
      expect(state).toBe('stopped')
      // §6.2: reached a limit, so it is explained and not celebrated.
      expect(PET_ALERT_BY_STATE[state]).toBe('needs-attention')
    }

    const pet = createMemoryPetGateway()
    const key = pet.startRun()
    const state = applied(pet.finishRun(key, 'refusal')).state
    expect(state).toBe('refused')
    expect(PET_ALERT_BY_STATE[state]).toBe('needs-attention')
  })

  it('keeps the three non-error stop reasons apart from each other and from a failure', async () => {
    const expected: { [S in AgentStopReason]: PetTaskState } = {
      'end-turn': 'turn-finished',
      'max-tokens': 'stopped',
      'max-turn-requests': 'stopped',
      refusal: 'refused',
      cancelled: 'cancelled',
    }
    for (const reason of AGENT_STOP_REASONS) {
      const pet = createMemoryPetGateway()
      const key = pet.startRun()
      const outcome = applied(pet.finishRun(key, reason))
      expect(outcome.state).toBe(expected[reason])
      // Not one of the five endings is a runtime failure, which is why they belong to
      // `run-finished` and why four of them get their own row rather than a shared one.
      expect(outcome.state).not.toBe('failed')
    }
    // Five reasons, four states: the two ceilings share `stopped`, and nothing else does.
    expect(new Set(Object.values(expected)).size).toBe(4)
  })

  it('reads an ending whose reason it does not know as unknown, not as a finished turn', async () => {
    // The reason is one this version has never seen, which P0 §6.3's measurement of the same
    // engine's changing protocol surface makes a normal frame rather than a corrupt one. Neither
    // wrong reading may happen: refusing the frame reports the engine's finished turn as a
    // failure, and `turn-finished` asserts an ending nobody established (§6.2). It lands on
    // `unknown` — and `unknown` is deliberately not settled, so a later frame that does know wins.
    const pet = createMemoryPetGateway()
    const key = pet.startRun()

    const outcome = applied(
      pet.ingest(frame({ payload: { stopReason: 'budget_exceeded', usage: null } })),
    )
    expect(outcome.state).toBe('unknown')
    expect(PET_ALERT_BY_STATE.unknown).toBe('needs-attention')
    expect(isPetTaskSettled('unknown')).toBe(false)

    const informed = pet.ingest(
      frame({ sequence: 2, payload: { stopReason: 'refusal', usage: null } }),
    )
    expect(informed.status).toBe('applied')
    expect((await taskFor(pet, key)).state).toBe('refused')
  })

  it('shows a cancelled run as cancelled, whether it ended or failed that way', async () => {
    const ended = createMemoryPetGateway()
    const endedKey = ended.startRun()
    expect(applied(ended.finishRun(endedKey, 'cancelled')).state).toBe('cancelled')

    const failed = createMemoryPetGateway()
    const failedKey = failed.startRun()
    // §6.2 row 6 covers the cancellation-class failure as well, and it is the failure
    // code — not the event kind — that decides it.
    expect(applied(failed.failRun(failedKey, 'cancelled')).state).toBe('cancelled')

    // No success sound and not a failure reward: quiet is the only reaction that is
    // neither (§6.2).
    expect(PET_ALERT_BY_STATE.cancelled).toBe('quiet')
  })

  it('keeps the task entry of a run that failed, with the detail staying in the main panel', async () => {
    const pet = createMemoryPetGateway()
    const key = pet.startRun()
    const outcome = applied(pet.failRun(key, 'timeout'))
    expect(outcome.state).toBe('failed')
    expect(PET_ALERT_BY_STATE.failed).toBe('needs-attention')
    // §6.2: the entry stays. The pet does not explain the failure and does not retry it.
    expect(await taskFor(pet, key)).toMatchObject({ state: 'failed' })
  })

  it('classifies every failure code, and reads a lost runtime as an interruption', () => {
    for (const code of AGENT_FAILURE_CODES) {
      expect(['failed', 'interrupted', 'cancelled']).toContain(petStateFromFailure(code))
    }
    expect(petStateFromFailure('cancelled')).toBe('cancelled')
    expect(petStateFromFailure('process-exited')).toBe('interrupted')
    expect(petStateFromFailure('runtime-unavailable')).toBe('interrupted')
    expect(petStateFromFailure('timeout')).toBe('failed')
    // The vocabulary's eleventh code: a runtime that cannot verify a certificate failed
    // the run, it did not lose it.
    expect(petStateFromFailure('certificate-untrusted')).toBe('failed')
  })

  it('never reads a lost runtime as done, and has no state that could stand for it', () => {
    // §6.2's last row is the reason this assertion is structural rather than textual:
    // there is no single success state for `interrupted` to collapse into.
    expect(PET_TASK_STATES).not.toContain('done')
    expect(PET_TASK_STATES).not.toContain('completed')
    expect(isPetTaskSettled('interrupted')).toBe(true)
    // `unknown` is not settled: it admits the host does not know, so a later fact has to
    // be able to replace it.
    expect(isPetTaskSettled('unknown')).toBe(false)
  })

  it('interrupts what was in flight when the runtime crashed, and leaves settled runs alone', async () => {
    const pet = createMemoryPetGateway()
    const croaked = pet.startRun()
    const finished = pet.startRun()
    applied(pet.finishRun(finished, 'end-turn'))

    const restated = pet.loseRuntime('runtime-crashed')
    expect(restated.map((task) => task.state)).toEqual(['interrupted'])
    expect(restated[0].key.runId).toBe(croaked.runId)
    // The runtime went away after this one ended, so it says nothing about it (§6.3).
    expect(await taskFor(pet, finished)).toMatchObject({ state: 'turn-finished' })
  })

  it('admits it does not know when the connection is lost, and lets a later fact resolve it', async () => {
    const pet = createMemoryPetGateway()
    const key = pet.startRun()
    pet.loseRuntime('connection-lost')
    expect((await onlyTask(pet)).state).toBe('unknown')

    const late = pet.finishRun(key, 'end-turn')
    expect(applied(late).state).toBe('turn-finished')
  })

  it('can produce every state the contract names, with none left over', async () => {
    const produced = new Set<PetTaskState>()
    const collect = async (pet: MemoryPetGateway) => {
      for (const task of await pet.tasks()) produced.add(task.state)
    }

    const pet = createMemoryPetGateway()
    pet.startRun()
    await collect(pet)
    const waiting = pet.startRun()
    pet.requestPermission(waiting, 'p-1')
    await collect(pet)
    const done = pet.startRun()
    pet.finishRun(done, 'end-turn')
    await collect(pet)
    const cancelled = pet.startRun()
    pet.finishRun(cancelled, 'cancelled')
    await collect(pet)
    pet.startRun()
    pet.loseRuntime('runtime-crashed')
    await collect(pet)
    pet.startRun()
    pet.loseRuntime('connection-lost')
    await collect(pet)

    const stopped = createMemoryPetGateway()
    applied(stopped.finishRun(stopped.startRun(), 'max-tokens'))
    await collect(stopped)

    const refused = createMemoryPetGateway()
    applied(refused.finishRun(refused.startRun(), 'refusal'))
    await collect(refused)

    const failed = createMemoryPetGateway()
    applied(failed.failRun(failed.startRun(), 'timeout'))
    await collect(failed)

    expect([...produced].sort()).toEqual([...PET_TASK_STATES].sort())
  })
})
