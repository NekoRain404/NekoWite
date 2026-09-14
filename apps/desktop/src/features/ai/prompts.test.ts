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
})
