import { describe, expect, it } from 'vitest'
import { createEditor } from '../editor'

/**
 * A parse that cannot place a node must never silently take the document with it.
 *
 * `mdxComponent` is a BLOCK atom. When `mdxJsxMdast` converts JSX that sits in a
 * phrasing container (a heading, a link, emphasis, …) the heading's parse asks
 * ProseMirror to build a
 * heading whose content is inline except for one block node — which throws
 * `createNodeInParserFail`. Milkdown swallows the throw, `open()` resolves, and
 * the editor keeps whatever partial document had been built; the next save then
 * writes that truncated document over the user's file.
 *
 * This corpus puts JSX in every container that can hold inline content and
 * asserts that every marker word survives an open → save trip. It is a
 * data-loss net rather than a rendering assertion: it does not care whether the
 * component became a block or stayed raw source, only that nothing vanished.
 */
const DOCS: Array<[string, string, string[]]> = [
  ['component at root', '<Callout type="info" />\n\nbravo\n', ['Callout', 'info', 'bravo']],
  ['component alone in a paragraph', 'alpha <Callout /> bravo\n', ['alpha', 'bravo', 'Callout']],
  ['component in a heading', '# alpha <Callout />\n\nbravo\n', ['alpha', 'bravo', 'Callout']],
  ['component alone in a heading', '# <Callout />\n\nbravo\n', ['bravo', 'Callout']],
  ['component in an emphasis', 'alpha *em <Callout />* bravo\n', ['alpha', 'em', 'bravo', 'Callout']],
  ['component in strong', 'alpha **st <Callout />** bravo\n', ['alpha', 'st', 'bravo', 'Callout']],
  ['component in strikethrough', 'alpha ~~dl <Callout />~~ bravo\n', ['alpha', 'dl', 'bravo', 'Callout']],
  ['component in a link', 'alpha [lk <Callout />](https://x.test) bravo\n', ['alpha', 'lk', 'bravo', 'Callout']],
  ['component in a highlight', 'alpha ==hl <Callout />== bravo\n', ['alpha', 'hl', 'bravo', 'Callout']],
  ['component in a list item', '- item <Callout /> tail\n', ['item', 'tail', 'Callout']],
  ['component in a blockquote', '> quote <Callout /> tail\n', ['quote', 'tail', 'Callout']],
  ['component in a nested blockquote', '> outer\n>\n> > inner <Callout />\n', ['outer', 'inner', 'Callout']],
  ['component in a table cell', '| a |\n| - |\n| <Callout /> |\n', ['Callout']],
  ['component spanning a table cell', '| a |\n| - |\n| <Comp a={1}>y</Comp> |\n', ['Comp', 'y']],
  ['component in a footnote definition', 'note[^1]\n\n[^1]: def <Callout />\n', ['note', 'def', 'Callout']],
  ['component spanning a paragraph', '<Callout>\n\nbody\n\n</Callout>\n', ['Callout', 'body']],
  ['nested components in a paragraph', 'x <Outer><Inner /></Outer> y\n', ['x', 'y', 'Outer', 'Inner']],
  ['component in an ordered list item', '1. one <Callout />\n2. two\n', ['one', 'two', 'Callout']],
  ['component in a heading after a list', '- a\n\n# head <Callout />\n\n- b\n', ['a', 'head', 'b', 'Callout']],
]

describe('JSX in inline containers never truncates the document', () => {
  it('reports every document that lost content at once', async () => {
    const lost: Array<{ label: string; saved: string; missing: string[] }> = []
    for (const [label, md, tokens] of DOCS) {
      const el = document.createElement('div')
      document.body.appendChild(el)
      const ed = createEditor(el)
      try {
        await ed.open(md)
        const saved = await ed.save()
        const missing = tokens.filter((token) => !saved.includes(token))
        if (missing.length) lost.push({ label, saved, missing })
      } finally {
        ed.destroy()
        el.remove()
      }
    }
    expect(lost).toEqual([])
  })
})

/**
 * The phrasing cases are not merely lossless but byte-faithful: the JSX stays a
 * raw `html` node, which serializes its source verbatim. Four of these used to
 * save as an EMPTY file (`*em <Callout />*`, `**st <Callout />**`,
 * `~~dl <Callout />~~`, `[lk <Callout />](url)`), because the block atom made
 * ProseMirror reject the enclosing emphasis/strong/delete/link.
 */
const BYTE_IDENTICAL = [
  '# alpha <Callout />\n\nbravo\n',
  '# <Callout />\n\nbravo\n',
  'alpha <Callout /> bravo\n',
  'alpha *em <Callout />* bravo\n',
  'alpha **st <Callout />** bravo\n',
  'alpha ~~dl <Callout />~~ bravo\n',
  'alpha [lk <Callout />](https://x.test) bravo\n',
  'alpha ==hl <Callout />== bravo\n',
  '- item <Callout /> tail\n',
  '> quote <Callout /> tail\n',
  '> outer\n>\n> > inner <Callout />\n',
  'note[^1]\n\n[^1]: def <Callout />\n',
  '<Callout type="info" />\n\nbravo\n',
  'x <Outer><Inner /></Outer> y\n',
  '1. one <Callout />\n2. two\n',
  '- a\n\n# head <Callout />\n\n- b\n',
]

describe('JSX in inline containers round-trips byte for byte', () => {
  it('reports every document that changed at once', async () => {
    const changed: Array<{ input: string; saved: string }> = []
    for (const md of BYTE_IDENTICAL) {
      const el = document.createElement('div')
      document.body.appendChild(el)
      const ed = createEditor(el)
      try {
        await ed.open(md)
        const saved = await ed.save()
        if (saved !== md) changed.push({ input: md, saved })
      } finally {
        ed.destroy()
        el.remove()
      }
    }
    expect(changed).toEqual([])
  })
})
