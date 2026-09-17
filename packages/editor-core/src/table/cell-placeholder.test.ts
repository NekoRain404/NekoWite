import { describe, expect, it } from 'vitest'
import { createEditor } from '../editor'
import { withEditor } from '../testkit'

/**
 * A blank table cell must be an empty cell — in the file and in the model.
 *
 * Milkdown's paragraph serializer writes a standalone `<br />` for an empty
 * paragraph, and a cell with nothing in it is exactly that. So every blank cell
 * of every table was written `| <br /> |`: six characters of syntax the reader
 * never typed, shown as text by the source pane and rendered as a break by any
 * other Markdown tool. Worse, the `html` atom that came back on the next open
 * made the save after it write `<br />` BESIDE whatever was typed next to it, so
 * a cell could not be emptied again.
 *
 * The rule is one sentence: **in a GFM cell, a `<br>` that is the whole of the
 * cell is the empty-cell placeholder, not content.** It has to be enforced on
 * both sides, and each side has a job the other cannot do:
 *
 *   - `table/stringify.ts` never writes one. This is the half that covers a
 *     table inserted from the toolbar or the size dialog, where no `<br>` was
 *     ever in the model — the paragraph serializer makes one up on the way out.
 *   - `dropEmptyCellBreaks` never lets one in. This is the half that covers a
 *     note written before the rule existed, and it is what stops the atom from
 *     seeding the next save.
 *
 * What must NOT move is the block-level convention the same marker serves: a
 * marker alone between two blocks is a deliberate blank paragraph, and it stays
 * one. Those cases are at the bottom, and they are here rather than in
 * `inline-break.test.ts` so the two rules can be read against each other.
 */

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

describe('a blank table cell is written as a blank cell', () => {
  it('writes nothing for a cell the author left empty', async () => {
    expect(await saved('| a | b |\n| - | - |\n|  | x |\n')).toBe('| a | b |\n| - | - |\n|   | x |\n')
  })

  it('writes nothing for a table whose every cell is empty', async () => {
    // What the insert command produces: no cell has any content, so no cell
    // should have any syntax either.
    expect(await saved('|  |  |\n| - | - |\n|  |  |\n')).toBe('|   |   |\n| - | - |\n|   |   |\n')
  })

  it('writes nothing for an empty HEADER cell', async () => {
    // The header row is cells too, and it is the row the delimiter row is
    // padded to — so a marker here widened every column of the table.
    expect(await saved('|  | b |\n| - | - |\n| x | y |\n')).toBe('|   | b |\n| - | - |\n| x | y |\n')
  })

  it('drops the marker from a note that already holds one', async () => {
    // The reader's existing notes. Nothing rewrites them in the background: the
    // marker goes on the next SAVE, so a note nobody opens is untouched.
    expect(await saved('| a | b |\n| - | - |\n| <br /> | x |\n')).toBe('| a | b |\n| - | - |\n|   | x |\n')
  })

  it('accepts every spelling the preset calls a marker', async () => {
    for (const spelling of ['<br />', '<br>', '<br/>', '<br >']) {
      expect(await saved(`| a |\n| - |\n| ${spelling} |\n`), spelling).toBe('| a |\n| - |\n|   |\n')
    }
  })

  it('is a fixpoint: the second save writes what the first one wrote', async () => {
    const first = await saved('| a | b |\n| - | - |\n| <br /> | x |\n')
    expect(await saved(first)).toBe(first)
  })
})

describe('a break between two things in a cell is untouched', () => {
  it('keeps a break the author put between two runs of text', async () => {
    // In a GFM cell this is the ONLY way to write a line break, so it is the one
    // case the two rules must never reach.
    expect(await saved('| a<br />b | c |\n| - | - |\n| x | y |\n')).toContain('a<br />b')
  })

  it('keeps a break that only shares its cell with whitespace-free text', async () => {
    const out = await saved('| a<br />b<br />c |\n| - |\n| x |\n')
    expect(out).toContain('a<br />b<br />c')
    expect(out).not.toContain('| <br /> |')
  })
})

