/**
 * D6's acceptance, as tests: the member fields (V4).
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
} from '../../../platform/gateways/pet-contracts'
import type { PetSettingsDomain } from '../../../platform/gateways/pet-contracts'
import { petSettingsValueProblems } from './pet-settings-policy'

describe('the member fields', () => {
  it('writes the schema’s members down exactly once, and completely', () => {
    // `PET_FIELD_MEMBERS` is private, so this goes through the behaviour: every declared
    // member is acceptable and the default is one of them.
    const accepted: Array<[PetSettingsDomain, Record<string, unknown>]> = [
      ['general', { ...PET_SETTINGS_DEFAULTS.general, motion: 'reduced' }],
      ['view', { ...PET_SETTINGS_DEFAULTS.view, roam: 'climb' }],
      ['message', { ...PET_SETTINGS_DEFAULTS.message, theme: 'dark' }],
    ]
    for (const [domain, values] of accepted) {
      expect(petSettingsValueProblems(domain, values)).toEqual([])
    }
    for (const domain of PET_SETTINGS_DOMAINS) {
      // Every field whose default is a string has a member list, and the default is in it.
      expect(petSettingsValueProblems(domain, PET_SETTINGS_DEFAULTS[domain])).toEqual([])
    }
  })

  it('has no third motion value: the pet may reduce further, never undo the system choice', () => {
    expect(
      petSettingsValueProblems('general', {
        enabled: true,
        motion: 'full',
        ball: true,
        characterWindow: true,
        ballSize: PET_SETTINGS_DEFAULTS.general.ballSize,
      }),
    ).toEqual([{ path: 'general.motion', kind: 'unknown-member' }])
    expect(
      petSettingsValueProblems('general', {
        enabled: true,
        motion: 'system',
        ball: true,
        characterWindow: true,
        ballSize: PET_SETTINGS_DEFAULTS.general.ballSize,
      }),
    ).toEqual([])
    expect(
      petSettingsValueProblems('general', {
        enabled: true,
        motion: 'reduced',
        ball: true,
        characterWindow: true,
        ballSize: PET_SETTINGS_DEFAULTS.general.ballSize,
      }),
    ).toEqual([])
  })

  it('keeps every roam mode representable, including the ones a machine cannot do', () => {
    // §5.2 disables the *modes* the platform cannot deliver; rewriting the stored setting
    // would move a profile between machines behind the user's back.
    for (const roam of ['off', 'stay', 'follow-pointer', 'climb']) {
      expect(petSettingsValueProblems('view', { ...PET_SETTINGS_DEFAULTS.view, roam })).toEqual([])
    }
    expect(petSettingsValueProblems('view', { ...PET_SETTINGS_DEFAULTS.view, roam: 'fly' })).toEqual([
      { path: 'view.roam', kind: 'unknown-member' },
    ])
    expect(
      petSettingsValueProblems('message', { ...PET_SETTINGS_DEFAULTS.message, theme: 'sepia' }),
    ).toEqual([{ path: 'message.theme', kind: 'unknown-member' }])
  })

  it('holds a character id or nothing, never a number or an object', () => {
    const character = PET_SETTINGS_DEFAULTS.character
    expect(petSettingsValueProblems('character', { ...character, characterId: 'cat' })).toEqual([])
    expect(petSettingsValueProblems('character', { ...character, characterId: null })).toEqual([])
    expect(petSettingsValueProblems('character', { ...character, characterId: 7 })).toEqual([
      { path: 'character.characterId', kind: 'wrong-type' },
    ])
  })

  it('reports fields in schema order, so two implementations print the same message', () => {
    const problems = petSettingsValueProblems('message', {
      ...PET_SETTINGS_DEFAULTS.message,
      // Written out of order on purpose: the answer is the *schema's* order, so a field that
      // moved in the schema and not in this list fails here.
      opacity: 9,
      theme: 'sepia',
      bubbleSeconds: 0,
    })
    expect(problems.map((problem) => problem.path)).toEqual([
      'message.bubbleSeconds',
      'message.theme',
      'message.opacity',
    ])
  })
})
