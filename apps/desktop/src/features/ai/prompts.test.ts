/**
 * The shelf of writing prompts.
 *
 * Two things are worth guarding here and they are different kinds of thing: the
 * *shape* of the shelf (ids unique, filtering total) and the fact that every
 * key it names actually resolves. The second is the one that rots — a label
 * key is never written as `t('…')` in source, it is a value in a table, so the
 * app-wide scan in `i18n.test.ts` cannot see it and a prompt whose translation
 * was renamed would render as its raw key with nothing failing.
 */
import { describe, expect, it } from 'vitest'
import { CHAT_PROMPTS, CHAT_PROMPT_IDS, enabledPrompts } from './prompts'
import { messages } from '../../i18n'

/** Every dotted key a locale actually defines, as `a.b.c` strings. */
function flatten(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key),
  )
}

/** What a dotted key resolves to, so a test can read the instruction itself and
 *  not only that the key exists. */
function lookup(source: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    if (typeof node !== 'object' || node === null) return undefined
    return (node as Record<string, unknown>)[part]
  }, source)
}

describe('the prompt shelf', () => {
  it('names each prompt once', () => {
    expect(new Set(CHAT_PROMPT_IDS).size).toBe(CHAT_PROMPT_IDS.length)
    expect(CHAT_PROMPTS.length).toBeGreaterThan(3)
  })

  it('resolves every key it names, in both locales', () => {
    // The keys live in a table rather than at a call site, so this is the only
    // check that a renamed translation does not turn a shortcut into
    // "ai.prompt.summarize.label" on screen.
    const en = new Set(flatten(messages.en))
    const zh = new Set(flatten(messages.zh))
    const missing: string[] = []
    for (const prompt of CHAT_PROMPTS) {
      if (!en.has(prompt.labelKey)) missing.push(`${prompt.id} label (en): ${prompt.labelKey}`)
      if (!zh.has(prompt.labelKey)) missing.push(`${prompt.id} label (zh): ${prompt.labelKey}`)
      if (!en.has(prompt.instructionKey)) missing.push(`${prompt.id} text (en): ${prompt.instructionKey}`)
      if (!zh.has(prompt.instructionKey)) missing.push(`${prompt.id} text (zh): ${prompt.instructionKey}`)
    }
    expect(missing).toEqual([])
  })

  it('shows every prompt until something is switched off', () => {
    expect(enabledPrompts([])).toEqual(CHAT_PROMPTS)
  })

  it('filters by id, and ignores an id that is no longer on the shelf', () => {
    // An id from an older build must not be able to hide a prompt that has
    // since been added under the same name it used to have.
    const shown = enabledPrompts(['title', 'a-prompt-that-was-removed'])
    expect(shown.map((p) => p.id)).not.toContain('title')
    expect(shown).toHaveLength(CHAT_PROMPTS.length - 1)
  })

  it('carries the prompts the user asked for by name', () => {
    // Asserted by id, not by label: the id is what the store persists, so a
    // rename of the UI copy must not be able to make this pass.
    for (const id of ['soundHuman', 'academic', 'critique', 'evidence']) {
      expect(CHAT_PROMPT_IDS).toContain(id)
    }
  })

  it('leaves a prompt added later switched on for an install that has already chosen', () => {
    // The store keeps the OFF list, so a build that adds a prompt hands it to an
    // install whose stored list cannot mention it. This is the property that
    // makes adding one a data change with no migration behind it, and it is
    // asserted here because it is invisible from either end alone: the store
    // cannot know the shelf grew, and the shelf cannot know what was switched
    // off.
    const shown = enabledPrompts(['outline', 'title']).map((p) => p.id)
    expect(shown).toContain('soundHuman')
    expect(shown).toContain('academic')
    expect(shown).toContain('evidence')
    expect(shown).not.toContain('outline')
  })

  it('stays short enough to be a shelf', () => {
    // "A shelf of thirty is a menu" is the shelf's own ruling, and a ruling with
    // no number on it is the one the next round adds three more to. The bound is
    // a guard rather than a discovery: it was set from the shelf as it stands,
    // and raising it is meant to be a decision somebody makes on purpose.
    expect(CHAT_PROMPTS.length).toBeLessThanOrEqual(12)
  })

  it('does not lean on the em dash in the prompt that removes it', () => {
    // The instruction that tells a model to stop using the em dash as a break
    // would be self-refuting if it used one itself. That much is checkable, and
    // it is the only part of the criterion a machine can hold: the other tics it
    // names are quoted as targets, so they are present on purpose and scanning
    // for them would only forbid the prompt from naming what it removes.
    const soundHuman = CHAT_PROMPTS.find((p) => p.id === 'soundHuman')
    expect(soundHuman).toBeDefined()
    if (!soundHuman) return
    for (const locale of ['en', 'zh'] as const) {
      const instruction = lookup(messages[locale], soundHuman.instructionKey)
      expect(typeof instruction, `${locale} instruction`).toBe('string')
      expect(instruction, `${locale} instruction`).not.toContain('—')
    }
  })
})
