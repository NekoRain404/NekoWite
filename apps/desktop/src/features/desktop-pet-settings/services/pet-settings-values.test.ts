/**
 * The structured value kind, as tests: what it refuses, what it repairs, and what it hands
 * out.
 *
 * D7d added a fifth value kind — a list or a map whose members are validated by a rule
 * written next to the field — for the ledger rows a single scalar cannot carry. A new kind
 * is new surface on data that arrives from a file, so this file is written the way the
 * threat is shaped rather than the way the happy path is: **wrong type, corrupt shape,
 * oversized, unknown members**, each one asked of both directions, because the module's
 * whole design is one rule that the read path repairs through and the write path refuses
 * through.
 *
 * What is deliberately not here: anything about where a value came from. This module sees
 * an object, and every assertion is about the decision — no store, no window, no clock.
 */
import { describe, expect, it } from 'vitest'
import {
  PET_SETTINGS_DEFAULTS,
  PET_SETTINGS_DOMAINS,
} from '../../../platform/gateways/pet-contracts'
import type { PetSettingsDomain } from '../../../platform/gateways/pet-contracts'
import { resetPetSettingsDomain, samePetSettingsValues } from './pet-settings-policy'
import {
  petSettingsValueProblems,
  readPetSettingsValues,
} from './pet-settings-values'

/** One field, and this build's default for it. */
function defaultValue(domain: PetSettingsDomain, field: string): unknown {
  return (PET_SETTINGS_DEFAULTS[domain] as Record<string, unknown>)[field]
}

/** One field of one domain, with everything else at its default. */
function domainValues(domain: PetSettingsDomain, field: string, value: unknown): Record<string, unknown> {
  return { ...(PET_SETTINGS_DEFAULTS[domain] as Record<string, unknown>), [field]: value }
}

/**
 * The caps {@link PET_STRUCTURED_RULES} states, spelled out here.
 *
 * Written down twice on purpose: a cap is part of what a stored file is allowed to contain,
 * so moving one has to be a decision somebody makes in two places, and the boundary cases
 * below fail loudly the moment one side is changed alone.
 */
const CAPS: Readonly<Record<string, number>> = {
  'character.idleClips': 72,
  'character.bindings': 32,
  'message.hiddenAgents': 64,
  'message.tokens': 16,
  'message.quickBubbles': 50,
  'message.agentIcons': 64,
}

/** Everything the structured kind has to be able to hold except the six list/map fields. */
const STRUCTURED_FIELDS = Object.keys(CAPS)

function lines(count: number, make: (index: number) => unknown = (index) => `line-${index}`): unknown[] {
  return Array.from({ length: count }, (_, index) => make(index))
}

function mapOf(count: number, make: (index: number) => unknown = (index) => index): Record<string, unknown> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`key-${index}`, make(index)]))
}

describe('the structured kind: the rule table is total and the defaults are values of it', () => {
  it('has a rule for every field whose default is a list or a map, and none for the rest', () => {
    // The walk in the policy is keyed by field name and reaches for the rule by path, so this
    // is the assertion that the two cover the same fields — the same shape the numeric-rules
    // test has, for the same reason.
    const structured: string[] = []
    for (const domain of PET_SETTINGS_DOMAINS) {
      for (const [field, fallback] of Object.entries(PET_SETTINGS_DEFAULTS[domain])) {
        if (Array.isArray(fallback) || (typeof fallback === 'object' && fallback !== null)) {
          structured.push(`${domain}.${field}`)
        }
      }
    }
    expect(structured.sort()).toEqual(STRUCTURED_FIELDS.slice().sort())
    for (const path of structured) {
      const [domain, field] = path.split('.') as [PetSettingsDomain, string]
      expect(petSettingsValueProblems(domain, PET_SETTINGS_DEFAULTS[domain])).toEqual([])
      expect(readPetSettingsValues(domain, {}).values).toEqual(PET_SETTINGS_DEFAULTS[domain])
      expect(defaultValue(domain, field)).not.toBeNull()
    }
  })

  it('hands out a copy of a structured default, never the module constant', () => {
    // `PET_SETTINGS_DEFAULTS` is shared by the whole process. For a scalar that is not a
    // hazard the language can express; for an array it is one `push` away, and the page that
    // did it would rewrite the default every other page reads.
    for (const [domain, field] of [
      ['character', 'idleClips'],
      ['message', 'quickBubbles'],
    ] as const) {
      const reset = resetPetSettingsDomain(domain, 1).values as Record<string, unknown>
      expect(reset[field]).not.toBe(defaultValue(domain, field))
      ;(reset[field] as unknown[]).push('written by a draft')
      expect(defaultValue(domain, field)).toEqual([])
    }
  })
})

