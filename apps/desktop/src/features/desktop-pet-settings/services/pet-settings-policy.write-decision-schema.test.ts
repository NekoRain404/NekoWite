/**
 * D6's acceptance, as tests: the write decision's schema and atomicity rules (V4).
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
  PetSettingsWrite,
} from '../../../platform/gateways/pet-contracts'
import {
  decidePetSettingsWrite,
  petSettingsWrite,
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

describe('the write decision: schema, atomicity', () => {
  it('refuses any write against a store written by a newer build, revision included', () => {
    const future = record('project', PET_SETTINGS_DEFAULTS.project, 1)
    const outcome = decidePetSettingsWrite(
      { ...future, schemaVersion: PET_SETTINGS_SCHEMA_VERSION + 1 } as PetSettingsRecord,
      petSettingsWrite('project', 1, { maxCharacters: 5 }),
    )
    expect(outcome.status).toBe('refused')
    if (outcome.status !== 'refused') return
    // The stronger refusal wins even when the revision was also wrong: the caller has to
    // stop writing, not reload and try the same value again.
    expect(outcome.reason).toBe('schema-newer')
  })

  it('applies nothing when one field of a submission is unusable', () => {
    const before = record('view', { alwaysOnTop: true, roam: 'off' }, 7)
    const snapshot = JSON.parse(JSON.stringify(before)) as PetSettingsRecord
    const outcome = decidePetSettingsWrite(
      before,
      petSettingsWrite('view', 7, {
        alwaysOnTop: 'yes',
        roam: 'stay',
      } as unknown as PetSettingsValues['view']),
    )
    expect(outcome.status).toBe('refused')
    // No record to store, so no subset of the submission can have been applied, and the
    // record the caller still holds is byte for byte what it was.
    expect('record' in outcome).toBe(false)
    expect(before).toEqual(snapshot)
  })

  it('names every problem it found, in field order, in the refusal message', () => {
    const outcome = decidePetSettingsWrite(
      record('general', PET_SETTINGS_DEFAULTS.general, 1),
      // Values the type forbids, submitted from outside the app: the IPC boundary carries what
      // the form cannot produce, which is why this policy validates values at all.
      petSettingsWrite('general', 1, {
        enabled: 'on',
        motion: 'full',
      } as unknown as PetSettingsValues['general']),
    )
    expect(outcome.status).toBe('refused')
    if (outcome.status !== 'refused') return
    expect(outcome.message).toBe(
      'general.enabled:wrong-type, general.motion:unknown-member, general.ball:missing, general.characterWindow:missing, general.ballSize:missing',
    )
  })

  it('stamps the current schema version on what it applies, whatever the record said', () => {
    const older = { ...record('care', PET_SETTINGS_DEFAULTS.care, 2), schemaVersion: 0 } as PetSettingsRecord
    const outcome = decidePetSettingsWrite(older, petSettingsWrite('care', 2, { enabled: false, restReminders: false }))
    expect(outcome.status).toBe('applied')
    if (outcome.status !== 'applied') return
    expect(outcome.record.schemaVersion).toBe(PET_SETTINGS_SCHEMA_VERSION)
    expect(outcome.record.values).toEqual({ enabled: false, restReminders: false })
  })

  it('needs no storage to answer, and never returns the arm storage owns', () => {
    // `failed` is what a caller reports when the write could not be persisted; nothing
    // this module can be asked decides that, so no input here reaches it.
    const inputs: unknown[][] = [
      [record('view', PET_SETTINGS_DEFAULTS.view, 1), petSettingsWrite('view', 1, PET_SETTINGS_DEFAULTS.view)],
      [record('view', PET_SETTINGS_DEFAULTS.view, 1), petSettingsWrite('view', 2, PET_SETTINGS_DEFAULTS.view)],
      [
        record('view', PET_SETTINGS_DEFAULTS.view, 1),
        petSettingsWrite('view', 1, {
          ...PET_SETTINGS_DEFAULTS.view,
          roam: 'fly',
        } as unknown as PetSettingsValues['view']),
      ],
    ]
    for (const [storedRecord, write] of inputs) {
      const outcome = decidePetSettingsWrite(
        storedRecord as PetSettingsRecord,
        write as PetSettingsWrite,
      )
      expect(outcome.status).not.toBe('failed')
    }
  })
})
