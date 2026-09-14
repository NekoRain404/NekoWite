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
 * The two corpora at the end are about the file's own BYTES rather than its
 * constructs: the envelope around the Markdown (a BOM, the line endings) and the
 * form a save writes (whitespace, a setext underline, an indented code block).
 * Neither is MDX, and both belong here because this is the only corpus that
 * compares saved output byte for byte.
 *
 * Sources: `.superpowers/sdd/roadmap/mdx-audit.md` D1, D3, D4, D6;
 * task-37 m1 and M1, M3 for the byte corpora.
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

/**
 * The same constructs, nested in a container.
 *
 * A node inside a blockquote or a list item is offset by that container: its
 * position spans the `> ` / indentation that prefixes every continuation line,
 * and the stringifier adds that prefix back when the node is written out. An
 * element written across lines inside a container therefore came back
 * double-prefixed (`> > >`) and escaped, because the source slice kept the
 * prefix the writer was about to add again.
 *
 * Both document kinds are exercised: reading the source off the offsets is the
 * same job in both, and a `.md` file must not lose what a `.mdx` file keeps.
 */
const NESTED: Array<[string, string]> = [
  ['component spanning a blockquote', '> <Callout>\n>\n> body\n>\n> </Callout>\n'],
  ['multi-line open tag in a blockquote', '> <Callout\n>   title="x"\n> >\n> body\n> </Callout>\n'],
  ['multi-line self-closing tag in a blockquote', '> <Callout\n>   title="x"\n> />\n'],
]

/**
 * Nested elements only the MDX parser reads as one node.
 *
 * CommonMark distributes them across parents: inside a list item the line
 * holding the tag's `>` is a blockquote of its own, and a close tag that
 * follows another element shares a paragraph with it (`<Inner />\n</Outer>`),
 * so the element's open tag, body and close tag are three unrelated blocks and
 * no sibling-level merge can put them back together. Opening them as Markdown
 * rewrites them (pre-existing behaviour, unchanged here); the MDX parser reads
 * the same bytes into one `mdxJsxFlowElement` and the bytes survive.
 */
