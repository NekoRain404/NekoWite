import { describe, expect, it } from 'vitest'
import { createEditor } from './editor'
import { parseMarkdown } from './serialize'
import { mdxJsxMdast } from './mdx/remark'

/**
 * Editor open → save round trips across the constructs the byte-identity MDX
 * suite does not cover (setext headings, tilde fences, indented code, reference
 * links, autolinks, HTML blocks, aligned tables, footnotes, citations, hard
 * breaks, entities, CRLF, escapes, unicode).
 *
 * The editor runs through the ProseMirror schema, so a construct the schema
 * cannot represent is silently DROPPED on save. That is real data loss, so the
 * assertion is on structure: the saved text must re-parse to the same
 * position-independent mdast as the input.
 */

/** Recursively prune mdast `position`/`data` noise so two parses that differ
 * only in source offsets compare equal. */
function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize)
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(node as Record<string, unknown>)) {
      if (k === 'position' || k === 'data') continue
      const v = normalize((node as Record<string, unknown>)[k])
      if (v === undefined) continue
      out[k] = v
    }
    return Object.keys(out).length ? out : undefined
  }
  return node
}

function parseSemantic(md: string): unknown {
  const tree = parseMarkdown(md) as unknown as { children: unknown[] }
  mdxJsxMdast(tree as Parameters<typeof mdxJsxMdast>[0], { value: md })
  return normalize(tree)
}

async function withEditor<T>(run: (ed: ReturnType<typeof createEditor>) => Promise<T>): Promise<T> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const ed = createEditor(el)
  try {
    return await run(ed)
  } finally {
    ed.destroy()
    el.remove()
  }
}

const CASES: Array<[string, string]> = [
  ['setext h1', 'Title\n=====\n\nbody\n'],
  ['setext h2', 'Title\n-----\n\nbody\n'],
  ['atx closing hashes', '## Heading ##\n'],
  ['escaped emphasis', '\\*not em\\* and \\_not em\\_\n'],
  ['intraword underscores', 'foo_bar_baz and snake_case_name\n'],
  ['hard break spaces', 'line one  \nline two\n'],
  ['hard break backslash', 'line one\\\nline two\n'],
  ['star bullets', '* a\n* b\n'],
  ['plus bullets', '+ a\n+ b\n'],
  ['ordered paren', '1) a\n2) b\n'],
  ['ordered offset', '3. a\n4. b\n'],
  ['loose list', '- a\n\n- b\n'],
  ['nested list', '- a\n  - b\n    - c\n'],
  ['nested ordered in bullet', '- a\n  1. one\n  2. two\n'],
  ['item two paragraphs', '- first\n\n  second\n'],
  ['item with code block', '- item\n\n  ```js\n  const a = 1\n  ```\n'],
  ['task list nested', '- [x] a\n  - [ ] b\n'],
  ['nested blockquote', '> outer\n>\n> > inner\n'],
  ['blockquote with list', '> - a\n> - b\n'],
  ['thematic break stars', 'a\n\n***\n\nb\n'],
  ['fenced tilde', '~~~js\nconst a = 1\n~~~\n'],
  ['fence inside fence', '````\n```\n````\n'],
  ['indented code', '    indented code\n'],
  ['aligned table', '| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n'],
  ['table escaped pipe', '| a | b |\n| - | - |\n| x \\| y | 2 |\n'],
  ['link with title', '[text](https://x.test "Title")\n'],
  ['link angle url', '[text](<https://x.test/a b>)\n'],
  ['autolink', '<https://x.test/a>\n'],
  ['image with title', '![alt](https://x.test/a.png "T")\n'],
  ['wikilink', 'see [[Other Note]] here\n'],
  ['wikilink alias', 'see [[Other Note|alias]] here\n'],
  ['highlight', 'a ==marked== b\n'],
  ['inline code with backtick', 'a ``code with ` tick`` b\n'],
  ['entity', 'AT&amp;T and &copy; 2026\n'],
  ['inline html span', 'a <span style="color: red">x</span> b\n'],
  ['html block', '<div class="x">\nfoo\n</div>\n'],
  ['footnote', 'Note[^1]\n\n[^1]: The definition\n'],
  ['citation', 'claim [@smith2020]\n'],
  ['mdx self-closing', '<Callout type="info" />\n'],
  ['mdx unquoted prop', '<Callout type=info />\n'],
  ['mdx prop with gt', '<Callout hint="a > b" />\n'],
  ['cjk', '这是一段中文文本，包含标点。\n'],
  ['emoji', 'a 🐱 b 🎉\n'],
  ['combining marks', 'e\u0301 cafe\u0301\n'],
  ['lone dollar', 'Cost is $5 and $19.99\n'],
  ['windows path in code', '```\nC:\\Users\\a\\b.txt\n```\n'],
  ['many blank lines', 'a\n\n\n\n\nb\n'],
  ['crlf', 'a\r\n\r\nb\r\n'],
  // Adversarial placement: constructs whose schema fit is not obvious, where a
  // mismatch makes milkdown abort the parse and the document load truncated.
  ['image in a heading', '# Head ![alt](https://x.test/a.png)\n'],
  ['image only in a heading', '# ![alt](https://x.test/a.png)\n'],
  ['empty heading', '#\n'],
  ['image inside a link', '[![alt](https://x.test/a.png)](https://y.test)\n'],
  ['link with image and text', '[t ![alt](https://x.test/a.png) m](https://y.test)\n'],
  ['math in a table cell', '| a |\n| - |\n| $x^2$ |\n'],
  ['inline code in a table cell', '| a |\n| - |\n| `c` |\n'],
  ['wikilink in a heading', '# Title [[N]]\n'],
  ['wikilink in a table cell', '| a |\n| - |\n| [[N]] |\n'],
  ['citation in a heading', '# Claim [@k]\n'],
  ['citation in a table cell', '| a |\n| - |\n| [@k] |\n'],
  ['footnote reference in a table cell', '| a |\n| - |\n| note[^1] |\n\n[^1]: def\n'],
  ['footnote with two paragraphs', 'note[^1]\n\n[^1]: first\n\n    second\n'],
  ['footnote with a code block', 'note[^1]\n\n[^1]: text\n\n    ```js\n    const a = 1\n    ```\n'],
  ['footnote with math', 'n[^1]\n\n[^1]: $$x$$\n'],
  ['html block wrapping markdown', '<div class="x">\n\n# Inside\n\ntext\n\n</div>\n'],
  ['html comment', '<!-- a comment -->\n\ntext\n'],
  ['deep list nesting', '- a\n  - b\n    - c\n      - d\n        - e\n'],
  ['task item with two paragraphs', '- [x] a\n\n  second\n'],
  ['unclosed jsx', '<Callout type="info">\n\ntext\n'],
  ['definition list', 'Term\n: Definition\n'],
  ['jsx in a blockquote', '> <Callout />\n'],
  ['jsx in a list item', '- <Callout />\n'],
  ['jsx in a heading', '# Head <Callout />\n'],
  ['nested emphasis', '**a *b* c**\n'],
  ['list item starting with code', '- `code` start\n'],
  ['table cell starting with a pipe escape', '| a |\n| - |\n| \\| x |\n'],
]

