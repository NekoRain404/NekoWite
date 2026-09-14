import { describe, expect, it } from 'vitest'

import { createEditor } from './editor'
import { renderDocument } from './export'
import { withEditor } from './testkit'

/**
 * An author-written inline `<br />` must survive open → save AND render as a break.
 *
 * The commonmark preset ships `remarkPreserveEmptyLine`, which deletes EVERY
 * mdast `html` node whose value is one of the `<br>` spellings. That rule exists
 * for a different job: the serializer writes a standalone `<br />` for an empty
 * paragraph so a blank line survives a reopen, and the parser has to fold that
 * marker back into an empty paragraph. Applied unconditionally it also ate the
 * author's own line break — `line1<br />line2` came back as `line1line2` (the two
 * text runs merged, because the only node between them had been spliced out) and
 * the next save wrote that over the file, so the break was gone for good. GFM has
 * no other way to break a line inside a table cell, so cells lost it too.
 *
 * The first fix masked an inline marker while the document was parsed (a sentinel
 * that no transformer matches) and turned it back into an `html` node before the
 * tree became a ProseMirror document; the block-level marker kept the preset’s
 * behavior. See `plugins/inline-break.ts`.
 *
 * Masking the marker keeps the BYTES — the marker still reaches the model as an
 * `html` atom, whose value the serializer writes back verbatim — but an `html`
 * atom is rendered by the preset as a `<span>` holding the tag as literal text,
 * so for every one of these cases the pane showed `<br />` as characters instead
 * of breaking the line (task-71). The atom is now rendered as a break
 * (`plugins/inline-break-view.ts`), and the export renders it as `<br />` too.
 */

const SENTINEL = /[]/

/**
 * Open a document of a given KIND: the kind decides which reader runs, and the
 * two must agree about what a document says.
 */
async function withKind<T>(
  md: string,
  kind: 'md' | 'mdx',
  fn: (ed: ReturnType<typeof createEditor>) => Promise<T>,
): Promise<T> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const ed = createEditor(el)
  try {
    await ed.open(md, kind === 'mdx' ? 'note.mdx' : 'note.md')
    return await fn(ed)
  } finally {
    ed.destroy()
    el.remove()
  }
}

/** Every text the document takes across `times` open-and-save cycles. */
async function cycles(input: string, kind: 'md' | 'mdx', times = 3): Promise<string[]> {
  const seen: string[] = []
  let text = input
  for (let i = 0; i < times; i++) {
    text = await withKind(text, kind, (ed) => ed.save())
    seen.push(text)
  }
  return seen
}

/** Saved text, re-opened, must save to the same bytes: the round trip is a fixpoint. */
async function savedAndStable(input: string): Promise<string> {
  const once = await withEditor(input, (ed) => ed.save())
  const twice = await withEditor(once, (ed) => ed.save())
  expect(twice).toBe(once)
  return once
}

/**
 * Line breaks the RENDERED PANE shows.
 *
 * This is deliberately a measure of the DOM and not of node types. The previous
 * version of this helper counted any `html` node as a break, which is how the
 * suite passed while the pane was showing `<br />` as literal text: the node that
 * proved the marker had SURVIVED was counted as the node that proves it is
 * RENDERED. ProseMirror’s own caret `<br>` (inside an empty block) is not a line
 * break the author wrote, so it is excluded.
 */
function renderedBreaks(ed: ReturnType<typeof createEditor>): number {
  return [...ed.getView().dom.querySelectorAll('br')].filter(
    (br) => !br.classList.contains('ProseMirror-trailingBreak'),
  ).length
}

