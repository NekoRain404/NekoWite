import { describe, expect, it } from 'vitest'
import { samePetTask, type PetTaskKey, type PetTaskProjection } from './pet-contracts'
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

describe('the frame log §6.3 needs to have survived', () => {
  it('reports a repeated frame instead of applying it twice', async () => {
    const pet = createMemoryPetGateway()
    const key = pet.startRun()
    expect(applied(pet.finishRun(key, 'end-turn')).state).toBe('turn-finished')

    const again = pet.ingest(frame({ sequence: 1 }))
    expect(again.status).toBe('replayed')
    expect(await taskFor(pet, key)).toMatchObject({ state: 'turn-finished' })
  })

  it('reports the sequence numbers that never arrived', async () => {
    const pet = createMemoryPetGateway()
    pet.startRun()
    pet.ingest(frame({ sequence: 1, kind: 'text-delta', payload: { text: 'a' } }))
    const jumped = pet.ingest(frame({ sequence: 4, kind: 'text-delta', payload: { text: 'b' } }))
    expect(jumped).toMatchObject({ status: 'no-change', order: { sequence: 4, missing: [2, 3] } })
  })

  it('does not revive a settled run with a work event that arrives after it', async () => {
    const pet = createMemoryPetGateway()
    const key = pet.startRun()
    applied(pet.finishRun(key, 'end-turn'))

    const late = pet.requestPermission(key, 'p-late')
    expect(late.status).toBe('settled')
    expect(await taskFor(pet, key)).toMatchObject({ state: 'turn-finished' })
  })

  it('keeps a later turn of one session as a second task rather than a revival', async () => {
    const pet = createMemoryPetGateway()
    const first = pet.startRun()
    applied(pet.finishRun(first, 'end-turn'))
    // §6.3: a later turn has to carry a new run id, which is what makes it a second task.
    const second = pet.startRun({ sessionId: first.sessionId })
    expect(second.runId).not.toBe(first.runId)

    const tasks = await pet.tasks()
    expect(tasks).toHaveLength(2)
    expect(await taskFor(pet, first)).toMatchObject({ state: 'turn-finished' })
    expect(await taskFor(pet, second)).toMatchObject({ state: 'working' })
  })

  it('keeps one task visible while another is being worked on', async () => {
    const pet = createMemoryPetGateway()
    const a = pet.startRun()
    const b = pet.startRun()
    pet.finishRun(a, 'end-turn')
    const tasks = await pet.tasks()
    expect(tasks.map((task) => task.state).sort()).toEqual(['turn-finished', 'working'])
    expect(tasks.map((task) => task.key.runId).sort()).toEqual([a.runId, b.runId].sort())
  })

  it('refuses a frame that is not an event at all, before it becomes a pet fact', () => {
    const pet = createMemoryPetGateway()
    expect(pet.ingest({ kind: 'nonsense' })).toMatchObject({
      status: 'rejected',
      code: 'invalid-response',
    })
  })
})
