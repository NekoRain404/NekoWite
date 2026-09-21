/**
 * D6's acceptance, as tests: the derived master switch and the migration off the build that had one (V4).
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

describe('the master switch: derived, and migrated from the build that had one', () => {
  /**
   * `general.enabled` is not a control any more: it is `characterWindow || ball`, recomputed on
   * every read and every write by `readPetSettingsValues`. The reported defect is why —
   * 「我希望桌宠和悬浮球可以分别打开分别关闭，不是强绑定的」 — and the shape of the fix is that a
   * record can no longer *say* anything else.
   */
  it('reads the master as its two switches mean, whatever the stored field says', () => {
    const off = currentRecord(
      'general',
      stored('general', { enabled: true, motion: 'system', ball: false, characterWindow: false, ballSize: 56 }),
    )
    expect(off.values).toMatchObject({ enabled: false, ball: false, characterWindow: false })

    const onlyTheBall = currentRecord(
      'general',
      stored('general', { enabled: false, motion: 'system', ball: true, characterWindow: false, ballSize: 56 }),
    )
    expect(onlyTheBall.values).toMatchObject({ enabled: true, ball: true, characterWindow: false })

    // And it is not reported as a repair: the field was usable, and it is a sentence about two
    // other fields rather than a value the user set.
    const migrated = readPetSettingsDomain(
      'general',
      stored('general', { enabled: false, motion: 'system', ball: true, characterWindow: true }, { version: 3 }),
    )
    expect(migrated.status).toBe('migrated')
    expect(migrated.status === 'migrated' ? migrated.repaired : []).not.toContain('general.enabled')
  })

  /**
   * **The record that must not gain a window.** A schema-3 record's `enabled: false` was a master
   * switch turned off — "no pet window at all" — and reading it as the derived value would compute
   * *true* for a record whose two switches were both on, bringing a pet back for someone who had
   * put it away.
   */
  it('turns both switches off for a record that said the pet was off before the derivation', () => {
    const load = readPetSettingsDomain(
      'general',
      stored('general', { enabled: false, motion: 'system', ball: true, characterWindow: true }, { version: 3 }),
    )
    expect(load.status).toBe('migrated')
    if (load.status !== 'migrated') return
    expect(load.fromVersion).toBe(3)
    expect(load.record.schemaVersion).toBe(PET_SETTINGS_SCHEMA_VERSION)
    expect(load.record.values).toMatchObject({ enabled: false, ball: false, characterWindow: false })
  })

  it('leaves the switches of a record that said the pet was on alone', () => {
    const load = readPetSettingsDomain(
      'general',
      stored('general', { enabled: true, motion: 'system', ball: false, characterWindow: true }, { version: 3 }),
    )
    expect(load.status).toBe('migrated')
    if (load.status !== 'migrated') return
    expect(load.record.values).toMatchObject({ enabled: true, ball: false, characterWindow: true })
  })

  it('applies no migration to a record this build wrote', () => {
    // The same values at this build's version are *current*, not migrated: the master's off is a
    // fact about an older schema, and a record that says it now is one whose switches say it.
    const load = readPetSettingsDomain(
      'general',
      stored('general', { enabled: false, motion: 'system', ball: false, characterWindow: false, ballSize: 56 }),
    )
    expect(load.status).toBe('current')
    if (load.status !== 'current') return
    expect(load.record.values).toMatchObject({ enabled: false, ball: false, characterWindow: false })
  })

  it('normalizes a submitted write the same way, so the file cannot hold a contradiction', () => {
    const outcome = decidePetSettingsWrite(
      record('general', PET_SETTINGS_DEFAULTS.general),
      petSettingsWrite('general', 1, {
        ...PET_SETTINGS_DEFAULTS.general,
        enabled: true,
        ball: false,
        characterWindow: false,
      }),
    )
    expect(outcome.status).toBe('applied')
    if (outcome.status !== 'applied') return
    expect(outcome.record.values).toMatchObject({ enabled: false, ball: false, characterWindow: false })
  })
})