describe('an author-written inline <br /> survives open → save', () => {
  const cases: Array<[string, string, string[]]> = [
    ['in a paragraph', 'line1<br />line2\n', ['line1', 'line2']],
    ['in a heading', '# Head<br />ing\n', ['Head', 'ing']],
    ['in a list item', '- one<br />two\n', ['one', 'two']],
    ['in a blockquote', '> q<br />r\n', ['q', 'r']],
    ['in a table cell', '| a<br />b | c |\n| - | - |\n| x | y |\n', ['a', 'b']],
  ]

  for (const [label, input, tokens] of cases) {
    it(label, async () => {
      const saved = await savedAndStable(input)

      // The text on both sides is still there (the bug merged them into one run).
      for (const token of tokens) expect(saved, `${label}: ${token}`).toContain(token)
      expect(saved).toContain("<br />")

      // ... and the pane shows a break, not the literal text of the tag.
      const breaks = await withEditor(saved, async (ed) => renderedBreaks(ed))
      expect(breaks, `no rendered line break survived in: ${JSON.stringify(saved)}`).toBeGreaterThan(0)
    })
  }

  it("keeps every break spelling and the surrounding text in a paragraph", async () => {
    const saved = await savedAndStable("a<br />b<br>c<br/>d<br >e\n")
    for (const token of ["a", "b", "c", "d", "e"]) expect(saved).toContain(token)
    // The literal tag text must not show up inside the paragraph.
    expect(saved.replace(/<br\s*\/?>/g, '')).toContain('abcde')
    const breaks = await withEditor(saved, async (ed) => renderedBreaks(ed))
    expect(breaks).toBe(4)
  })

  it("keeps a break that sits next to other inline markup", async () => {
    const saved = await savedAndStable("a **bold**<br />*em*\n")
    expect(saved).toContain("bold")
    expect(saved).toContain("em")
    const breaks = await withEditor(saved, async (ed) => renderedBreaks(ed))
    expect(breaks).toBe(1)
  })

  it("keeps both sides of the break in the exported HTML", async () => {
    // The export renders the marker as a `<br />` (the break the author wrote),
    // so the two sides are still separated in the exported document.
    const saved = await withEditor("line1<br />line2\n", (ed) => ed.save())
    const html = await renderDocument(saved)
    expect(html).toMatch(/line1<br\s*\/?>line2/i)
  })
})

/**
 * The pane must SHOW the break, for every spelling a browser would read as one.
 *
 * `<BR/>` and `<br  />` are not in the preset’s marker list, so nothing masked
 * them — they survived as `html` atoms with their own spelling and were rendered
 * as literal tag text, which is the same defect through the other door. The
 * rendering rule is therefore about the TAG, not about the four spellings the
 * masking code happens to know.
 */
