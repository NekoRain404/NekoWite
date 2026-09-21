import { describe, expect, it } from 'vitest'
import {
  PET_NUMBER_RULES,
  PET_SETTINGS_DEFAULTS,
  PET_SETTINGS_PAGES,
  PET_SETTINGS_SCHEMA_VERSION,
  PET_SETTINGS_SECTION,
  readPetNumber,
  type PetSettingsLoad,
} from './pet-contracts'
import { createMemoryPetGateway } from './memory-pet'

/** The record a load reports, for a test that only cares about the values. */
function recordOf(load: PetSettingsLoad) {
  if (load.status === 'read-only') throw new Error('the host reported the data as read-only')
  return load.record
}

describe('the settings schemas', () => {
  it('refuses a write based on a revision that has moved on, and returns the current one', async () => {
    const pet = createMemoryPetGateway()
    const revision = recordOf(await pet.readSettings('general')).revision

    const applied = await pet.updateSettings({
      domain: 'general',
      revision,
      values: { ...PET_SETTINGS_DEFAULTS.general, enabled: true },
    })
    expect(applied).toMatchObject({ status: 'applied', record: { revision: revision + 1 } })

    // The second window wrote against the same revision. §5.3 refuses it and hands back
    // what is current, so the caller reloads rather than merging a stale form.
    const conflict = await pet.updateSettings({
      domain: 'general',
      revision,
      values: {
        ...PET_SETTINGS_DEFAULTS.general,
        characterWindow: false,
        ball: false,
        enabled: false,
      },
    })
    expect(conflict).toMatchObject({
      status: 'conflict',
      current: { revision: revision + 1, values: { enabled: true } },
    })
    expect(recordOf(await pet.readSettings('general')).values).toMatchObject({ enabled: true })
  })

  it('reports a write it could not persist, and leaves it retryable', async () => {
    const pet = createMemoryPetGateway({ writeFailures: 1 })
    const revision = recordOf(await pet.readSettings('notification')).revision
    const write = {
      domain: 'notification' as const,
      revision,
      values: { ...PET_SETTINGS_DEFAULTS.notification, sound: false },
    }

    // §5.3: a save failure is neither success nor an exception the caller reads as a bug.
    expect(await pet.updateSettings(write)).toMatchObject({ status: 'failed' })
    expect(recordOf(await pet.readSettings('notification')).revision).toBe(revision)
    // The revision did not move, so the same write is still the right one to retry.
    expect(await pet.updateSettings(write)).toMatchObject({ status: 'applied' })
  })

  it('stays off data written by a newer schema instead of overwriting it', async () => {
    const pet = createMemoryPetGateway({ storedSchemaVersion: PET_SETTINGS_SCHEMA_VERSION + 1 })
    expect(await pet.readSettings('character')).toMatchObject({
      status: 'read-only',
      reason: 'schema-newer',
      foundVersion: PET_SETTINGS_SCHEMA_VERSION + 1,
    })
    // §10.2: read-only or an error, never a default written over the user's data.
    expect(
      await pet.updateSettings({
        domain: 'character',
        revision: 1,
        values: PET_SETTINGS_DEFAULTS.character,
      }),
    ).toMatchObject({ status: 'refused', reason: 'schema-newer' })
  })

  it('reports older data as migrated', async () => {
    const pet = createMemoryPetGateway({ storedSchemaVersion: PET_SETTINGS_SCHEMA_VERSION - 1 })
    expect(await pet.readSettings('view')).toMatchObject({
      status: 'migrated',
      fromVersion: PET_SETTINGS_SCHEMA_VERSION - 1,
      repaired: [],
    })
  })

  it('repairs a stored number by one rule for both the interface and the backend', () => {
    const size = PET_NUMBER_RULES['character.size']
    // The bubble's background alpha, which is the schema's only fractional rule. Its bounds are
    // upstream's percent slider held as the *fraction* the alpha is (0.6 to 1.0), so a value
    // strictly inside them is what the assertion below has to use.
    const opacity = PET_NUMBER_RULES['message.opacity']

    expect(readPetNumber(200, size)).toBe(200)
    // Upstream reads these with `parseInt` and no finiteness guard
    // (`windows/src/roam/types.ts:112`), which is how a stored word becomes a NaN speed.
    expect(readPetNumber(Number.NaN, size)).toBe(size.fallback)
    expect(readPetNumber(Number.POSITIVE_INFINITY, size)).toBe(size.fallback)
    expect(readPetNumber('200', size)).toBe(size.fallback)
    // And `parseInt(...) || 100` (`windows/src/main.ts:115`) turns a stored 0 into 100,
    // so the fallback has to be one somebody chose rather than one truthiness chose.
    expect(readPetNumber(0, size)).toBe(size.fallback)
    // Range and integer-ness, on a field that is not an integer and a field that is.
    expect(readPetNumber(0.5, size)).toBe(size.fallback)
    expect(readPetNumber(2, opacity)).toBe(opacity.fallback)
    // Taken from the rule rather than written as a literal: a number this test made up would go
    // stale the day the rule moves, and it would still pass while doing it.
    expect(readPetNumber(opacity.min + 0.01, opacity)).toBe(opacity.min + 0.01)
    // §7.1's cap is a rule and not a suggestion.
    expect(readPetNumber(9, PET_NUMBER_RULES['project.maxCharacters'])).toBe(3)
  })

  it('keeps the task title off a notification unless the user asks for it', () => {
    // §6.3: titles carry no note content and no paths by default, and a default is the
    // only place that holds for a user who never opens the settings page.
    expect(PET_SETTINGS_DEFAULTS.notification.showTaskTitle).toBe(false)
    // §6.3's suggested bubble life, and §7.1's default character cap.
    expect(PET_SETTINGS_DEFAULTS.message.bubbleSeconds).toBe(6)
    expect(PET_SETTINGS_DEFAULTS.project.maxCharacters).toBe(3)
  })

  it('names a settings page the caller cannot invent, and records where it was asked to go', async () => {
    const pet = createMemoryPetGateway()
    await pet.openSettings('advanced')
    expect(pet.openedSettings()).toEqual(['advanced'])
    // §10.1 owns the section id; this is the same name, so a right-click opens something.
    expect(PET_SETTINGS_SECTION).toBe('desktop-pet')
    expect(PET_SETTINGS_PAGES).toContain('advanced')
  })
})