const NESTED_MDX_ONLY: Array<[string, string]> = [
  ['multi-line open tag in a list item', '- <Callout\n  title="x"\n  >\n  body\n  </Callout>\n'],
  ['nested multi-line tag in a blockquote', '> <Outer\n>   a="1"\n> >\n> <Inner />\n> </Outer>\n'],
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

describe('MDX nested in a container round-trips byte for byte', () => {
  for (const path of [undefined, '/vault/nested.mdx']) {
    for (const [label, input] of NESTED) {
      it(`${label} (${path ? '.mdx' : '.md'})`, async () => {
        const el = document.createElement('div')
        document.body.appendChild(el)
        const ed = createEditor(el)
        try {
          await ed.open(input, path)
          expect(await ed.save()).toBe(input)
        } finally {
          ed.destroy()
          el.remove()
        }
      })
    }
  }

  for (const [label, input] of NESTED_MDX_ONLY) {
    it(`${label} (.mdx)`, async () => {
      const el = document.createElement('div')
      document.body.appendChild(el)
      const ed = createEditor(el)
      try {
        await ed.open(input, '/vault/nested.mdx')
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

/**
 * The envelope around the Markdown: a UTF-8 BOM, and the file's line endings.
 *
 * Neither is part of the document the model holds, and neither was ever looked
 * at: the frontmatter was carried through raw while the body was serialized, so
 * a CRLF file came back with a CRLF frontmatter and an LF body — consistent in,
 * inconsistent out — and a BOM was dropped on the floor (task-37 M1, M3). The
 * corpus above is entirely `\n`-terminated, which is why both survived it.
 *
 * The rule these cases pin: the file's own ending is read once, when it is
 * opened, and the whole document is written in it. A MIXED file has no single
 * ending to keep, so its majority decides (see `document-envelope.ts`); the
 * expected value below says which way each mixed case goes.
 */
const ENVELOPE: Array<[string, string, string?]> = [
  ['LF body', 'one\ntwo\n'],
  ['CRLF body', 'one\r\ntwo\r\n'],
  ['CRLF with a blank line', 'para one\r\n\r\npara two\r\n'],
  ['CRLF frontmatter and CRLF body', '---\r\ntitle: x\r\n---\r\n\r\nbody line\r\n'],
  ['CRLF list', '- one\r\n- two\r\n'],
  ['CRLF blockquote', '> one\r\n> two\r\n'],
  ['CRLF table', '| a | b |\r\n| - | - |\r\n| 1 | 2 |\r\n'],

  ['BOM', '﻿# Title\n\nbody\n'],
  ['BOM with frontmatter', '﻿---\ntitle: x\n---\n\nbody\n'],
  ['BOM and CRLF', '﻿# Title\r\n\r\nbody\r\n'],
  ['BOM, CRLF and frontmatter', '﻿---\r\ntitle: x\r\n---\r\n\r\nbody\r\n'],

  // Mixed: the majority ending is applied to the whole document, so the file
  // comes back consistent instead of half-and-half.
  ['mixed, CRLF majority', 'one\r\ntwo\r\nthree\n', 'one\r\ntwo\r\nthree\r\n'],
  [
    'mixed, LF majority',
    '---\r\ntitle: x\r\n---\r\n\r\nb1\nb2\nb3\nb4\nb5\n',
    '---\ntitle: x\n---\n\nb1\nb2\nb3\nb4\nb5\n',
  ],
  ['mixed, a tie goes to LF', 'one\r\ntwo\n', 'one\ntwo\n'],

  // A line ending the model carries as CONTENT — the value of a code block — is
  // not normalised away, in either direction.
  ['CRLF inside a code block', '```\ncode one\r\ncode two\n```\n'],
  ['CRLF inside a code block of a CRLF file', '```\r\ncode one\r\n```\r\n'],

  // Classic-Mac endings are the one shape that is deliberately NOT preserved:
  // nothing in this pipeline treats a lone CR as a line ending, so the file is
  // read as one line and written back as LF.
  ['CR-only', 'one\rtwo\r', 'one\ntwo\n'],
]

describe('the document’s own bytes round-trip byte for byte', () => {
  for (const [label, input, expected = input] of ENVELOPE) {
    it(label, async () => {
      const el = document.createElement('div')
      document.body.appendChild(el)
      const ed = createEditor(el)
      try {
        await ed.open(input)
        // Nothing was edited, so nothing may move.
        expect(await ed.save()).toBe(expected)
      } finally {
        ed.destroy()
        el.remove()
      }
    })
  }

  it('holds for a .mdx document too', async () => {
    const input = '﻿---\r\ntitle: x\r\n---\r\n\r\n<Callout {...props} />\r\n'
    const el = document.createElement('div')
    document.body.appendChild(el)
    const ed = createEditor(el)
    try {
      await ed.open(input, '/vault/note.mdx')
      expect(await ed.save()).toBe(input)
    } finally {
      ed.destroy()
      el.remove()
    }
  })
})

async function saved(input: string): Promise<string> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const ed = createEditor(el)
  try {
    await ed.open(input)
    return await ed.save()
  } finally {
    ed.destroy()
    el.remove()
  }
}

/**
 * The FORM a save writes, shape by shape.
 *
 * task-37 m1 measured ten of these as byte changes nobody asked for — the
 * CRLF/BOM work added seventeen cases and none of these — and one of the ten was
 * a defect by any reading: a file whose whole content is a single newline came
 * back as 0 bytes. The rest keep the parsed document identical (checked: the
 * position-pruned mdast is equal on both sides of every respelling below), so
 * the honest question for each row is not "does it render the same" but "what
 * does a tool reading the RAW vault see", and that is what the reason beside it
 * answers. The decision itself lives with the code that makes it: the canonical
 * form in `serialize.ts` (at the stringify options), the body with no content in
 * `document-envelope.ts` (`bodyToWrite`).
 */
const CANONICALISED: Array<[string, string, string]> = [
  // `one` -> `one\n`. POSIX text files end with a newline, and a file without
  // one is what `git diff` calls out. A Markdown reader loses nothing; a
  // line-oriented diff sees one line change. Preserving it would need the
  // envelope to remember "this file ended without a newline" and to strip the
  // serializer's own final byte — two stored states for the same document, for
  // a byte the user never asked about.
  ['missing final newline', 'one\ntwo', 'one\ntwo\n'],

  // `one\n\n\n` -> `one\n`. Blank lines at the end of a document parse to no
  // nodes at all, so this is the row above one direction over. A reader that
  // counts lines sees two go; nothing else can tell.
  ['trailing blank lines', 'one\n\n\n', 'one\n'],

  // `\n` -> `\n` — it was `''`. THE DEFECT of the ten: the file's entire content
  // is one newline, the model holds no node for a blank line, and the save wrote
  // a 0-byte file. `bodyToWrite` writes the file's own whitespace back when the
  // serializer says the body is empty and the body was only whitespace, which is
  // the one case where the whitespace is not form around the document but the
  // document. The two rows after it are the same shape at other sizes.
  ['a file that is one newline', '\n', '\n'],
  ['a file that is two newlines', '\n\n', '\n\n'],
  ['a file that is a blank line of spaces', '   \n', '   \n'],

  // `-\titem` -> `- item`. A tab after a marker is whitespace under CommonMark's
  // tab expansion, and the item's text value is `item` either way (checked), so
  // this is a separator being respelled. It is respelled by the stringifier
  // because a marker's spacing is part of how it lays out nesting and
  // continuation lines — there is no per-item separator to hand back.
  ['tab after a list marker', '-\titem\n', '- item\n'],

  // `\tcode` -> a fenced block. THE ROW A NON-MARKDOWN READER CAN TELL APART BY
  // CONSTRUCT, and the one worth arguing: both spellings are a code block to a
  // CommonMark renderer, but a tool that looks for ``` — a highlighter, a docs
  // pipeline, a grep over the vault — finds code in one file and prose in the
  // other. Canonicalised to the fence because it is the only form this app's own
  // editing produces (slash command, paste, info strings) and because keeping
  // each block's source form is a stringifier feature, not an option: the
  // argument, and what it would cost, are in `serialize.ts`.
  ['tab-indented code block', '\tcode\n', '```\ncode\n```\n'],

  // `Title\n=====` -> `# Title`. The same heading at the same level; what changes
  // is two lines of source for one. ATX is what the editor's own heading
  // commands write, so one file has one spelling, and setext could not express
  // h3-h6 anyway.
  ['setext heading', 'Title\n=====\n', '# Title\n'],

  // `one  \n` -> `one\` and a newline. Both are a hard break and both render as
  // one, so this is a spelling of the same construct — canonicalised in the
  // direction that SURVIVES: trailing spaces are stripped by editors, git hooks
  // and formatters, and the break is stripped with them, while the backslash
  // form is read back byte for byte (the corpus above pins that).
  ['two-space hard break', 'one  \ntwo\n', 'one\\\ntwo\n'],
]

/**
 * The other half of the same measurement: the shapes a save already left alone,
 * pinned so a change to the canonical form above cannot quietly start moving
 * them. Two are whitespace the parser keeps verbatim, and the frontmatter rows
 * are the envelope's own rule — the block is carried as source, including its
 * blank separator line, so a save never adds or takes away one of these.
 */
const PRESERVED: Array<[string, string, string?]> = [
  // A tab inside a paragraph is a character in a text node, not layout: the
  // model holds it and writes it back.
  ['tabs in prose', 'a\tb\n'],

  // A file with nothing in it stays a file with nothing in it. Not the same
  // shape as the blank file above: this one must not GAIN a newline.
  ['empty file', ''],

  // Frontmatter and nothing else, in all three shapes it comes in. This is why
  // the "one gains a newline" rule above does not reach into the block: the
  // block is written back as source, and the blank line after it belongs to the
  // block rather than being a trailing blank line of the body.
  ['frontmatter only, no trailing newline', '---\ntitle: x\n---'],
  ['frontmatter only, with a newline', '---\ntitle: x\n---\n'],
  ['frontmatter only, with a blank line', '---\ntitle: x\n---\n\n'],

  // The blank-file defect one level in: a note whose body is a single blank line
  // after its frontmatter. The block is a string of its own (it swallows its own
  // trailing breaks); what is left is the body, which serialized to `''` — so
  // this file lost its last line while keeping everything above it.
  ['frontmatter and a blank body line', '---\ntitle: x\n---\n \n'],

  // The canonicalisation this brief did NOT decide, because it was already
  // decided: the only row that changes a character of the user's TEXT. See
  // `normalizeNbsp` — a browser types U+00A0 for a space at the end of a run,
  // and a plain-text search or diff for the phrase would not match it.
  ['non-breaking space', 'a b\n', 'a b\n'],
]

describe('the form a save writes is a decision, shape by shape', () => {
  for (const [label, input, expected] of CANONICALISED) {
    it(`canonicalises ${label}`, async () => {
      expect(await saved(input)).toBe(expected)
      // The canonical form has to be a fixed point, or it is a second shape to
      // drift from rather than a form.
      expect(await saved(expected)).toBe(expected)
    })
  }

  for (const [label, input, expected = input] of PRESERVED) {
    it(`preserves ${label}`, async () => {
      expect(await saved(input)).toBe(expected)
    })
  }
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