describe('the structured kind: wrong type', () => {
  const wrongType: Array<[PetSettingsDomain, string, unknown]> = [
    ['character', 'idleClips', 'not a list'],
    ['character', 'idleClips', { 0: 1 }],
    ['character', 'bindings', [7]],
    ['character', 'bindings', 'working'],
    ['message', 'hiddenAgents', 'claude'],
    ['message', 'tokens', {}],
    ['message', 'quickBubbles', null],
    ['message', 'agentIcons', []],
  ]

  it('refuses a value that is not the container the field holds', () => {
    for (const [domain, field, raw] of wrongType) {
      expect(petSettingsValueProblems(domain, domainValues(domain, field, raw))).toEqual([
        { path: `${domain}.${field}`, kind: 'wrong-shape' },
      ])
    }
  })

  it('replaces it with the field’s own fallback on the read path, and says which field it was', () => {
    for (const [domain, field, raw] of wrongType) {
      const read = readPetSettingsValues(domain, domainValues(domain, field, raw))
      expect((read.values as Record<string, unknown>)[field]).toEqual(defaultValue(domain, field))
      expect(read.repaired).toEqual([`${domain}.${field}`])
    }
  })
})

describe('the structured kind: corrupt shape', () => {
  const corrupt: Array<[PetSettingsDomain, string, unknown]> = [
    // A spritesheet row is a whole non-negative number: upstream's own settings picker wrote
    // an index, and `animation-bindings.ts` reads `1.5` as nothing at all.
    ['character', 'idleClips', [0, -1]],
    ['character', 'idleClips', [0, 1.5]],
    ['character', 'idleClips', [Number.NaN]],
    ['character', 'idleClips', [0, Number.POSITIVE_INFINITY]],
    ['character', 'idleClips', [0, '1']],
    ['character', 'idleClips', [0, null]],
    ['character', 'bindings', { working: -2 }],
    ['character', 'bindings', { working: 'seven' }],
    // A member that is not a line of text: blank, control-carrying, or not a string.
    ['message', 'quickBubbles', ['']],
    ['message', 'quickBubbles', ['   ']],
    ['message', 'quickBubbles', ['two\nlines']],
    ['message', 'quickBubbles', ['nul\x00byte']],
    ['message', 'quickBubbles', [7]],
    ['message', 'hiddenAgents', ['claude', '']],
    // A row field is `{token, visible}` and nothing else; each half is checked on its own.
    ['message', 'tokens', [{}]],
    ['message', 'tokens', [{ visible: true }]],
    ['message', 'tokens', [{ token: 'dot' }]],
    ['message', 'tokens', [{ token: 'dot', visible: 'yes' }]],
    ['message', 'tokens', [{ token: '', visible: true }]],
    ['message', 'tokens', [{ token: 'dot\n', visible: true }]],
    ['message', 'tokens', [null]],
    ['message', 'tokens', ['dot']],
    ['message', 'tokens', [[{ token: 'dot', visible: true }]]],
    // A map's *key* is one line of text too, or it could not be an agent id or a mood.
    ['character', 'bindings', { '': 3 }],
    ['character', 'bindings', { '  ': 3 }],
    ['character', 'bindings', { 'wor\nking': 3 }],
    ['message', 'agentIcons', { claude: 5 }],
    ['message', 'agentIcons', { claude: '' }],
    ['message', 'agentIcons', { '': 'sym:zap' }],
  ]

  it('refuses the whole field for one unusable member, rather than keeping the usable prefix', () => {
    // All or nothing, like every other field: a playlist this build silently shortened is a
    // playlist the user did not write.
    for (const [domain, field, raw] of corrupt) {
      expect(petSettingsValueProblems(domain, domainValues(domain, field, raw))).toEqual([
        { path: `${domain}.${field}`, kind: 'wrong-shape' },
      ])
    }
  })

  it('repairs the whole field on the read path and reports it once', () => {
    for (const [domain, field, raw] of corrupt) {
      const read = readPetSettingsValues(domain, domainValues(domain, field, raw))
      expect((read.values as Record<string, unknown>)[field]).toEqual(defaultValue(domain, field))
      expect(read.repaired).toEqual([`${domain}.${field}`])
    }
  })

  it('drops a stray key inside a member instead of refusing the member', () => {
    // A record from a build ahead of this one is the case §5.3 tells the *read* path to accept:
    // unknown keys at the top level are dropped, and a member's own unknown key is the same
    // fact one level down. Nothing of it reaches the values this build hands out.
    const raw = [{ token: 'dot', visible: true, colour: 'amber' }]
    const read = readPetSettingsValues('message', domainValues('message', 'tokens', raw))
    expect(read.repaired).toEqual([])
    expect(read.values.tokens).toEqual([{ token: 'dot', visible: true }])
  })
})

