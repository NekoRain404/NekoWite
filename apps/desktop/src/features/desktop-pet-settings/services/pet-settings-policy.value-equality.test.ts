/**
 * D6's acceptance, as tests: `samePetSettingsValues` (V4).
 *
 * One behaviour domain of `pet-settings-policy`, split out of a single 811-line file along the
 * describe-block seams; the sections are the brief's own clauses, one group each, so a rule that
 * changes has one place to fail. What is deliberately *not* here is anything about storage: this
 * module decides, and every assertion is about the decision — which is why the file needs
 * no double, no window and no clock.
 */
import { describe, expect, it } from 'vitest'
import { PET_SETTINGS_DEFAULTS } from '../../../platform/gateways/pet-contracts'
import { samePetSettingsValues } from './pet-settings-policy'

describe('samePetSettingsValues', () => {
  it('ignores key order and sees a changed field', () => {
    expect(
      samePetSettingsValues('view', { alwaysOnTop: true, roam: 'off' }, PET_SETTINGS_DEFAULTS.view),
    ).toBe(true)
    const reordered = { roam: 'off', alwaysOnTop: true }
    expect(samePetSettingsValues('view', reordered, PET_SETTINGS_DEFAULTS.view)).toBe(true)
    expect(
      samePetSettingsValues('view', { ...PET_SETTINGS_DEFAULTS.view, roam: 'stay' }, PET_SETTINGS_DEFAULTS.view),
    ).toBe(false)
  })

  it('does not treat two non-objects, or a stray key, as equal', () => {
    expect(samePetSettingsValues('view', null, PET_SETTINGS_DEFAULTS.view)).toBe(false)
    expect(samePetSettingsValues('view', 'view', 'view')).toBe(false)
    // A key the schema does not declare is not compared, so it cannot make an unchanged
    // draft look dirty.
    expect(samePetSettingsValues('view', { ...PET_SETTINGS_DEFAULTS.view, stray: 1 }, PET_SETTINGS_DEFAULTS.view)).toBe(true)
  })
})