describe('a break NODE in a cell, which is the other way one gets written', () => {
  /** Put `node` in the first body cell, replacing whatever was there. */
  async function cellWith(what: 'break' | 'text break text'): Promise<string> {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const ed = createEditor(el)
    try {
      await ed.open('| a | b |\n| - | - |\n|  | x |\n')
      const view = ed.getView()
      const schema = view.state.schema
      const doc = view.state.doc
      let from = -1
      let to = -1
      doc.descendants((node, pos) => {
        if (node.type.name !== 'paragraph' || node.textContent !== '' || to !== -1) return true
        // The first empty paragraph is the one in the body cell.
        from = pos + 1
        to = pos + node.nodeSize - 1
        return false
      })
      expect(from).toBeGreaterThan(0)
      const br = schema.nodes.hardbreak.create()
      const replacement =
        what === 'break'
          ? br
          : [schema.text('L'), br, schema.text('R')]
      view.dispatch(view.state.tr.replaceWith(from, to, replacement))
      return await ed.save()
    } finally {
      ed.destroy()
      el.remove()
    }
  }

  it('writes nothing for a break that is the whole cell', async () => {
    // Shift+Enter in a cell that has nothing else, and a cell the reader emptied
    // with the break left behind, are the same document. Both write nothing —
    // and NOT because of anything in this package: the preset's `serializeText`
    // emits every child except a trailing hardbreak, so a paragraph whose only
    // child is one reaches `table/stringify.ts` with no break node to write. The
    // case is pinned here because the file's emptiness depends on it, and a
    // guard added for it would be a guard that cannot fire.
    expect(await cellWith('break')).toBe('| a | b |\n| - | - |\n|   | x |\n')
  })

  it('still writes a break that separates two runs of text', async () => {
    // The delimiter row is padded to the widest cell, which is now the one
    // holding the break — the same re-padding every table gets.
    expect(await cellWith('text break text')).toBe('| a        | b |\n| -------- | - |\n| L<br />R | x |\n')
  })
})

describe('the model, not only the bytes', () => {
  it('leaves the cell a reader types into genuinely empty', async () => {
    // The loop, stated as a test: before the parse-side rule the cell held an
    // `html` atom, and typing beside it saved `| <br />Z | x |`.
    await withEditor('| a | b |\n| - | - |\n| <br /> | x |\n', async (ed) => {
      const view = ed.getView()
      const doc = view.state.doc
      const cell = doc.child(0).child(1).child(0)
      expect(cell.textContent).toBe('')
      expect(cell.child(0).content.size).toBe(0)
      // The caret inside that cell's paragraph, which is where a reader lands
      // when they click it.
      let at = -1
      doc.descendants((node, pos) => {
        if (at === -1 && node.type.name === 'paragraph' && node.content.size === 0) at = pos + 1
        return at === -1
      })
      expect(at).toBeGreaterThan(0)
      view.dispatch(view.state.tr.insertText('Z', at))
      expect(await ed.save()).toBe('| a | b |\n| - | - |\n| Z | x |\n')
    })
  })

  it('renders an empty cell with no atom in it', async () => {
    await withEditor('| a |\n| - |\n| <br /> |\n', async (ed) => {
      // ProseMirror draws its own `<br class="ProseMirror-trailingBreak">` so a
      // caret has somewhere to sit in an empty block. That one is the editor's
      // and is never serialized; the atom's `<br>` is the one that was.
      expect(ed.getView().dom.querySelector('span[data-type="html"]')).toBeNull()
    })
  })
})

describe('the block-level empty-line convention still holds', () => {
  it('folds a standalone marker back into a blank paragraph', async () => {
    await withEditor('a\n\n<br />\n\nb\n', async (ed) => {
      const doc = ed.getView().state.doc
      expect(doc.childCount).toBe(3)
      expect(doc.child(1).type.name).toBe('paragraph')
      expect(doc.child(1).content.size).toBe(0)
      expect(await ed.save()).toBe('a\n\n<br />\n\nb\n')
    })
  })

  it('keeps the marker in a paragraph outside a table', async () => {
    // The rule is about cells. A `<br />` that is the whole of a PARAGRAPH is the
    // blank line the serializer is entitled to preserve.
    expect(await saved('one\n\n<br />\n\ntwo\n')).toBe('one\n\n<br />\n\ntwo\n')
  })
})