describe('the structured kind: oversized', () => {
  // The raw value is one of the two structured shapes and never anything else: the case below
  // asks which of them it is in order to cut it down, and `unknown` cannot be asked — `Array.isArray`
  // narrows a union and leaves `unknown` alone.
  const oversized: Array<
    [PetSettingsDomain, string, unknown[] | Record<string, unknown>, number]
  > = [
    ['character', 'idleClips', lines(CAPS['character.idleClips']! + 1, (i) => i), CAPS['character.idleClips']!],
    ['character', 'bindings', mapOf(CAPS['character.bindings']! + 1), CAPS['character.bindings']!],
    ['message', 'hiddenAgents', lines(CAPS['message.hiddenAgents']! + 1), CAPS['message.hiddenAgents']!],
    [
      'message',
      'tokens',
      lines(CAPS['message.tokens']! + 1, () => ({ token: 'dot', visible: true })),
      CAPS['message.tokens']!,
    ],
    ['message', 'quickBubbles', lines(CAPS['message.quickBubbles']! + 1), CAPS['message.quickBubbles']!],
    ['message', 'agentIcons', mapOf(CAPS['message.agentIcons']! + 1, () => 'sym:zap'), CAPS['message.agentIcons']!],
  ]

  it('refuses a list longer than its rule allows, and accepts exactly the cap', () => {
    for (const [domain, field, raw, cap] of oversized) {
      expect(petSettingsValueProblems(domain, domainValues(domain, field, raw))).toEqual([
        { path: `${domain}.${field}`, kind: 'wrong-shape' },
      ])
      const atCap = Array.isArray(raw)
        ? raw.slice(0, cap)
        : Object.fromEntries(Object.entries(raw).slice(0, cap))
      expect(petSettingsValueProblems(domain, domainValues(domain, field, atCap))).toEqual([])
    }
  })

  it('refuses one over-long line, and a key longer than its own cap', () => {
    // The line cap is the *member's* — 120 for a quick bubble, 64 for an agent id — and the key
    // cap is one for every map.
    expect(
      petSettingsValueProblems('message', domainValues('message', 'quickBubbles', ['x'.repeat(120)])),
    ).toEqual([])
    expect(
      petSettingsValueProblems('message', domainValues('message', 'quickBubbles', ['x'.repeat(121)])),
    ).toEqual([{ path: 'message.quickBubbles', kind: 'wrong-shape' }])
    expect(
      petSettingsValueProblems('message', domainValues('message', 'hiddenAgents', ['a'.repeat(64)])),
    ).toEqual([])
    expect(
      petSettingsValueProblems('message', domainValues('message', 'hiddenAgents', ['a'.repeat(65)])),
    ).toEqual([{ path: 'message.hiddenAgents', kind: 'wrong-shape' }])
    expect(
      petSettingsValueProblems('character', domainValues('character', 'bindings', { ['m'.repeat(64)]: 1 })),
    ).toEqual([])
    expect(
      petSettingsValueProblems('character', domainValues('character', 'bindings', { ['m'.repeat(65)]: 1 })),
    ).toEqual([{ path: 'character.bindings', kind: 'wrong-shape' }])
  })

  it('repairs an oversized list rather than keeping the part that fits', () => {
    const read = readPetSettingsValues(
      'message',
      domainValues('message', 'quickBubbles', lines(CAPS['message.quickBubbles']! + 1)),
    )
    expect(read.values.quickBubbles).toEqual([])
    expect(read.repaired).toEqual(['message.quickBubbles'])
  })
})

