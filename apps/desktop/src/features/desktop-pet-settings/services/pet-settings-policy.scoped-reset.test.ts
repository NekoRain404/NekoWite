/**
 * D6's acceptance, as tests: the scoped reset (V4).
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
  PET_SETTINGS_DOMAINS,
  PET_SETTINGS_SCHEMA_VERSION,
} from '../../../platform/gateways/pet-contracts'
import type {
  PetSettingsDomain,
  PetSettingsRecord,
  PetSettingsValues,
} from '../../../platform/gateways/pet-contracts'
import {
  decidePetSettingsWrite,
  resetPetSettingsDomain,
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

describe('the scoped reset', () => {
  it('offers one domain’s defaults as a write, for every domain', () => {
    for (const domain of PET_SETTINGS_DOMAINS) {
      const reset = resetPetSettingsDomain(domain, 4)
      expect(reset.domain).toBe(domain)
      expect(reset.revision).toBe(4)
      expect(reset.values).toEqual(PET_SETTINGS_DEFAULTS[domain])
      // Exactly one domain's fields, so a page's reset has nothing else to reach for.
      expect(Object.keys(reset.values).sort()).toEqual(Object.keys(PET_SETTINGS_DEFAULTS[domain]).sort())
    }
  })

  it('carries one domain’s fields and no other domain’s', () => {
    const general = resetPetSettingsDomain('general', 1)
    expect(Object.keys(general.values).sort()).toEqual([
      'ball',
      'ballSize',
      'characterWindow',
      'enabled',
      'motion',
    ])
    for (const foreign of [
      'characterId',
      'size',
      'opacity',
      'alwaysOnTop',
      'roam',
      'bubbleSeconds',
      'theme',
      'restReminders',
      'maxCharacters',
    ]) {
      expect(Object.keys(general.values)).not.toContain(foreign)
    }
    // The character library and care progress are not in this schema at all (§5.3 keeps
    // assets in the managed data directory), so the nearest a schema-shaped write can come
    // to proving a reset does not reach them is carrying no field that names one.
    expect(JSON.stringify(general)).not.toContain('characterId')
    // Within its own domain the reset does clear the selection, back to the default that
    // means "no character chosen".
    expect(resetPetSettingsDomain('character', 1).values).toEqual(PET_SETTINGS_DEFAULTS.character)
  })

  it('is a copy of the defaults, so editing a draft cannot rewrite the module constant', () => {
    const reset = resetPetSettingsDomain('character', 1)
    ;(reset.values as unknown as { size: number }).size = 999
    expect(PET_SETTINGS_DEFAULTS.character.size).toBe(160)
  })

  it('goes through the revision gate like any other write', () => {
    const before = record(
      'general',
      {
        ...PET_SETTINGS_DEFAULTS.general,
        motion: 'reduced',
      },
      5,
    )
    const stale = decidePetSettingsWrite(before, resetPetSettingsDomain('general', 4))
    expect(stale.status).toBe('conflict')
    const fresh = decidePetSettingsWrite(before, resetPetSettingsDomain('general', 5))
    expect(fresh.status).toBe('applied')
    if (fresh.status !== 'applied') return
    expect(fresh.record.values).toEqual(PET_SETTINGS_DEFAULTS.general)
  })
})
