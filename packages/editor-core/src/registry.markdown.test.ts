import { afterEach, describe, expect, it } from 'vitest'
import {
  getMarkdownCommand,
  registerMarkdownCommand,
  unregisterMarkdownCommand,
} from './registry'
import { MATH_COMMAND_ID } from './math/feature'
import { TABLE_COMMAND_ID } from './table/plugin'

describe('markdown command registry', () => {
  afterEach(() => {
    unregisterMarkdownCommand('test.md')
  })

  it('registers a producer and returns it', () => {
    registerMarkdownCommand('test.md', () => 'body')
    expect(getMarkdownCommand('test.md')?.()).toBe('body')
  })

  it('replaces an earlier producer for the same id', () => {
    registerMarkdownCommand('test.md', () => 'first')
    registerMarkdownCommand('test.md', () => 'second')
    expect(getMarkdownCommand('test.md')?.()).toBe('second')
  })

  it('unregisters', () => {
    registerMarkdownCommand('test.md', () => 'body')
    unregisterMarkdownCommand('test.md')
    expect(getMarkdownCommand('test.md')).toBeUndefined()
  })

  it('returns undefined for an unknown id', () => {
    expect(getMarkdownCommand('nope.not.registered')).toBeUndefined()
  })

  it('publishes a Markdown form for the node-inserting builtins', () => {
    // These commands only make sense against the rendered model, so source mode
    // needs a Markdown equivalent or the insert would be lost.
    for (const id of [MATH_COMMAND_ID, TABLE_COMMAND_ID]) {
      expect(getMarkdownCommand(id), id).toBeDefined()
    }
  })

  it('produces a display-math block with the caret inside the delimiters', () => {
    const produced = getMarkdownCommand(MATH_COMMAND_ID)!()
    expect(typeof produced).not.toBe('string')
    if (typeof produced === 'string') return
    expect(produced.text).toBe('$$\n\n$$')
    expect(produced.caret).toBe(3)
  })

  it('produces a default 3x3 GFM table', () => {
    const produced = getMarkdownCommand(TABLE_COMMAND_ID)!()
    const text = typeof produced === 'string' ? produced : produced.text
    expect(text).toContain('| a | b | c |')
    expect(text).toContain('| - | - | - |')
    // Header + separator + two body rows = a 3-row table.
    expect(text.trim().split('\n')).toHaveLength(4)
  })
})
