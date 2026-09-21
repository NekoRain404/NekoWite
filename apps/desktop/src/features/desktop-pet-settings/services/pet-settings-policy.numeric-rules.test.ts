/**
 * D6's acceptance, as tests: the numeric rules: finiteness, range and integer-ness (V4).
 *
 * One behaviour domain of `pet-settings-policy`, split out of a single 811-line file along the
 * describe-block seams; the sections are the brief's own clauses, one group each, so a rule that
 * changes has one place to fail. What is deliberately *not* here is anything about storage: this
 * module decides, and every assertion is about the decision — which is why the file needs
 * no double, no window and no clock.
 */
import { describe, expect, it } from 'vitest'
import {
  PET_NUMBER_RULES,
  PET_SETTINGS_DEFAULTS,
  PET_SETTINGS_DOMAINS,
  readPetNumber,
} from '../../../platform/gateways/pet-contracts'
import type {
  PetNumberField,
  PetSettingsDomain,
} from '../../../platform/gateways/pet-contracts'
import {
  petSettingsValueProblems,
  readPetSettingsValues,
} from './pet-settings-policy'

describe('numeric rules: finiteness, range, integer-ness', () => {
  const numericPaths = (): PetNumberField[] => {
    const paths: PetNumberField[] = []
    for (const domain of PET_SETTINGS_DOMAINS) {
      for (const [field, fallback] of Object.entries(PET_SETTINGS_DEFAULTS[domain])) {
        if (typeof fallback === 'number') paths.push(`${domain}.${field}` as PetNumberField)
      }
    }
    return paths
  }

  it('has a rule for every field whose default is a number', () => {
    // The walk in the policy is keyed by field name and reaches for the rule by path, so
    // this is the assertion that the two tables cover the same fields.
    expect(numericPaths().sort()).toEqual(Object.keys(PET_NUMBER_RULES).sort())
  })

  it('rejects a value that is not a number at all, and one that is not finite', () => {
    expect(
      petSettingsValueProblems('character', { ...PET_SETTINGS_DEFAULTS.character, size: '160' }),
    ).toEqual([{ path: 'character.size', kind: 'wrong-type' }])
    for (const raw of [NaN, Infinity, -Infinity]) {
      expect(
        petSettingsValueProblems('character', { ...PET_SETTINGS_DEFAULTS.character, size: raw }),
      ).toEqual([{ path: 'character.size', kind: 'not-finite' }])
      expect(
        petSettingsValueProblems('message', {
          ...PET_SETTINGS_DEFAULTS.message,
          bubbleSeconds: raw,
        }),
      ).toEqual([{ path: 'message.bubbleSeconds', kind: 'not-finite' }])
    }
  })

  it('accepts both ends of a range and refuses just outside it', () => {
    const rule = PET_NUMBER_RULES['character.size']
    for (const raw of [rule.min, rule.max]) {
      expect(
        petSettingsValueProblems('character', { ...PET_SETTINGS_DEFAULTS.character, size: raw }),
      ).toEqual([])
    }
    for (const raw of [rule.min - 1, rule.max + 1]) {
      expect(
        petSettingsValueProblems('character', { ...PET_SETTINGS_DEFAULTS.character, size: raw }),
      ).toEqual([{ path: 'character.size', kind: 'out-of-range' }])
    }
    // A fractional rule has no integer requirement, and the bubble's alpha is the schema's only
    // one: `message.opacity`, whose bounds are upstream's own percent slider.
    const opacity = PET_NUMBER_RULES['message.opacity']
    expect(
      petSettingsValueProblems('message', { ...PET_SETTINGS_DEFAULTS.message, opacity: 0.7 }),
    ).toEqual([])
    expect(
      petSettingsValueProblems('message', { ...PET_SETTINGS_DEFAULTS.message, opacity: opacity.min }),
    ).toEqual([])
    for (const raw of [opacity.min - 0.01, opacity.max + 0.01]) {
      expect(
        petSettingsValueProblems('message', { ...PET_SETTINGS_DEFAULTS.message, opacity: raw }),
      ).toEqual([{ path: 'message.opacity', kind: 'out-of-range' }])
    }
  })

  it('refuses a fractional value where the rule wants an integer', () => {
    for (const [domain, values] of [
      ['character', { ...PET_SETTINGS_DEFAULTS.character, size: 160.5 }],
      ['message', { ...PET_SETTINGS_DEFAULTS.message, bubbleSeconds: 6.5 }],
      ['project', { maxCharacters: 3.5 }],
    ] as const) {
      const problems = petSettingsValueProblems(domain, values)
      expect(problems).toHaveLength(1)
      expect(problems[0]?.kind).toBe('not-integer')
    }
  })

  it('falls back to the rule when a stored number cannot be used, and agrees with the contract', () => {
    // The read path and `config.ts`'s own reader have to answer the same thing for the
    // same value: the fallback is decided once, in the rules table (§5.3's 「越界旧值在迁移
    // 阶段确定回退」), and this is the assertion that this module did not decide it twice.
    for (const path of numericPaths()) {
      const [domain, field] = path.split('.') as [PetSettingsDomain, string]
      const rule = PET_NUMBER_RULES[path]
      const candidates: unknown[] = [
        NaN,
        Infinity,
        -Infinity,
        '160',
        null,
        undefined,
        -1,
        0,
        rule.min,
        rule.max,
        rule.min - 0.5,
        rule.max + 0.5,
        160.5,
      ]
      for (const candidate of candidates) {
        const read = readPetSettingsValues(domain, { [field]: candidate })
        expect((read.values as Record<string, unknown>)[field]).toBe(readPetNumber(candidate, rule))
      }
    }
  })

  it('reports a repaired number by path and only for values that were actually there', () => {
    const read = readPetSettingsValues('character', { characterId: null, size: 900 })
    expect(read.values.size).toBe(PET_NUMBER_RULES['character.size'].fallback)
    expect(read.repaired).toEqual(['character.size'])
  })
})
