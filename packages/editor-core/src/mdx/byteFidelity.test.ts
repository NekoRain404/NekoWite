import { describe, expect, it } from 'vitest'
import { createEditor } from '../editor'

/**
 * Byte-level MDX fidelity: JSX and expressions the Markdown parser does not
 * recognise must come back exactly as the author wrote them.
 *
 * `roundtrip.test.ts` compares position-pruned mdast, and that equality is
 * Markdown-semantic: parsing a document un-escapes a backslash, so the corrupted
 * `\<Callout {...props} />` compares EQUAL to the source it was written from (and
 * `{a \* b}` to `{a * b}`). The whole failure mode is invisible at the tree level
 * and obvious at the byte level, so every case here asserts the exact bytes for a
 * document that is opened and saved with NO edit in between.
 *
 * The constructs are the ones no other corpus holds: a spread attribute, a prop
 * expression, a JSX comment, a fragment, and an expression containing Markdown's
 * own punctuation (`*`, `**`, `_`, `[`). They matter because the save path
 * re-parses its own output (`editor.ts` `save()`), so a document that is merely
 * *opened* today comes back with its JSX escaped into literal text and its
 * expressions rewritten into invalid JavaScript.
 *
 * Sources: `.superpowers/sdd/roadmap/mdx-audit.md` D1, D3, D4, D6.
 */

/** Documents whose bytes must not change across open → save. */
const BYTE_IDENTICAL: Array<[string, string]> = [
  // D1 — a spread attribute (or any prop expression micromark cannot read as an
  // attribute) made the whole tag plain text, and text starting with `<` is
  // backslash-escaped on save: `<Callout {...props} />` -> `\<Callout {...props} />`.
  ['spread attribute', '<Callout {...props} />\n'],
  ['spread attribute with children', '<Callout {...props}>\n\nbody\n\n</Callout>\n'],
  ['arrow-function prop', '<Callout onClick={() => go()} />\n'],
  ['spread attribute inline in prose', 'x <Callout {...props} /> y\n'],
  ['spread attribute in a blockquote', '> <Callout {...props} />\n'],
  ['spread attribute in a list item', '- <Callout {...props} />\n'],
  ['spread attribute in a heading', '# Head <Callout {...props} />\n'],
  ['prop expression in a heading', '# Head {a * b}\n'],

  // D3 — an expression containing Markdown punctuation came back as invalid
  // JavaScript: `{a * b}` -> `{a \* b}`.
  ['expression with multiplication', '{a * b}\n'],
  ['expression with exponentiation', '{2 ** 8}\n'],
  ['expression with a member access', '{items[0]}\n'],
  ['expression with an underscore', '{a_b}\n'],
  ['expression with a strikethrough-looking tilde', '{a ~ b}\n'],
  ['expression inline in prose', 'Value {a * b} here.\n'],

  // D4 — a fragment lost its closing angle bracket: `<>{a}</>` -> `<>{a}\</>`.
  ['jsx fragment', '<>{a}</>\n'],

  // D6 — a JSX comment was rewritten inside a component body, which the save
  // path re-parses even though the whole element is carried as raw source.
  ['jsx comment on its own line', '{/* a comment */}\n'],
  ['jsx comment inside a component body', '<Callout>\n\n{/* why */}\n\ntext\n\n</Callout>\n'],
  ['expression inside a component body', '<Callout>\n\n{a * b}\n\n</Callout>\n'],
  ['spread component inside a component body', '<Callout>\n\n<Inner {...props} />\n\n</Callout>\n'],

  // D2 — a multi-line tag was destroyed AND the file restructured: micromark
  // hands the tag back as text and reads the `>` line as a blockquote, so the
  // component was escaped into literal text, the indentation was lost and a
  // `<br />` empty-paragraph marker was injected into the document.
  [
    'multi-line open tag with the angle bracket on its own line',
    '<Callout\n  title="x"\n  kind="info"\n>\nbody\n</Callout>\n',
  ],
  ['multi-line open tag', '<Callout\n  title="x">\nbody\n</Callout>\n'],
  ['multi-line self-closing tag', '<Callout\n  title="x"\n/>\n'],
]

describe('unrecognised MDX source round-trips byte for byte', () => {
  for (const [label, input] of BYTE_IDENTICAL) {
    it(label, async () => {
      const el = document.createElement('div')
      document.body.appendChild(el)
      const ed = createEditor(el)
      try {
        await ed.open(input)
        // Nothing was edited, so nothing may move.
        expect(await ed.save()).toBe(input)
      } finally {
        ed.destroy()
        el.remove()
      }
    })
  }
})

describe('unrecognised MDX source survives a table cell', () => {
  // A cell's widths are re-padded by remark-stringify, so the assertion is on the
  // JSX itself: it must come back as source, not escaped into literal text.
  it('keeps a spread attribute in a cell as source', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const ed = createEditor(el)
    try {
      await ed.open('| a |\n| - |\n| <Row {...props} /> |\n')
      const saved = await ed.save()
      expect(saved).toContain('<Row {...props} />')
      expect(saved).not.toContain('\\<')
    } finally {
      ed.destroy()
      el.remove()
    }
  })
})

describe('MDX put into the model without the parser', () => {
  // Typing, pasting and the AI insert write text into the document directly, so
  // the parse-time rules never see it. The escaping is Markdown's either way, and
  // it is applied on the way out — the text handler is what has to leave it alone.
  it('saves an expression transcribed at the caret as it was typed', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const ed = createEditor(el)
    try {
      await ed.open('Total: \n')
      const view = ed.getView()
      view.dispatch(view.state.tr.insertText('{a * b}', view.state.doc.content.size - 1))
      const saved = await ed.save()
      expect(saved).toContain('{a * b}')
      expect(saved).not.toContain('\\*')
    } finally {
      ed.destroy()
      el.remove()
    }
  })
})
