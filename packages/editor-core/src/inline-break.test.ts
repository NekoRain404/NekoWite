import { describe, expect, it } from 'vitest'

import { createEditor } from './editor'
import { renderDocument } from './export/html'
import { withEditor } from './testkit'

/**
 * An author-written inline `<br />` must survive open → save.
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
 * The fix masks an inline marker while the document is parsed (a sentinel that no
 * transformer matches) and turns it back into an `html` node before the tree
 * becomes a ProseMirror document; the block-level marker keeps the preset’s
 * behavior. See `plugins/remark.ts`.
 */

/** Saved text, re-opened, must save to the same bytes: the round trip is a fixpoint. */
async function savedAndStable(input: string): Promise<string> {
  const once = await withEditor(input, (ed) => ed.save())
  const twice = await withEditor(once, (ed) => ed.save())
  expect(twice).toBe(once)
  return once
}

/**
 * Line breaks in the live document. Accepts the hardbreak node (the backslash
 * form in Markdown) and the raw `html` node: both re-open as a break, and which
 * one a given spelling produces depends on the parser’s node matching.
 */
function lineBreaks(ed: ReturnType<typeof createEditor>): number {
  let count = 0
  ed.getView().state.doc.descendants((node) => {
    if (node.type.name === 'hardbreak') count += 1
    else if (node.type.name === 'html') count += 1
    return true
  })
  return count
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

      // ... and re-opens as a break, not as the literal text of the tag.
      const breaks = await withEditor(saved, async (ed) => lineBreaks(ed))
      expect(breaks, `no line break survived in: ${JSON.stringify(saved)}`).toBeGreaterThan(0)
    })
  }

  it("keeps every break spelling and the surrounding text in a paragraph", async () => {
    const saved = await savedAndStable("a<br />b<br>c<br/>d<br >e\n")
    for (const token of ["a", "b", "c", "d", "e"]) expect(saved).toContain(token)
    // The literal tag text must not show up inside the paragraph.
    expect(saved.replace(/<br\s*\/?>/g, '')).toContain('abcde')
    const breaks = await withEditor(saved, async (ed) => lineBreaks(ed))
    expect(breaks).toBe(4)
  })

  it("keeps a break that sits next to other inline markup", async () => {
    const saved = await savedAndStable("a **bold**<br />*em*\n")
    expect(saved).toContain("bold")
    expect(saved).toContain("em")
    const breaks = await withEditor(saved, async (ed) => lineBreaks(ed))
    expect(breaks).toBe(1)
  })

  it("keeps both sides of the break in the exported HTML", async () => {
    // The export escapes inline raw HTML (see export/renderNodes.test.ts, which
    // pins that choice for every inline `<br>`), so the break shows up as
    // `line1&lt;br /&gt;line2` there rather than as a rendered `<br>`. What must
    // NOT happen — the defect — is losing the text around it or dropping the
    // marker before the export ever sees it.
    const saved = await withEditor("line1<br />line2\n", (ed) => ed.save())
    const html = await renderDocument(saved)
    expect(html).toMatch(/line1&lt;br\s*\/&gt;line2/i)
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