describe('the pane renders the author’s break as a line break', () => {
  const contexts: Array<[string, string]> = [
    ['in a paragraph', 'line1<br/>line2\n'],
    ['in a heading', '# Head<br/>ing\n'],
    ['in a list item', '- one<br/>two\n'],
    ['in a blockquote', '> q<br/>r\n'],
    ['in a table cell', '| a<br/>b | c |\n| - | - |\n| x | y |\n'],
  ]

  for (const [label, input] of contexts) {
    it(label, async () => {
      const breaks = await withEditor(input, async (ed) => renderedBreaks(ed))
      expect(breaks, label).toBe(1)
      // ... and the tag itself is not what the reader sees.
      const shown = await withEditor(input, async (ed) => ed.getView().dom.textContent)
      expect(shown, label).not.toContain('<br')
    })
  }

  it('renders every spelling a browser calls a line break', async () => {
    const spellings = ['<br/>', '<br />', '<br>', '<br  />', '<BR/>', '<br >']
    for (const spelling of spellings) {
      const breaks = await withEditor(`a${spelling}b\n`, async (ed) => renderedBreaks(ed))
      expect(breaks, spelling).toBe(1)
      const shown = await withEditor(`a${spelling}b\n`, async (ed) => ed.getView().dom.textContent)
      expect(shown, spelling).toBe('ab')
    }
  })

  it('still shows other inline raw HTML as its source', async () => {
    // The rendering rule is about the break tag, not about raw HTML in general:
    // an arbitrary tag keeps the atom’s own rendering (the tag as its text), so
    // nothing here turns the editor into an HTML renderer.
    const shown = await withEditor('a<span class="x">b</span>c\n', async (ed) =>
      ed.getView().dom.textContent,
    )
    expect(shown).toContain('<span')
    expect(shown).not.toContain('<br')
  })

  it('renders the empty-cell marker as a break, so an empty cell looks empty', async () => {
    // The serializer writes a standalone `<br />` for an empty cell, and a line
    // with pipes is never a “standalone line” to the masker, so the marker comes
    // back through the inline path. It used to be shown to the reader as the text
    // `<br />` inside every empty cell.
    const shown = await withEditor('| a |\n| - |\n| <br /> |\n', async (ed) =>
      ed.getView().dom.textContent,
    )
    expect(shown).toBe('a')
  })

  it('renders the exported document with the same break', async () => {
    const html = await renderDocument('line one<br>line two\n')
    expect(html).toContain('<p>line one<br />line two</p>')
  })

  it('keeps the atom’s own DOM identity around the break', async () => {
    // The break is drawn INSIDE the atom’s span rather than replacing it: the
    // schema’s parseDOM and ProseMirror’s clipboard both read a
    // `span[data-type="html"]` with the source in `data-value`, so dropping either
    // would make a copy of a note containing a break come back as something else.
    await withEditor('a<br />b\n', async (ed) => {
      const span = ed.getView().dom.querySelector('span[data-type="html"]')
      expect(span).not.toBeNull()
      expect(span?.getAttribute('data-value')).toBe('<br />')
      expect(span?.querySelector('br')).not.toBeNull()
    })
  })

  it('reuses that span when the atom is edited', async () => {
    await withEditor('a<br />b\n', async (ed) => {
      const view = ed.getView()
      const span = view.dom.querySelector('span[data-type="html"]')
      let pos = -1
      view.state.doc.descendants((node, at) => {
        if (node.type.name === 'html') {
          pos = at
          return false
        }
        return true
      })
      expect(pos).toBeGreaterThanOrEqual(0)
      view.dispatch(view.state.tr.setNodeAttribute(pos, 'value', '<span>x</span>'))
      const after = view.dom.querySelector('span[data-type="html"]')
      expect(after).toBe(span)
      expect(after?.querySelector('br')).toBeNull()
      expect(after?.textContent).toBe('<span>x</span>')
    })
  })
})

/**
 * The marker must never leave the parse, whatever the tree shape carries it.
 *
 * `restoreInlineBreaks` treated every value-carrying node as if it were a text
 * run: it split the value into siblings of the same node type and dropped an
 * `html` node between them. A text run is the one node that can hold that shape.
 * Anywhere else the node was destroyed — a fenced block holding a marker became
 * three top-level nodes and `open()` threw, a code span and a formula came apart
 * in two — and a string the walk never looked at (an image’s `alt`, a link’s
 * `title`) carried the sentinels into the model and out into the user’s file.
 */
