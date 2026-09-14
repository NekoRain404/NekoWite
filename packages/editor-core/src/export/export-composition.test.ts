import { describe, expect, it } from 'vitest'
import { renderDocument } from './index'

/**
 * Content has to survive being NESTED, not just being present.
 *
 * The export renderer walks the tree itself, so a node it knows at the top
 * level can still be dropped one level down (a table cell, a footnote, a list
 * item, a blockquote). Every case below puts a distinctive token inside another
 * construct and asserts the token reached the output; the earlier export
 * defects (display math, task lists, footnotes, highlights, wikilinks) were all
 * found this way, one level in.
 */
const CASES: Array<[string, string, string[]]> = [
  ['link in a table cell', '| a |\n| - |\n| [text](https://x.test) |\n', ['text', 'href="https://x.test"']],
  ['emphasis in a table cell', '| a |\n| - |\n| **bold** |\n', ['<strong>bold</strong>']],
  ['inline code in a table cell', '| a |\n| - |\n| `code` |\n', ['<code>code</code>']],
  ['inline math in a table cell', '| a |\n| - |\n| $x^2$ |\n', ['math-latex', 'x^2']],
  ['highlight in a table cell', '| a |\n| - |\n| ==hi== |\n', ['<mark', 'hi']],
  // A piped wikilink needs the pipe escaped to stay in one cell; the save side
  // preserves that escape so this is also what a round trip produces.
  ['wikilink in a table cell', '| a |\n| - |\n| [[N\\|alias]] |\n', ['alias', 'data-target="N"']],
  ['task list state in a table cell', '| a |\n| - |\n| - [x] done |\n', ['done']],
  ['image in a table cell', '| a |\n| - |\n| ![alt](https://x.test/a.png) |\n', ['alt', 'https://x.test/a.png']],
  ['citation in a table cell', '| a |\n| - |\n| [@k] |\n', ['class="cite"']],
  ['footnote reference in a table cell', '| a |\n| - |\n| n[^1] |\n\n[^1]: def\n', ['footnote-ref', 'def']],
  ['component in a table cell', '| a |\n| - |\n| <Comp a={1}>y</Comp> |\n', ['Comp']],
  ['list in a blockquote', '> - one\n> - two\n', ['<ul>', 'one', 'two']],
  ['table in a blockquote', '> | a |\n> | - |\n> | 1 |\n', ['<table>', '1']],
  ['task list in a blockquote', '> - [x] done\n', ['checkbox', 'done']],
  ['code fence in a blockquote', '> ```js\n> const bq = 1\n> ```\n', ['bq']],
  ['heading in a blockquote', '> ## Head\n', ['<h2', 'Head']],
  ['blockquote in a list item', '- item\n\n  > quoted\n', ['item', 'quoted']],
  ['code fence in a list item', '- item\n\n  ```js\n  const deep = 1\n  ```\n', ['item', 'deep']],
  ['table in a list item', '- item\n\n  | a |\n  | - |\n  | 1 |\n', ['item', '<table>']],
  ['nested list tokens', '- l1\n  - l2\n    - l3\n      - l4\n', ['l1', 'l2', 'l3', 'l4']],
  ['list in a footnote definition', 'n[^1]\n\n[^1]: first\n\n    - one\n    - two\n', ['first', 'one', 'two']],
  ['code fence in a footnote definition', 'n[^1]\n\n[^1]: text\n\n    ```js\n    const fn = 1\n    ```\n', ['text', 'fn']],
  ['inline math in a footnote definition', 'n[^1]\n\n[^1]: $a^2$\n', ['math-latex', 'a^2']],
  ['link in a footnote definition', 'n[^1]\n\n[^1]: [text](https://x.test)\n', ['text', 'href="https://x.test"']],
  ['math in a blockquote', '> $y^2$\n', ['math-latex', 'y^2']],
  ['display math in a list item', '- item\n\n  $$\n  Z = 1\n  $$\n', ['Z = 1']],
  ['emphasis in a heading', '# A *b* c\n', ['<em>b</em>']],
  ['link in a heading', '# A [b](https://x.test) c\n', ['A', 'b', 'c']],
  ['inline code in a heading', '# A `b` c\n', ['<code>b</code>']],
  ['math in a heading', '# A $z^2$ B\n', ['math-latex', 'z^2']],
  ['hard break in a blockquote', '> line one\\\n> line two\n', ['line one', 'line two']],
  ['link in a nested list', '- a\n  - [b](https://x.test)\n', ['b', 'href="https://x.test"']],
  ['wikilink in a blockquote', '> see [[N|ali]] here\n', ['ali', 'data-target="N"']],
  ['highlight in a nested list', '- a\n  - ==mark==\n', ['<mark', 'mark']],
  ['footnote inside a list item', '- item[^1]\n\n[^1]: def\n', ['item', 'footnote-ref', 'def']],
  ['two levels of blockquote', '> outer\n>\n> > inner $x$\n', ['outer', 'inner', 'math-latex']],
]

describe('export preserves nested content', () => {
  it('reports every dropped fragment at once', () => {
    const missing: Array<{ name: string; fragment: string; body: string }> = []
    for (const [name, md, fragments] of CASES) {
      const html = renderDocument(md, { math: 'text' })
      const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'))
      for (const fragment of fragments) {
        if (!body.includes(fragment)) missing.push({ name, fragment, body })
      }
    }
    expect(missing).toEqual([])
  })
})

describe('hard breaks and column alignment survive export', () => {
  it('keeps a shift+Enter line break instead of gluing the two lines together', async () => {
    // mdast models the break as a childless `break` node. With no case for it the
    // renderer emitted nothing at all, so the exported document read as one
    // concatenated line — text the author never wrote, in a file handed to
    // someone else.
    const html = await renderDocument('line one\\\nline two\n')
    expect(html).toContain('<br />')
    expect(html).not.toContain('line oneline two')
  })

  it('keeps a two-space hard break too', async () => {
    const html = await renderDocument('line one  \nline two\n')
    expect(html).toContain('<br />')
  })

  it('writes the alignment GFM records on the table', async () => {
    const html = await renderDocument('| left | center | right |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n')
    expect(html).toContain('text-align: left')
    expect(html).toContain('text-align: center')
    expect(html).toContain('text-align: right')
  })

  it('leaves a table without alignment markers untouched', async () => {
    const html = await renderDocument('| a | b |\n| - | - |\n| 1 | 2 |\n')
    expect(html).not.toContain('text-align')
  })
})
