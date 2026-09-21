/**
 * D6's acceptance, as tests: the unknown-field policy (V4).
 *
 * One behaviour domain of `pet-settings-policy`, split out of a single 811-line file along the
 * describe-block seams; the sections are the brief's own clauses, one group each, so a rule that
 * changes has one place to fail. What is deliberately *not* here is anything about storage: this
 * module decides, and every assertion is about the decision — which is why the file needs
 * no double, no window and no clock.
 */
import { describe, expect, it } from 'vitest'
import { PET_SETTINGS_DEFAULTS } from '../../../platform/gateways/pet-contracts'
import {
  petSettingsValueProblems,
  readPetSettingsValues,
} from './pet-settings-policy'

describe('unknown fields: dropped when stored, refused when submitted', () => {
  it('never carries a stored key the schema does not declare', () => {
    const read = readPetSettingsValues('general', {
      enabled: true,
      motion: 'system',
      ball: true,
      characterWindow: true,
      ap_something_upstream: 'kept? no',
    })
    expect(Object.keys(read.values).sort()).toEqual([
      'ball',
      'ballSize',
      'characterWindow',
      'enabled',
      'motion',
    ])
    expect(read.values).toEqual({
      enabled: true,
      motion: 'system',
      ball: true,
      characterWindow: true,
      ballSize: PET_SETTINGS_DEFAULTS.general.ballSize,
    })
  })

  it('refuses a submitted write carrying a key this build does not know', () => {
    // Accepting and dropping it would report "saved" for a submission the policy did not
    // fully understand.
    expect(
      petSettingsValueProblems('general', {
        enabled: true,
        motion: 'system',
        ball: true,
        characterWindow: true,
        ballSize: PET_SETTINGS_DEFAULTS.general.ballSize,
        futureField: 1,
      }),
    ).toEqual([{ path: 'general.futureField', kind: 'unknown-field' }])
  })

  it('refuses a submission that leaves a field out: a write is the domain, not a patch', () => {
    expect(petSettingsValueProblems('general', { enabled: true })).toEqual([
      { path: 'general.motion', kind: 'missing' },
      { path: 'general.ball', kind: 'missing' },
      { path: 'general.characterWindow', kind: 'missing' },
      { path: 'general.ballSize', kind: 'missing' },
    ])
    expect(petSettingsValueProblems('project', null)).toEqual([{ path: 'project', kind: 'wrong-type' }])
  })
})
