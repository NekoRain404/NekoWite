/**
 * D6's acceptance, as tests: the write decision's revision gate (V4).
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
  petSettingsRecordFor,
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

describe('the write decision: revision', () => {
  const view: PetSettingsValues['view'] = { alwaysOnTop: true, roam: 'off' }

  it('applies a write at the revision that was read, and moves the revision by one', () => {
    const outcome = decidePetSettingsWrite(
      record('view', view, 4),
      petSettingsWrite('view', 4, { ...view, alwaysOnTop: false }),
    )
    expect(outcome.status).toBe('applied')
    if (outcome.status !== 'applied') return
    expect(outcome.record.revision).toBe(5)
    expect(outcome.record.values).toEqual({ ...view, alwaysOnTop: false })
    expect(outcome.record.schemaVersion).toBe(PET_SETTINGS_SCHEMA_VERSION)
  })

  it('refuses a stale revision outright, and hands back what is actually stored', () => {
    const nowStored = record('view', { ...view, roam: 'stay' }, 2)
    const outcome = decidePetSettingsWrite(nowStored, petSettingsWrite('view', 1, { ...view, alwaysOnTop: false }))
    expect(outcome.status).toBe('conflict')
    if (outcome.status !== 'conflict') return
    // The caller reloads from this record. The edit it wanted is nowhere in it: a merge
    // is how the value the other window changed gets undone (§5.3).
    expect(outcome.current).toEqual(nowStored)
    expect(outcome.current.values).not.toEqual({ ...view, alwaysOnTop: false })
  })

  it('refuses a revision ahead of the store as well: a window cannot skip the counter', () => {
    const outcome = decidePetSettingsWrite(
      record('view', view, 2),
      petSettingsWrite('view', 9, { ...view, alwaysOnTop: false }),
    )
    expect(outcome.status).toBe('conflict')
    if (outcome.status !== 'conflict') return
    expect(outcome.current.revision).toBe(2)
  })

  it('leaves the revision alone when it refuses, so the same write is still the right one', () => {
    const storedRecord = record('view', view, 3)
    const bad = decidePetSettingsWrite(
      storedRecord,
      petSettingsWrite('view', 3, { ...view, roam: 'fly' } as unknown as PetSettingsValues['view']),
    )
    expect(bad.status).toBe('refused')
    const good = decidePetSettingsWrite(storedRecord, petSettingsWrite('view', 3, { ...view, roam: 'stay' }))
    expect(good.status).toBe('applied')
  })

  it('refuses a write presented against a record of another domain', () => {
    // A record the store could actually hold for `character`: the *domain* is what this case is
    // about, so the values are the character defaults with one changed rather than the two fields
    // that happened to be enough to say "a character record" — a stored record missing five of
    // its seven fields is not one any read of this build produces.
    const outcome = decidePetSettingsWrite(
      record('character', { ...PET_SETTINGS_DEFAULTS.character, size: 160 }, 1),
      petSettingsWrite('view', 1, view),
    )
    expect(outcome.status).toBe('refused')
    if (outcome.status !== 'refused') return
    expect(outcome.reason).toBe('invalid-value')
    expect(outcome.message).toContain('view')
  })

  it('pairs a record with its own domain, and only that one', () => {
    const general = record('general', PET_SETTINGS_DEFAULTS.general, 1)
    expect(petSettingsRecordFor(general, 'general')?.values).toEqual(PET_SETTINGS_DEFAULTS.general)
    expect(petSettingsRecordFor(general, 'view')).toBeNull()
    expect(petSettingsRecordFor(null, 'view')).toBeNull()
  })
})
