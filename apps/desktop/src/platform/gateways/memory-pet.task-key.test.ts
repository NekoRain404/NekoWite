import { describe, expect, it } from 'vitest'
import {
  petKeyToken,
  petTaskToken,
  samePetTask,
  type PetTaskKey,
  type PetTaskProjection,
} from './pet-contracts'
import {
  MEMORY_PET_VAULT,
  createMemoryPetGateway,
  type MemoryPetGateway,
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

describe('the task key', () => {
  it('keeps two agents whose sessions share a name apart', async () => {
    const pet = createMemoryPetGateway()
    pet.startRun()
    // The upstream store keys on `agent:session` and then finds a session by its suffix
    // (`windows/src/state.ts:54`, `:85-89`), so this frame would land on the first task.
    const other = pet.ingest(frame({ agentId: 'opencode' }))
    expect(other.status).toBe('applied')
    expect(await pet.tasks()).toHaveLength(2)
  })

  it('encodes a key so that no two different keys produce one string', () => {
    // Bare colons would make these two the same string.
    expect(petKeyToken(['a:b', 'c'])).not.toBe(petKeyToken(['a', 'b:c']))
    expect(petKeyToken(['a:b', 'c'])).not.toBe(petKeyToken(['a:b:c']))
    const key: PetTaskKey = { ...IDENTITY, runId: 'run-1' }
    expect(petTaskToken(key)).toBe(petKeyToken([
      'memory',
      'default',
      'epoch-1',
      MEMORY_PET_VAULT,
      'session-1',
      'run-1',
    ]))
  })

  it('does not apply a frame from a runtime instance that is over', async () => {
    const pet = createMemoryPetGateway()
    const key = pet.startRun()
    const stale = pet.ingest(frame({ runtimeEpoch: 'epoch-0' }))
    expect(stale).toMatchObject({ status: 'foreign', key: { runtimeEpoch: 'epoch-0' } })
    // The live run is untouched: a queued frame from a previous instance cannot settle a
    // task the current one is still carrying.
    expect(await taskFor(pet, key)).toMatchObject({ state: 'working' })
  })

  it('does not file a frame that names no run under one', async () => {
    const pet = createMemoryPetGateway()
    pet.startRun()
    const orphan = pet.ingest(frame({ runId: null, kind: 'text-delta', payload: { text: 'x' } }))
    expect(orphan).toMatchObject({ status: 'foreign', key: null })
    expect(await onlyTask(pet)).toMatchObject({ state: 'working' })
  })
})
