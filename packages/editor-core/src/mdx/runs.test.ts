import { describe, expect, it } from 'vitest'
import { findMdxRuns, openTagName } from './runs'

/**
 * What counts as an MDX run — the boundary the whole fix rests on.
 *
 * Too narrow and the corruption returns; too wide and ordinary HTML, autolinks
 * and prose stop being Markdown. Each case here is one side of that line.
 */

const runsOf = (text: string): string[] =>
  findMdxRuns(text).map((run) => text.slice(run.start, run.end))

describe('findMdxRuns', () => {
  it('marks JSX that micromark cannot read as HTML', () => {
    expect(runsOf('<Callout {...props} />')).toEqual(['<Callout {...props} />'])
    expect(runsOf('<Callout onClick={() => go()} />')).toEqual([
      '<Callout onClick={() => go()} />',
    ])
    expect(runsOf('x <my-widget a={1} /> y')).toEqual(['<my-widget a={1} />'])
  })

  it('marks expressions, comments and fragments', () => {
    expect(runsOf('{a * b}')).toEqual(['{a * b}'])
    expect(runsOf('{items[0]}')).toEqual(['{items[0]}'])
    expect(runsOf('{/* a comment */}')).toEqual(['{/* a comment */}'])
    expect(runsOf('{f({a: 1})}')).toEqual(['{f({a: 1})}'])
    // One run per token: the fragment, its expression, and the closing tag.
    expect(runsOf('<>{a}</>')).toEqual(['<>', '{a}', '</>'])
  })

  it('keeps the enclosing braces of an expression holding a comparison or a string', () => {
    expect(runsOf('{a < b}')).toEqual(['{a < b}'])
    expect(runsOf('{"}"}')).toEqual(['{"}"}'])
  })

  it('leaves ordinary Markdown and HTML alone', () => {
    // remark already parses these as html / link nodes; nothing here may change.
    expect(runsOf('<span style="color: red">')).toEqual([])
    expect(runsOf('<https://x.test/a>')).toEqual([])
    expect(runsOf('a < b and c > d')).toEqual([])
    expect(runsOf('plain {unbalanced text')).toEqual([])
    expect(runsOf('em *and* strong **text**')).toEqual([])
  })

  it('splits at a tag that is complete so the text around it keeps its escaping', () => {
    expect(runsOf('before <Callout /> after')).toEqual(['<Callout />'])
  })
})

describe('openTagName', () => {
  it('names the element a multi-line tag opens', () => {
    expect(openTagName('<Callout\n  title="x"\n  kind="info"')).toBe('Callout')
    expect(openTagName('<Callout')).toBe('Callout')
  })

  it('says nothing about a tag that closed, or was never a tag', () => {
    expect(openTagName('<Callout title="x">')).toBeNull()
    expect(openTagName('<Callout title="x" />')).toBeNull()
    expect(openTagName('text <Callout')).toBeNull()
    // A malformed tag is Markdown text, not an element waiting for its `>`.
    expect(openTagName('<Callout foo="unterminated>hi')).toBeNull()
  })
})
