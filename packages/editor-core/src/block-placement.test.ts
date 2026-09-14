import { describe, expect, it } from 'vitest'
import { createEditor } from './editor'

/**
 * Block constructs in every container that might hold them.
 *
 * A schema mismatch makes milkdown abort the parse and the document load
 * truncated — silently, because the throw is swallowed — so the next save writes
 * the truncated text over the file. That is how `**[x <Callout />](url)` came to
 * empty a file. This corpus is a token-loss net for the non-JSX block nodes:
 * display math, tables, code fences, headings and lists placed inside list
 * items, blockquotes, footnote definitions and table cells.
 */
const DOCS: Array<[string, string, string[]]> = [
  ['display math in a list item', '- item\n\n  $$\n  LISTMATH\n  $$\n', ['item', 'LISTMATH']],
  ['display math in a blockquote', '> $$\n> BQMATH\n> $$\n', ['BQMATH']],
  ['display math in a footnote', 'n[^1]\n\n[^1]: $$\n    FNMATH\n    $$\n', ['n', 'FNMATH']],
  ['display math between paragraphs', 'a\n\n$$\nTOPMATH\n$$\n\nb\n', ['a', 'TOPMATH', 'b']],
  ['table in a blockquote', '> | h |\n> | - |\n> | TBLQ |\n', ['TBLQ']],
  ['table in a list item', '- item\n\n  | h |\n  | - |\n  | TBLI |\n', ['item', 'TBLI']],
  ['table in a footnote', 'n[^1]\n\n[^1]: | h |\n    | - |\n    | TBFN |\n', ['n', 'TBFN']],
  ['code fence in a list item', '- item\n\n  ```\n  CFCODE\n  ```\n', ['item', 'CFCODE']],
  ['code fence in a footnote', 'n[^1]\n\n[^1]: text\n\n    ```\n    FNCODE\n    ```\n', ['text', 'FNCODE']],
  ['heading in a footnote', 'n[^1]\n\n[^1]: ### FNH\n', ['FNH']],
  ['list in a footnote', 'n[^1]\n\n[^1]: first\n\n    - FNL1\n    - FNL2\n', ['first', 'FNL1', 'FNL2']],
  ['component in a footnote', 'n[^1]\n\n[^1]: <Callout />\n', ['Callout']],
  ['component in a list item', '- <Callout />\n', ['Callout']],
  ['component in a blockquote', '> <Callout />\n', ['Callout']],
  ['task list in a footnote', 'n[^1]\n\n[^1]: - [x] FNTASK\n', ['FNTASK']],
  ['blockquote in a footnote', 'n[^1]\n\n[^1]: > FNBQ\n', ['FNBQ']],
  ['thematic break in a footnote', 'n[^1]\n\n[^1]: ---\n', ['n']],
  ['image in a footnote', 'n[^1]\n\n[^1]: ![FNALT](https://x.test/a.png)\n', ['FNALT']],
  ['display math in a footnote and list', '- i\n\n  $$\n  M1\n  $$\n\nn[^1]\n\n[^1]: - a\n    - b\n\n    $$\n    M2\n    $$\n', ['i', 'M1', 'a', 'b', 'M2']],
  ['nested names in one document', '# H1\n\n$$\nM3\n$$\n\n- l\n\n  | c |\n  | - |\n  | v |\n', ['H1', 'M3', 'v']],
]

describe('block placement never truncates the document', () => {
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
