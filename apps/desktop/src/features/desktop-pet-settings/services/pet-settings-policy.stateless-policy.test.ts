/**
 * D6's acceptance, as tests: the policy's statelessness (V4).
 *
 * One behaviour domain of `pet-settings-policy`, split out of a single 811-line file along the
 * describe-block seams; the sections are the brief's own clauses, one group each, so a rule that
 * changes has one place to fail. What is deliberately *not* here is anything about storage: this
 * module decides, and every assertion is about the decision — which is why the file needs
 * no double, no window and no clock.
 */
import { describe, expect, it } from 'vitest'
import {
  PET_SETTINGS_DEFAULTS,
  PET_SETTINGS_SCHEMA_VERSION,
} from '../../../platform/gateways/pet-contracts'
import type {
  PetSettingsDomain,
  PetSettingsRecord,
  PetSettingsValues,
} from '../../../platform/gateways/pet-contracts'
import {
  decidePetSettingsWrite,
  petSettingsWrite,
  readPetSettingsDomain,
} from './pet-settings-policy'

/** A stored record of `domain`, at the given version and revision. */
function stored(
  domain: PetSettingsDomain,
  values: unknown,
  options: { version?: number; revision?: number } = {},
): Record<string, unknown> {
  return {
    domain,
    schemaVersion: options.version ?? PET_SETTINGS_SCHEMA_VERSION,
    revision: options.revision ?? 1,
    values,
  }
}

/** A record as the contract types it, for the write path. */
function record(
  domain: PetSettingsDomain,
  values: PetSettingsValues[PetSettingsDomain],
  revision = 1,
): PetSettingsRecord {
  return stored(domain, values, { revision }) as unknown as PetSettingsRecord
}

/** The `current` arm's record, or a failure that names what came back instead. */
function currentRecord(domain: PetSettingsDomain, storedRaw: unknown): PetSettingsRecord {
  const outcome = readPetSettingsDomain(domain, storedRaw)
  if (outcome.status !== 'current') throw new Error(`expected current, got ${outcome.status}`)
  return outcome.record
}

describe('the policy holds no state', () => {
  it('decides the same way twice, and mutates none of its inputs', () => {
    const storedRecord = record('message', PET_SETTINGS_DEFAULTS.message, 2)
    const write = petSettingsWrite('message', 2, {
      ...PET_SETTINGS_DEFAULTS.message,
      bubbleSeconds: 12,
      theme: 'dark',
    })
    const snapshot = JSON.parse(JSON.stringify([storedRecord, write])) as unknown[]
    const first = decidePetSettingsWrite(storedRecord, write)
    const second = decidePetSettingsWrite(storedRecord, write)
    expect(second).toEqual(first)
    expect([storedRecord, write]).toEqual(snapshot)
    // The applied record does not alias the submission: the caller's draft may be a
    // reactive object it keeps editing.
    if (first.status !== 'applied') throw new Error('expected applied')
    expect(first.record.values).not.toBe(write.values)
  })

  it('reads the same stored object twice without remembering either', () => {
    const raw = stored('care', { enabled: false, restReminders: true })
    const snapshot = JSON.parse(JSON.stringify(raw)) as unknown
    expect(readPetSettingsDomain('care', raw)).toEqual(readPetSettingsDomain('care', raw))
    expect(raw).toEqual(snapshot)
    // And the arm it hands out is not the object that was read, so a caller cannot reach
    // the stored copy through it.
    const recordArm = currentRecord('care', raw)
    expect(recordArm.values).not.toBe(raw.values)
  })
})
