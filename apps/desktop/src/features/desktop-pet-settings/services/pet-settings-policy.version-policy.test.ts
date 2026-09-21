/**
 * D6's acceptance, as tests: a stored object's version policy (V4).
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
import type { PetSettingsDomain } from '../../../platform/gateways/pet-contracts'
import {
  PET_SETTINGS_INITIAL_REVISION,
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

describe('a stored object: version policy', () => {
  it('reads a record of this build as current, values and revision intact', () => {
    const outcome = readPetSettingsDomain(
      'general',
      // The stored blob omits `characterWindow` and `ballSize`, which a record of this build would
      // always carry: a field a stored object does not have is *absent* rather than unusable, so it
      // takes the schema's default and the read is still `current` (see `pet-settings-values.ts`).
      stored('general', { enabled: false, motion: 'reduced', ball: false }),
    )
    expect(outcome.status).toBe('current')
    if (outcome.status !== 'current') return
    expect(outcome.record.values).toEqual({
      // `enabled: true` and not the stored `false`: the master is derived from the two switches,
      // and a record this build wrote always carries both. What an older record's `enabled: false`
      // *meant* is the migration's business, and the section on it below is where that is asserted.
      enabled: true,
      motion: 'reduced',
      ball: false,
      characterWindow: true,
      ballSize: PET_SETTINGS_DEFAULTS.general.ballSize,
    })
    expect(outcome.record.revision).toBe(1)
    expect(outcome.record.schemaVersion).toBe(PET_SETTINGS_SCHEMA_VERSION)
  })

  it('reports a record written by a newer build as read-only, values and all', () => {
    const outcome = readPetSettingsDomain(
      'view',
      stored('view', { alwaysOnTop: false, roam: 'stay' }, { version: PET_SETTINGS_SCHEMA_VERSION + 1 }),
    )
    expect(outcome.status).toBe('read-only')
    if (outcome.status !== 'read-only') return
    expect(outcome.reason).toBe('schema-newer')
    expect(outcome.foundVersion).toBe(PET_SETTINGS_SCHEMA_VERSION + 1)
  })

  it('never turns a future record into defaults, however unusable its values look', () => {
    // The whole point of §10.2: the future record's values are absent *and* invalid, so a
    // version check that ran after normalization would hand back seven defaults and a
    // caller would write them over data it did not understand.
    const outcome = readPetSettingsDomain(
      'character',
      stored('character', { size: 'enormous' }, { version: PET_SETTINGS_SCHEMA_VERSION + 2 }),
    )
    expect(outcome.status).toBe('read-only')
    expect('record' in outcome).toBe(false)
    expect('repaired' in outcome).toBe(false)
  })

  it('reports a future record as read-only even when it also carries fields this build has never seen', () => {
    const outcome = readPetSettingsDomain(
      'general',
      { ...stored('general', { enabled: true, motion: 'system' }, { version: PET_SETTINGS_SCHEMA_VERSION + 1 }), futureField: 'x' },
    )
    // Read as "version 1, unknown key dropped, defaults filled in" this would be the same
    // overwrite by a quieter route.
    expect(outcome.status).toBe('read-only')
  })

  it('reads an older record as migrated, and marks the record as upgraded', () => {
    const outcome = readPetSettingsDomain(
      'message',
      stored('message', { bubbleSeconds: 9, theme: 'dark' }, { version: 0, revision: 3 }),
    )
    expect(outcome.status).toBe('migrated')
    if (outcome.status !== 'migrated') return
    expect(outcome.fromVersion).toBe(0)
    expect(outcome.repaired).toEqual([])
    // The older record carried the two fields the schema had then. The fifteen it did
    // not carry default without a report, which is what `repaired` being empty says.
    expect(outcome.record.values).toEqual({
      ...PET_SETTINGS_DEFAULTS.message,
      bubbleSeconds: 9,
      theme: 'dark',
    })
    // The record this build hands back is *its* schema, so the write-back is an upgrade
    // rather than a migration to be replayed on every read.
    expect(outcome.record.schemaVersion).toBe(PET_SETTINGS_SCHEMA_VERSION)
    expect(outcome.record.revision).toBe(3)
  })

  it('reports the paths it repaired while migrating, and leaves usable values alone', () => {
    const outcome = readPetSettingsDomain(
      'general',
      stored('general', { enabled: 'yes', motion: 'full' }, { version: 0 }),
    )
    expect(outcome.status).toBe('migrated')
    if (outcome.status !== 'migrated') return
    expect(outcome.repaired).toEqual(['general.enabled', 'general.motion'])
    expect(outcome.record.values).toEqual(PET_SETTINGS_DEFAULTS.general)
  })

  it('does not call an absent field repaired: never set and unusable are different facts', () => {
    const outcome = readPetSettingsDomain('care', stored('care', { enabled: false }, { version: 0 }))
    if (outcome.status !== 'migrated') throw new Error('expected migrated')
    // `restReminders` was never in the older record, so it defaults without a report;
    // reporting it would make every migrated record look repaired.
    expect(outcome.repaired).toEqual([])
    expect(outcome.record.values).toEqual({ enabled: false, restReminders: true })
  })

  it('has no defaults to offer when there is no record at all, and says which it was', () => {
    for (const missing of [null, undefined]) {
      const outcome = readPetSettingsDomain('project', missing)
      expect(outcome.status).toBe('defaults')
      if (outcome.status !== 'defaults') return
      expect(outcome.reason).toBe('absent')
      expect(outcome.record.values).toEqual(PET_SETTINGS_DEFAULTS.project)
      // Nothing has been written, so the first accepted write starts the counter here.
      expect(outcome.record.revision).toBe(PET_SETTINGS_INITIAL_REVISION)
    }
  })

  it('calls anything that is not a record unreadable rather than absent', () => {
    for (const raw of ['{}', 42, [], true]) {
      const outcome = readPetSettingsDomain('project', raw)
      expect(outcome.status).toBe('defaults')
      if (outcome.status !== 'defaults') return
      expect(outcome.reason).toBe('unreadable')
    }
  })

  it('refuses to invent a revision for a record whose version or revision is unusable', () => {
    const cases: unknown[] = [
      { domain: 'general', revision: 1, values: {} },
      stored('general', {}, { version: 1.5 }),
      { ...stored('general', {}), revision: '1' },
      { ...stored('general', {}), revision: -1 },
      stored('general', 'not an object'),
    ]
    for (const raw of cases) {
      const outcome = readPetSettingsDomain('general', raw)
      expect(outcome.status).toBe('defaults')
      if (outcome.status !== 'defaults') return
      // A fabricated revision would hand the caller a token the store never issued.
      expect(outcome.reason).toBe('unreadable')
      expect(outcome.record.revision).toBe(PET_SETTINGS_INITIAL_REVISION)
    }
  })
})