describe('the marker stays inside the node that holds it', () => {
  it('opens a fenced code block that contains a break spelling', async () => {
    for (const spelling of ['<br/>', '<br />', '<br>']) {
      const input = '```\nfoo' + spelling + 'bar\n```\n'
      expect(await withEditor(input, (ed) => ed.save()), spelling).toBe(input)
    }
  })

  it('opens an indented code block that contains a break spelling', async () => {
    const saved = await withEditor('    foo<br/>bar\n', (ed) => ed.save())
    expect(saved).toContain('foo<br/>bar')
    expect(saved).not.toMatch(SENTINEL)
  })

  it('keeps an inline code span in one piece', async () => {
    const input = 'foo `a<br/>b` bar\n'
    expect(await withEditor(input, (ed) => ed.save())).toBe(input)
  })

  it('keeps a formula in one piece', async () => {
    const input = 'foo $a<br/>b$ bar\n'
    expect(await withEditor(input, (ed) => ed.save())).toBe(input)
  })

  it('opens a document whose MDX component holds an inline break', async () => {
    const input = '<Callout>a<br/>b</Callout>\n'
    expect(await withEditor(input, (ed) => ed.save())).toBe(input)
  })

  it('never writes a sentinel into the file', async () => {
    const inputs = [
      'line1<br />line2\n',
      '![a<br/>b](p.png)\n',
      '[x](http://y "t<br/>u")\n',
      '[x]: http://y "t<br/>u"\n\n[x]\n',
      '| a<br/>b | c |\n| - | - |\n| x | y |\n',
      '```\nfoo<br/>bar\n```\n',
    ]
    for (const input of inputs) {
      const saved = await withEditor(input, (ed) => ed.save())
      expect(saved, input).not.toMatch(SENTINEL)
    }
  })

  it('keeps the text a marker sits in, in an image alt and a link title', async () => {
    // The alt is written with the serializer’s own escaping for `<`, which is
    // what any `<` in an alt gets; the marker itself must still be there.
    const alt = await withEditor('![a<br/>b](p.png)\n', (ed) => ed.save())
    expect(alt).toContain('<br/>')
    const title = await withEditor('[x](http://y "t<br/>u")\n', (ed) => ed.save())
    expect(title).toBe('[x](http://y "t<br/>u")\n')
  })
})

describe("the block-level empty-paragraph marker convention is unchanged", () => {
  it("folds a standalone <br /> back into an empty paragraph", async () => {
    await withEditor("a\n\n<br />\n\nb\n", async (ed) => {
      // Three blocks: "a", an empty paragraph, "b". Before the fix the marker was
      // removed and the empty paragraph collapsed into "ab".
      const doc = ed.getView().state.doc
      expect(doc.childCount).toBe(3)
      expect(doc.child(1).type.name).toBe("paragraph")
      expect(doc.child(1).content.size).toBe(0)
      expect(await ed.save()).toBe("a\n\n<br />\n\nb\n")
    })
  })

  it("keeps the empty-cell marker round-tripping", async () => {
    // The pinned behavior from editorRoundtripFuzz.test.ts, spelled out here too
    // because the fix must not weaken it.
    const saved = await savedAndStable("| a | b |\n| - | - |\n|  |  |\n")
    expect(saved).toContain("<br />")
  })
})

/**
 * An escaped marker is TEXT, and the masker must leave it alone.
 *
 * `maskInlineBreaks` matches the source with a regex, so it also matched the
 * escape the SERIALIZER writes to protect a literal `<` — `\<br/>`. Masking it
 * undid the author's escape (and the writer's own): the backslash stopped
 * escaping anything, the tag became a live marker again, and because the writer
 * then re-escapes what the model holds, an image alt gained **two backslashes on
 * every open-and-save cycle** — `![a\<br/>b](p.png)` → `![a\\\<br/>b](p.png)` →
 * `![a\\\\\<br/>b](p.png)` — for as long as the note was used. In prose the same
 * mis-read turned an escaped literal tag into a real line break, which is the
 * opposite of what escaping means.
 *
 * An odd run of backslashes in front of the `<` is Markdown's own escape rule,
 * and the marker is a tag only when it is not escaped.
 */
