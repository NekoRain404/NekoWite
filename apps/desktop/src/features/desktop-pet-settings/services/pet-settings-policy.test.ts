/**
 * D6's acceptance, as tests: schema, revision, atomic failure, migration, and the
 * unknown-field policy (V4).
 *
 * The sections below are the brief's own clauses, one group each, so a rule that changes
 * has one place to fail. What is deliberately *not* here is anything about storage: this
 * module decides, and every assertion is about the decision — which is why the file needs
 * no double, no window and no clock.
 */
import { describe, expect, it } from 'vitest'
import {
  PET_NUMBER_RULES,
  PET_SETTINGS_DEFAULTS,
  PET_SETTINGS_DOMAINS,
  PET_SETTINGS_SCHEMA_VERSION,
  readPetNumber,
} from '../../../platform/gateways/pet-contracts'
import type {
  PetNumberField,
  PetSettingsDomain,
  PetSettingsRecord,
  PetSettingsValues,
  PetSettingsWrite,
} from '../../../platform/gateways/pet-contracts'
import {
  PET_SETTINGS_INITIAL_REVISION,
  decidePetSettingsWrite,
  petSettingsRecordFor,
  petSettingsValueProblems,
  petSettingsWrite,
  readPetSettingsDomain,
  readPetSettingsValues,
  resetPetSettingsDomain,
  samePetSettingsValues,
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

describe('a stored object: version policy', () => {
  it('reads a record of this build as current, values and revision intact', () => {
    const outcome = readPetSettingsDomain('general', stored('general', { enabled: false, motion: 'reduced' }))
    expect(outcome.status).toBe('current')
    if (outcome.status !== 'current') return
    expect(outcome.record.values).toEqual({ enabled: false, motion: 'reduced' })
    expect(outcome.record.revision).toBe(1)
    expect(outcome.record.schemaVersion).toBe(PET_SETTINGS_SCHEMA_VERSION)
  })

  it('reports a record written by a newer build as read-only, values and all', () => {
    const outcome = readPetSettingsDomain(
      'view',
      stored('view', { opacity: 0.5, alwaysOnTop: false, roam: 'stay' }, { version: PET_SETTINGS_SCHEMA_VERSION + 1 }),
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
    expect(outcome.record.values).toEqual({ bubbleSeconds: 9, theme: 'dark' })
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
    expect(petSettingsValueProblems('character', { characterId: null, size: '160' })).toEqual([
      { path: 'character.size', kind: 'wrong-type' },
    ])
    for (const raw of [NaN, Infinity, -Infinity]) {
      expect(petSettingsValueProblems('character', { characterId: null, size: raw })).toEqual([
        { path: 'character.size', kind: 'not-finite' },
      ])
      expect(petSettingsValueProblems('message', { bubbleSeconds: raw, theme: 'system' })).toEqual([
        { path: 'message.bubbleSeconds', kind: 'not-finite' },
      ])
    }
  })

  it('accepts both ends of a range and refuses just outside it', () => {
    const rule = PET_NUMBER_RULES['character.size']
    for (const raw of [rule.min, rule.max]) {
      expect(petSettingsValueProblems('character', { characterId: null, size: raw })).toEqual([])
    }
    for (const raw of [rule.min - 1, rule.max + 1]) {
      expect(petSettingsValueProblems('character', { characterId: null, size: raw })).toEqual([
        { path: 'character.size', kind: 'out-of-range' },
      ])
    }
    // A fractional rule has no integer requirement, and its bounds are not integers.
    const opacity = PET_NUMBER_RULES['view.opacity']
    expect(petSettingsValueProblems('view', { opacity: 0.5, alwaysOnTop: true, roam: 'off' })).toEqual([])
    expect(petSettingsValueProblems('view', { opacity: opacity.min, alwaysOnTop: true, roam: 'off' })).toEqual([])
    for (const raw of [opacity.min - 0.01, opacity.max + 0.01]) {
      expect(petSettingsValueProblems('view', { opacity: raw, alwaysOnTop: true, roam: 'off' })).toEqual([
        { path: 'view.opacity', kind: 'out-of-range' },
      ])
    }
  })

  it('refuses a fractional value where the rule wants an integer', () => {
    for (const [domain, values] of [
      ['character', { characterId: null, size: 160.5 }],
      ['message', { bubbleSeconds: 6.5, theme: 'system' }],
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

describe('unknown fields: dropped when stored, refused when submitted', () => {
  it('never carries a stored key the schema does not declare', () => {
    const read = readPetSettingsValues('general', {
      enabled: true,
      motion: 'system',
      ap_something_upstream: 'kept? no',
    })
    expect(Object.keys(read.values).sort()).toEqual(['enabled', 'motion'])
    expect(read.values).toEqual({ enabled: true, motion: 'system' })
  })

  it('refuses a submitted write carrying a key this build does not know', () => {
    // Accepting and dropping it would report "saved" for a submission the policy did not
    // fully understand.
    expect(
      petSettingsValueProblems('general', { enabled: true, motion: 'system', futureField: 1 }),
    ).toEqual([{ path: 'general.futureField', kind: 'unknown-field' }])
  })

  it('refuses a submission that leaves a field out: a write is the domain, not a patch', () => {
    expect(petSettingsValueProblems('general', { enabled: true })).toEqual([
      { path: 'general.motion', kind: 'missing' },
    ])
    expect(petSettingsValueProblems('project', null)).toEqual([{ path: 'project', kind: 'wrong-type' }])
  })
})

describe('the member fields', () => {
  it('writes the schema’s members down exactly once, and completely', () => {
    // `PET_FIELD_MEMBERS` is private, so this goes through the behaviour: every declared
    // member is acceptable and the default is one of them.
    const accepted: Array<[PetSettingsDomain, Record<string, unknown>]> = [
      ['general', { enabled: true, motion: 'reduced' }],
      ['view', { opacity: 1, alwaysOnTop: true, roam: 'climb' }],
      ['message', { bubbleSeconds: 6, theme: 'dark' }],
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
      petSettingsValueProblems('general', { enabled: true, motion: 'full' }),
    ).toEqual([{ path: 'general.motion', kind: 'unknown-member' }])
    expect(petSettingsValueProblems('general', { enabled: true, motion: 'system' })).toEqual([])
    expect(petSettingsValueProblems('general', { enabled: true, motion: 'reduced' })).toEqual([])
  })

  it('keeps every roam mode representable, including the ones a machine cannot do', () => {
    // §5.2 disables the *modes* the platform cannot deliver; rewriting the stored setting
    // would move a profile between machines behind the user's back.
    for (const roam of ['off', 'stay', 'follow-pointer', 'climb']) {
      expect(petSettingsValueProblems('view', { opacity: 1, alwaysOnTop: true, roam })).toEqual([])
    }
    expect(petSettingsValueProblems('view', { opacity: 1, alwaysOnTop: true, roam: 'fly' })).toEqual([
      { path: 'view.roam', kind: 'unknown-member' },
    ])
    expect(petSettingsValueProblems('message', { bubbleSeconds: 6, theme: 'sepia' })).toEqual([
      { path: 'message.theme', kind: 'unknown-member' },
    ])
  })

  it('holds a character id or nothing, never a number or an object', () => {
    expect(petSettingsValueProblems('character', { characterId: 'cat', size: 160 })).toEqual([])
    expect(petSettingsValueProblems('character', { characterId: null, size: 160 })).toEqual([])
    expect(petSettingsValueProblems('character', { characterId: 7, size: 160 })).toEqual([
      { path: 'character.characterId', kind: 'wrong-type' },
    ])
  })

  it('reports fields in schema order, so two implementations print the same message', () => {
    const problems = petSettingsValueProblems('view', { opacity: 9, alwaysOnTop: 'yes', roam: 'fly' })
    expect(problems.map((problem) => problem.path)).toEqual([
      'view.opacity',
      'view.alwaysOnTop',
      'view.roam',
    ])
  })
})

describe('the write decision: revision', () => {
  const view: PetSettingsValues['view'] = { opacity: 1, alwaysOnTop: true, roam: 'off' }

  it('applies a write at the revision that was read, and moves the revision by one', () => {
    const outcome = decidePetSettingsWrite(
      record('view', view, 4),
      petSettingsWrite('view', 4, { ...view, opacity: 0.6 }),
    )
    expect(outcome.status).toBe('applied')
    if (outcome.status !== 'applied') return
    expect(outcome.record.revision).toBe(5)
    expect(outcome.record.values).toEqual({ ...view, opacity: 0.6 })
    expect(outcome.record.schemaVersion).toBe(PET_SETTINGS_SCHEMA_VERSION)
  })

  it('refuses a stale revision outright, and hands back what is actually stored', () => {
    const nowStored = record('view', { ...view, alwaysOnTop: false }, 2)
    const outcome = decidePetSettingsWrite(nowStored, petSettingsWrite('view', 1, { ...view, opacity: 0.3 }))
    expect(outcome.status).toBe('conflict')
    if (outcome.status !== 'conflict') return
    // The caller reloads from this record. The edit it wanted is nowhere in it: a merge
    // is how the value the other window changed gets undone (§5.3).
    expect(outcome.current).toEqual(nowStored)
    expect(outcome.current.values).not.toEqual({ ...view, opacity: 0.3 })
  })

  it('refuses a revision ahead of the store as well: a window cannot skip the counter', () => {
    const outcome = decidePetSettingsWrite(
      record('view', view, 2),
      petSettingsWrite('view', 9, { ...view, opacity: 0.3 }),
    )
    expect(outcome.status).toBe('conflict')
    if (outcome.status !== 'conflict') return
    expect(outcome.current.revision).toBe(2)
  })

  it('leaves the revision alone when it refuses, so the same write is still the right one', () => {
    const storedRecord = record('view', view, 3)
    const bad = decidePetSettingsWrite(storedRecord, petSettingsWrite('view', 3, { ...view, opacity: 42 }))
    expect(bad.status).toBe('refused')
    const good = decidePetSettingsWrite(storedRecord, petSettingsWrite('view', 3, { ...view, opacity: 0.4 }))
    expect(good.status).toBe('applied')
  })

  it('refuses a write presented against a record of another domain', () => {
    const outcome = decidePetSettingsWrite(
      record('character', { characterId: null, size: 160 }, 1),
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
    const before = record('view', { opacity: 1, alwaysOnTop: true, roam: 'off' }, 7)
    const snapshot = JSON.parse(JSON.stringify(before)) as PetSettingsRecord
    const outcome = decidePetSettingsWrite(
      before,
      petSettingsWrite('view', 7, { opacity: 42, alwaysOnTop: false, roam: 'stay' }),
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
    expect(outcome.message).toBe('general.enabled:wrong-type, general.motion:unknown-member')
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
      [record('view', PET_SETTINGS_DEFAULTS.view, 1), petSettingsWrite('view', 1, { ...PET_SETTINGS_DEFAULTS.view, opacity: -3 })],
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
    expect(Object.keys(general.values).sort()).toEqual(['enabled', 'motion'])
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
    expect(resetPetSettingsDomain('character', 1).values).toEqual({ characterId: null, size: 160 })
  })

  it('is a copy of the defaults, so editing a draft cannot rewrite the module constant', () => {
    const reset = resetPetSettingsDomain('character', 1)
    ;(reset.values as unknown as { size: number }).size = 999
    expect(PET_SETTINGS_DEFAULTS.character.size).toBe(160)
  })

  it('goes through the revision gate like any other write', () => {
    const before = record('general', { enabled: true, motion: 'reduced' }, 5)
    const stale = decidePetSettingsWrite(before, resetPetSettingsDomain('general', 4))
    expect(stale.status).toBe('conflict')
    const fresh = decidePetSettingsWrite(before, resetPetSettingsDomain('general', 5))
    expect(fresh.status).toBe('applied')
    if (fresh.status !== 'applied') return
    expect(fresh.record.values).toEqual(PET_SETTINGS_DEFAULTS.general)
  })
})

describe('samePetSettingsValues', () => {
  it('ignores key order and sees a changed field', () => {
    expect(samePetSettingsValues('view', { opacity: 1, alwaysOnTop: true, roam: 'off' }, PET_SETTINGS_DEFAULTS.view)).toBe(true)
    const reordered = { roam: 'off', alwaysOnTop: true, opacity: 1 }
    expect(samePetSettingsValues('view', reordered, PET_SETTINGS_DEFAULTS.view)).toBe(true)
    expect(samePetSettingsValues('view', { ...PET_SETTINGS_DEFAULTS.view, opacity: 0.9 }, PET_SETTINGS_DEFAULTS.view)).toBe(false)
  })

  it('does not treat two non-objects, or a stray key, as equal', () => {
    expect(samePetSettingsValues('view', null, PET_SETTINGS_DEFAULTS.view)).toBe(false)
    expect(samePetSettingsValues('view', 'view', 'view')).toBe(false)
    // A key the schema does not declare is not compared, so it cannot make an unchanged
    // draft look dirty.
    expect(samePetSettingsValues('view', { ...PET_SETTINGS_DEFAULTS.view, stray: 1 }, PET_SETTINGS_DEFAULTS.view)).toBe(true)
  })
})

describe('the policy holds no state', () => {
  it('decides the same way twice, and mutates none of its inputs', () => {
    const storedRecord = record('message', { bubbleSeconds: 6, theme: 'system' }, 2)
    const write = petSettingsWrite('message', 2, { bubbleSeconds: 12, theme: 'dark' })
    const snapshot = JSON.parse(JSON.stringify([storedRecord, write])) as unknown[]
    const first = decidePetSettingsWrite(storedRecord, write)
    const second = decidePetSettingsWrite(storedRecord, write)
    expect(second).toEqual(first)
    expect([storedRecord, write]).toEqual(snapshot)
    // The applied record does not alias the submission: the caller's draft may be a
    // reactive object it keeps editing.
    if (first.status !== 'applied') throw new Error('expected applied')
    expect(first.record.values).not.toBe(write.values)
  })

  it('reads the same stored object twice without remembering either', () => {
    const raw = stored('care', { enabled: false, restReminders: true })
    const snapshot = JSON.parse(JSON.stringify(raw)) as unknown
    expect(readPetSettingsDomain('care', raw)).toEqual(readPetSettingsDomain('care', raw))
    expect(raw).toEqual(snapshot)
    // And the arm it hands out is not the object that was read, so a caller cannot reach
    // the stored copy through it.
    const recordArm = currentRecord('care', raw)
    expect(recordArm.values).not.toBe(raw.values)
  })
})