describe('the structured kind: unknown members', () => {
  it('refuses a member the closed-set fields do not declare, and accepts each one they do', () => {
    const members: Array<[PetSettingsDomain, string, readonly string[]]> = [
      ['character', 'idleMode', ['random', 'sequential']],
      ['message', 'layoutMode', ['list', 'compact', 'carousel']],
      ['message', 'grouping', ['by-agent', 'flat']],
      ['message', 'filter', ['all', 'attention', 'active', 'working']],
      ['message', 'separator', ['dot', 'arrow', 'bar', 'space']],
      ['message', 'dot', ['plain', 'claude']],
      ['message', 'phraseTheme', ['chef', 'engineer', 'wizard', 'explorer', 'scientist']],
      ['message', 'leftClick', ['none', 'self', 'all']],
    ]
    for (const [domain, field, allowed] of members) {
      for (const member of allowed) {
        expect(petSettingsValueProblems(domain, domainValues(domain, field, member))).toEqual([])
      }
      expect(petSettingsValueProblems(domain, domainValues(domain, field, 'nonsense'))).toEqual([
        { path: `${domain}.${field}`, kind: 'unknown-member' },
      ])
      // The names are strings and only strings: a member list is not a licence for a number.
      expect(petSettingsValueProblems(domain, domainValues(domain, field, 1))).toEqual([
        { path: `${domain}.${field}`, kind: 'unknown-member' },
      ])
    }
  })

  it('keeps an *open* member set open: an agent id or a mood this build has never seen is data', () => {
    // §5.2 requires the visible rows to come from the current registry and an unknown engine to
    // work, and the renderer looks a binding up by a free state string. A closed set here would
    // be this file inventing a vocabulary and then refusing the user's data for not being in it.
    expect(
      petSettingsValueProblems(
        'message',
        domainValues('message', 'agentIcons', { 'an-engine-from-next-year': 'brand:whatever' }),
      ),
    ).toEqual([])
    expect(
      petSettingsValueProblems('character', domainValues('character', 'bindings', { dozing: 5 })),
    ).toEqual([])
    // A row field's name is open for the same reason: the row's vocabulary is the renderer's.
    expect(
      petSettingsValueProblems(
        'message',
        domainValues('message', 'tokens', [{ token: 'a-field-from-next-year', visible: false }]),
      ),
    ).toEqual([])
  })

  it('does not let a stored member name reach the prototype on the way through', () => {
    // `JSON.parse('{"__proto__": …}')` produces an own key, and an assignment loop would then
    // set the prototype of the object this build keeps instead of a member of it.
    const raw = JSON.parse('{"__proto__": "brand:claude", "opencode": "sym:zap"}') as unknown
    const read = readPetSettingsValues('message', domainValues('message', 'agentIcons', raw))
    expect(read.repaired).toEqual([])
    const icons = read.values.agentIcons as Record<string, string>
    expect(Object.prototype.hasOwnProperty.call(icons, '__proto__')).toBe(true)
    expect(icons['__proto__']).toBe('brand:claude')
    expect(Object.getPrototypeOf(icons)).toBe(Object.prototype)
  })
})