describe('a backslash-escaped marker is left as text', () => {
  const MARKERS = ['<br/>', '<br />', '<br>', '<br >'] as const

  it('never masks an escaped marker, in either kind', async () => {
    for (const kind of ['md', 'mdx'] as const) {
      for (const marker of MARKERS) {
        const input = `a\\${marker}b\n`
        const shown = await withKind(input, kind, async (ed) => ({
          text: ed.getView().dom.textContent,
          breaks: renderedBreaks(ed),
          saved: await ed.save(),
        }))
        const label = `${kind} ${marker}`
        // The escaped tag is literal text: it shows as the tag, not as a break.
        expect(shown.breaks, label).toBe(0)
        expect(shown.text, label).toBe(`a${marker}b`)
        // ... and the escape survives the round trip as the escape it is.
        expect(shown.saved, label).toBe(input)
      }
    }
  })

  it('leaves a real tag alone behind an even run of backslashes', async () => {
    // Markdown's own escape rule is what the masker now follows: an ODD run
    // escapes the `<` (literal text), an EVEN one leaves a real tag behind it.
    // The even side is the half that could be lost by over-correcting, so it is
    // pinned: `a\\<br/>b` is a backslash and a break, not literal text.
    const cases: Array<[number, number, string]> = [
      [0, 1, 'ab'],
      [1, 0, 'a<br/>b'],
      [2, 1, 'a\\b'],
      [3, 0, 'a\\<br/>b'],
    ]
    for (const kind of ['md', 'mdx'] as const) {
      for (const [count, breaks, text] of cases) {
        const label = `${kind}, ${count} backslashes`
        const seen = await withKind(`a${'\\'.repeat(count)}<br/>b\n`, kind, async (ed) => ({
          breaks: renderedBreaks(ed),
          text: ed.getView().dom.textContent,
        }))
        expect(seen.breaks, `${label}: rendered breaks`).toBe(breaks)
        expect(seen.text, `${label}: text`).toBe(text)
      }
    }
  })

  it('is a fixpoint: an image alt holding a marker does not grow', async () => {
    for (const kind of ['md', 'mdx'] as const) {
      for (const marker of MARKERS) {
        for (const alt of [`a${marker}b`, `a\\${marker}b`] as const) {
          const input = `![${alt}](p.png)\n`
          const seen = await cycles(input, kind)
          const label = `${kind} ${JSON.stringify(input.trim())}`
          // Stable is not enough: a document that has LOST the tag is stable too
          // (the MDX reader drops it on the first open, and every later cycle
          // reproduces the loss exactly). The bytes must be stable AND still say
          // what the author wrote — the round trip is not a licence to converge
          // on something smaller.
          expect(seen[0], `${label} (did the tag survive?)`).toContain('<br')
          expect(seen[0], `${label} (did the text on both sides survive?)`).toMatch(/a.*<br.*>b/)
          expect(seen[1], `${label} (save 2 vs save 1)`).toBe(seen[0])
          expect(seen[2], `${label} (save 3 vs save 1)`).toBe(seen[0])
        }
      }
    }
  })

  it('is a fixpoint for one document holding every spelling, escaped and not', async () => {
    const prose = MARKERS.flatMap((m) => [`a${m}b`, `a\\${m}b`]).join('\n\n')
    const alts = MARKERS.map((m) => `![a${m}b](p.png)`).join('\n\n')
    const escapedAlts = MARKERS.map((m) => `![a${m}b](q.png)`.replace(m, `\\${m}`)).join('\n\n')
    const cases: Array<[string, string, number]> = [
      // Every line keeps its tag, so the count is exact: a document that drops
      // one is not "stable", it is smaller.
      ['prose', prose, MARKERS.length * 2],
      ['alts', alts, MARKERS.length],
      ['escaped alts', escapedAlts, MARKERS.length],
    ]
    for (const kind of ['md', 'mdx'] as const) {
      for (const [what, input, expected] of cases) {
        const seen = await cycles(`${input}\n`, kind)
        const label = `${kind} ${what}\n${seen.join('\n---\n')}`
        expect((seen[0].match(/<br/g) ?? []).length, `tags left in the file: ${label}`).toBe(expected)
        expect(seen[1], `save 2 vs save 1: ${label}`).toBe(seen[0])
        expect(seen[2], `save 3 vs save 1: ${label}`).toBe(seen[0])
      }
    }
  })
})