describe('editor open/save preserves structure for the wider markdown corpus', () => {
  for (const [name, input] of CASES) {
    it(name, async () => {
      await withEditor(async (ed) => {
        await ed.open(input)
        const saved = await ed.save()
        // No construct may be dropped: the saved text re-parses to the same
        // position-independent structure as the source.
        expect(parseSemantic(saved), `saved was: ${JSON.stringify(saved)}`).toEqual(
          parseSemantic(input),
        )
      })
    })
  }
})

describe('editor open/save is idempotent for the wider markdown corpus', () => {
  for (const [name, input] of CASES) {
    it(name, async () => {
      await withEditor(async (ed) => {
        await ed.open(input)
        const once = await ed.save()
        await ed.open(once)
        const twice = await ed.save()
        expect(twice).toBe(once)
      })
    })
  }
})

/**
 * Intentional canonicalizations the structure comparison above would otherwise
 * flag. Each one keeps the rendered meaning; the assertions pin the exact form
 * so a change here is noticed rather than absorbed.
 */
describe('editor open/save canonicalizations (content preserved, form changed)', () => {
  it('inlines reference links and consumes their definitions', async () => {
    // Milkdown's commonmark preset parses through `remark-inline-links`, so a
    // reference link becomes an inline link on open and the definition block is
    // gone. The href/title survive; only the source form changes.
    const cases: Array<[string, string, string]> = [
      ['full', '[text][ref]\n\n[ref]: https://x.test "T"\n', '[text](https://x.test "T")\n'],
      ['collapsed', '[ref][]\n\n[ref]: https://x.test\n', '[ref](https://x.test)\n'],
      ['shortcut', '[ref]\n\n[ref]: https://x.test\n', '[ref](https://x.test)\n'],
    ]
    for (const [label, input, expected] of cases) {
      await withEditor(async (ed) => {
        await ed.open(input)
        expect(await ed.save(), label).toBe(expected)
      })
    }
  })

  it('writes a `<br />` marker for an empty table cell and round-trips it', async () => {
    // An empty paragraph is serialized by milkdown's paragraph serializer as a
    // standalone `<br />` so an intentional blank line survives a reopen;
    // `visitEmptyLine` removes it again while parsing. The marker is stable
    // (the idempotence cases above re-save the same bytes) and the export strips
    // it again so it never shows up as literal text — see
    // `export/renderNodes.test.ts`.
    await withEditor(async (ed) => {
      await ed.open('| a | b |\n| - | - |\n|  |  |\n')
      const saved = await ed.save()
      expect(saved).toContain('<br />')
      await ed.open(saved)
      expect(await ed.save()).toBe(saved)
    })
  })
})
