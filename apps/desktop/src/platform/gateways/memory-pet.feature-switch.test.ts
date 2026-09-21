import { describe, expect, it } from 'vitest'
import {
  PET_SETTINGS_DEFAULTS,
  samePetTask,
  type PetSettingsLoad,
  type PetTaskKey,
  type PetTaskProjection,
} from './pet-contracts'
import { createMemoryPetGateway, type MemoryPetGateway } from './memory-pet'

/** The task a key names, or a failure that says which key was missing. */
async function taskFor(pet: MemoryPetGateway, key: PetTaskKey): Promise<PetTaskProjection> {
  const task = (await pet.tasks()).find((candidate) => samePetTask(candidate.key, key))
  if (!task) throw new Error(`no task for run ${key.runId}`)
  return task
}

/** The record a load reports, for a test that only cares about the values. */
function recordOf(load: PetSettingsLoad) {
  if (load.status === 'read-only') throw new Error('the host reported the data as read-only')
  return load.record
}

/** Turn the feature on through the settings path, the way the settings page does. */
async function enable(pet: MemoryPetGateway, revision: number): Promise<void> {
  await pet.updateSettings({
    domain: 'general',
    revision,
    values: { ...PET_SETTINGS_DEFAULTS.general, enabled: true },
  })
}

/**
 * The same write with the pet switched *off*, which is the two window switches rather than the
 * master: `general.enabled` is derived from them (`characterWindow || ball`), so a write that set
 * only the master would be recomputed to `true` against the schema's two on-by-default switches —
 * and the pet would come back on the next read. That is exactly the defect the derivation and the
 * 3→4 migration exist to prevent, seen from the side that writes.
 */
async function disable(pet: MemoryPetGateway, revision: number): Promise<void> {
  await pet.updateSettings({
    domain: 'general',
    revision,
    values: {
      ...PET_SETTINGS_DEFAULTS.general,
      characterWindow: false,
      ball: false,
      enabled: false,
    },
  })
}

describe('turning the pet off', () => {
  it('starts on, with the switch there for the people who do not want it', async () => {
    const pet = createMemoryPetGateway()
    // §5.1's 启用 turns the feature *off*: the switch exists for those who do not want a
    // pet at all. §7.1's explicit opt-in requirement is about the pet staying resident
    // after its window is closed, which is a different switch from whether it exists.
    expect(PET_SETTINGS_DEFAULTS.general.enabled).toBe(true)
    expect(await pet.feature()).toEqual({ enabled: true, visible: false })
  })

  it('keeps enabled and visible as two different facts', async () => {
    const pet = createMemoryPetGateway()
    // §5.1 lists 启用 and 显示 apart: on, and not showing, is a pet that is running with
    // its drawing stopped — which is not the same thing as off.
    expect(await pet.feature()).toEqual({ enabled: true, visible: false })
    expect(await pet.setVisible(true)).toEqual({ enabled: true, visible: true })
  })

  it('cannot show a pet that is off, and says so rather than pretending', async () => {
    const pet = createMemoryPetGateway()
    await disable(pet, 1)
    expect(await pet.setVisible(true)).toEqual({ enabled: false, visible: false })
  })

  it('keeps hidden work visible to the reminder path while the window is hidden', async () => {
    const pet = createMemoryPetGateway()
    await enable(pet, 1)
    await pet.setVisible(true)
    const key = pet.startRun()
    await pet.setVisible(false)

    // §7.1: hiding stops the drawing and keeps the backend reminder.
    expect(await pet.feature()).toEqual({ enabled: true, visible: false })
    expect(await taskFor(pet, key)).toMatchObject({ state: 'working' })
  })

  it('cancels no agent task and erases no character, care or history', async () => {
    const pet = createMemoryPetGateway()
    await pet.updateSettings({
      domain: 'character',
      revision: 1,
      values: { ...PET_SETTINGS_DEFAULTS.character, characterId: 'memoir-cat', size: 200 },
    })
    await pet.updateSettings({
      domain: 'care',
      revision: 1,
      values: { ...PET_SETTINGS_DEFAULTS.care, restReminders: false },
    })
    await enable(pet, 1)
    const key = pet.startRun()

    // §4's rollback is this switch. §7.1: disabling stops the animation, the listeners and
    // the timers and cancels no agent task.
    await disable(pet, 2)
    expect(await pet.feature()).toEqual({ enabled: false, visible: false })
    expect(await taskFor(pet, key)).toMatchObject({ state: 'working' })
    expect(recordOf(await pet.readSettings('care')).values).toMatchObject({
      restReminders: false,
    })

    // §4: turning it back on finds everything where it was. An erasing teardown would
    // have been unrecoverable here, which is why the contract offers no such affordance.
    await enable(pet, 3)
    expect(recordOf(await pet.readSettings('character')).values).toMatchObject({
      characterId: 'memoir-cat',
      size: 200,
    })
    expect(recordOf(await pet.readSettings('care')).values).toMatchObject({
      restReminders: false,
    })
    expect(await taskFor(pet, key)).toMatchObject({ state: 'working' })
  })
})