describe('the structured kind: what a copy is for', () => {
  it('never hands the stored object out, so a draft cannot edit the record it was read from', () => {
    const stored = { idleClips: [1, 2], bindings: { working: 7 } }
    const read = readPetSettingsValues('character', domainValues('character', 'idleClips', stored.idleClips))
    expect(read.values.idleClips).not.toBe(stored.idleClips)
    expect(read.values.idleClips).toEqual([1, 2])
    ;(read.values.idleClips as number[]).push(9)
    expect(stored.idleClips).toEqual([1, 2])

    const mapped = readPetSettingsValues('character', domainValues('character', 'bindings', stored.bindings))
    expect(mapped.values.bindings).not.toBe(stored.bindings)
    ;(mapped.values.bindings as Record<string, number>).working = 0
    expect(stored.bindings.working).toBe(7)
  })

  it('reads the same stored object twice without remembering either', () => {
    const raw = { idleClips: [1, 2], idleMode: 'sequential' }
    const first = readPetSettingsValues('character', domainValues('character', 'idleClips', raw.idleClips))
    const second = readPetSettingsValues('character', domainValues('character', 'idleClips', raw.idleClips))
    expect(first).toEqual(second)
    expect(first.values.idleClips).not.toBe(second.values.idleClips)
  })
})

describe('the structured kind: equality', () => {
  it('compares two structured values by what they hold, not by which object they are', () => {
    // A `===` here would make every domain that holds a list permanently dirty: a form that
    // writes on every open, and moves the revision out from under every other window.
    const stored = { ...PET_SETTINGS_DEFAULTS.character, idleClips: [1, 2], bindings: { working: 7 } }
    const draft = { ...PET_SETTINGS_DEFAULTS.character, idleClips: [1, 2], bindings: { working: 7 } }
    expect(draft.idleClips).not.toBe(stored.idleClips)
    expect(samePetSettingsValues('character', draft, stored)).toBe(true)
  })

  it('treats a list’s order as part of it and a map’s key order as not', () => {
    const base = { ...PET_SETTINGS_DEFAULTS.character, idleClips: [1, 2] }
    expect(samePetSettingsValues('character', { ...base, idleClips: [2, 1] }, base)).toBe(false)
    expect(samePetSettingsValues('character', { ...base, idleClips: [1, 2, 3] }, base)).toBe(false)
    expect(samePetSettingsValues('character', { ...base, idleClips: [1] }, base)).toBe(false)

    const mapped = { ...PET_SETTINGS_DEFAULTS.character, bindings: { idle: 0, working: 7 } }
    const reordered = { ...PET_SETTINGS_DEFAULTS.character, bindings: { working: 7, idle: 0 } }
    expect(samePetSettingsValues('character', reordered, mapped)).toBe(true)
    expect(
      samePetSettingsValues('character', { ...mapped, bindings: { idle: 0 } }, mapped),
    ).toBe(false)
  })

  it('sees a changed member, and a changed member of a member-sized value', () => {
    const tokens = [
      { token: 'dot', visible: true },
      { token: 'message', visible: true },
    ]
    const base = { ...PET_SETTINGS_DEFAULTS.message, tokens }
    expect(samePetSettingsValues('message', { ...base, tokens: [...tokens] }, base)).toBe(true)
    expect(
      samePetSettingsValues(
        'message',
        { ...base, tokens: [{ token: 'dot', visible: true }, { token: 'message', visible: false }] },
        base,
      ),
    ).toBe(false)
    expect(
      samePetSettingsValues('message', { ...base, tokens: [{ token: 'dot', visible: true }] }, base),
    ).toBe(false)
    // A structured field on one side only is a difference and not a crash.
    expect(samePetSettingsValues('message', { ...PET_SETTINGS_DEFAULTS.message }, base)).toBe(false)
  })
})

describe('the structured kind: absent and unusable stay different facts', () => {
  it('reports an unusable structured value by path, and only for the values that were there', () => {
    // Absent and unusable stay different facts here too: a field the record does not carry was
    // never set and defaults quietly, so a migrated record does not look repaired.
    const read = readPetSettingsValues('message', { ...PET_SETTINGS_DEFAULTS.message, quickBubbles: 'no' })
    expect(read.repaired).toEqual(['message.quickBubbles'])
    const absent = readPetSettingsValues('message', { ...PET_SETTINGS_DEFAULTS.message, quickBubbles: undefined })
    expect(absent.repaired).toEqual(['message.quickBubbles'])
  })
})
