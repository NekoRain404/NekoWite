import { describe, expect, it } from 'vitest'
import type { PetTaskProjection } from './pet-contracts'
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

describe('what reaches the pet window', () => {
  it('carries no engine text, reasoning or tool output with a task', async () => {
    const pet = createMemoryPetGateway()
    pet.startRun()
    pet.ingest(frame({ sequence: 1, kind: 'text-delta', payload: { text: 'the note says X' } }))
    pet.ingest(frame({ sequence: 2, kind: 'thought-delta', payload: { text: 'the user wants Y' } }))

    // §6.1: raw chat content, reasoning and full tool output are not sent to the pet
    // window. The projection is a closed shape, so this is a property of the type.
    const shown = JSON.stringify(await onlyTask(pet))
    expect(shown).not.toContain('the note says X')
    expect(shown).not.toContain('the user wants Y')
  })

  it('stamps the injected clock rather than reading one', async () => {
    let clock = 1000
    const pet = createMemoryPetGateway({ now: () => clock })
    const key = pet.startRun()
    clock = 5000
    pet.finishRun(key, 'end-turn')
    expect((await onlyTask(pet)).updatedAt).toBe(5000)
  })

  it('gives a subscriber the current list and every change after it', async () => {
    const pet = createMemoryPetGateway()
    const seen: PetTaskProjection[][] = []
    const off = await pet.subscribe((tasks) => seen.push(tasks))
    expect(seen).toEqual([[]])

    const key = pet.startRun()
    pet.finishRun(key, 'end-turn')
    expect(seen.map((tasks) => tasks.length)).toEqual([0, 1, 1])
    expect(seen[2][0]).toMatchObject({ state: 'turn-finished' })

    off()
    pet.startRun()
    expect(seen).toHaveLength(3)
  })
})
