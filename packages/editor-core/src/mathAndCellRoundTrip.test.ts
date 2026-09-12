import { describe, expect, it } from 'vitest'
import type { Node } from '@milkdown/prose/model'
import type { EditorView } from '@milkdown/prose/view'

import { insertMath } from './math/feature'
import { mathToMarkdown } from './math/nodes'
import { parseMarkdown } from './serialize'
import { countLineBreaks, editor, placeCursor, tableCount, withEditor, withTable } from './testkit'

/**
 * Round trips for math and line breaks in the two contexts where the textual
 * form is not free: a cell (one line, \`|\` is a delimiter) and inline math
 * (delimited by \`$\`).
 */

/** The latex of the first inline math node in the document, if any. */
function inlineLatex(view: EditorView): string | null {
  let latex: string | null = null
  view.state.doc.descendants((node: Node) => {
    if (latex === null && node.type.name === 'math_inline') latex = String(node.attrs.latex ?? '')
    return true
  })
  return latex
}

/** Every inlineMath value in a plain mdast parse of \`md\`. */
function parsedMathValues(md: string): string[] {
  const values: string[] = []
  const tree = parseMarkdown(md) as unknown as { children: Array<Record<string, unknown>> }
  const walk = (node: Record<string, unknown>): void => {
    if (node.type === 'inlineMath') values.push(String(node.value ?? ''))
    const children = node.children
    if (Array.isArray(children)) {
      for (const child of children as Array<Record<string, unknown>>) walk(child)
    }
  }
  walk(tree as unknown as Record<string, unknown>)
  return values
}

describe('D5: inline math whose latex contains $', () => {
  it('chooses the escaped delimiter form so the formula is not cut in half', () => {
    // '$a$b$' parses as math "a" plus the text "b$": the author's formula is
    // silently split, and the next save writes the split over the file.
    // '$$a$b$$' stays ONE inlineMath node with value 'a$b' (remark-math only
    // rejects a closing run LONGER than the opening run).
    expect(mathToMarkdown('a$b', 'inline')).toBe('$$a$b$$')
    expect(mathToMarkdown('E=mc^2', 'inline')).toBe('$E=mc^2$')
  })

  it('round-trips a$b through a markdown parse', () => {
    expect(parsedMathValues(mathToMarkdown('a$b', 'inline'))).toEqual(['a$b'])
  })

  it('round-trips a literal backslash-dollar', () => {
    expect(parsedMathValues(mathToMarkdown('a\\$b', 'inline'))).toEqual(['a\\$b'])
  })

  it('round-trips a newline inside the latex', () => {
    expect(parsedMathValues(mathToMarkdown('a\nb', 'inline'))).toEqual(['a\nb'])
  })

  it('leaves the plain form alone when there is no $', () => {
    expect(parsedMathValues(mathToMarkdown('x_i', 'inline'))).toEqual(['x_i'])
  })
})

describe('D5: the editor saves and re-opens a$a$b$ intact', () => {
  it('keeps the latex through a save → reopen cycle', async () => {
    const h = await editor('intro \n')
    try {
      insertMath(h.view, 'a$b', 'inline')
      const saved = await h.ed.save()
      expect(saved).toContain('$$a$b$$')

      const again = await withEditor(saved, async (ed) => ({
        md: await ed.save(),
        latex: inlineLatex(ed.getView()),
      }))
      expect(again.latex).toBe('a$b')
      expect(again.md).toBe(saved)
    } finally {
      h.destroy()
    }
  })
})

describe('D6: a | inside a cell formula is a literal, not a cell separator', () => {
  it('un-escapes \\| in math back to a plain | and re-escapes it on save', async () => {
    const input = '| $\\|x\\|$ | y |\n| - | - |\n| 1 | 2 |\n'
    const saved = await withEditor(input, async (ed) => {
      expect(inlineLatex(ed.getView())).toBe('|x|')
      return ed.save()
    })
    // The re-escape is what makes the row survive another open.
    expect(saved).toContain('$\\|x\\|$')
    const twice = await withEditor(saved, (ed) => ed.save())
    expect(twice).toBe(saved)
    const latex = await withEditor(twice, async (ed) => inlineLatex(ed.getView()))
    expect(latex).toBe('|x|')
  })

  it('does not escape a | in math outside a table', async () => {
    const md = 'value $|x|$ here\n'
    expect(await withEditor(md, (ed) => ed.save())).toBe(md)
  })

  it('still escapes a | in plain cell text', async () => {
    const saved = await withEditor('| a |\n| - |\n| x \\| y |\n', (ed) => ed.save())
    expect(saved).toContain('x \\| y')
  })
})

describe('D7: a hardbreak inside a cell survives the save', () => {
  it('writes the cell line break as <br /> and re-opens it as a break', async () => {
    // NOTE: the first data row becomes the table's header, so a cursor in row 1
    // is a header cell with text in it. The cell under test is cleared first, so
    // the hardbreak is the cell's whole content (the way Shift+Enter behaves in an
    // empty cell).
    const h = await withTable([['H1', 'H2'], ['x', 'b']])
    let saved = ''
    try {
      placeCursor(h.view, 1, 0)
      h.view.dispatch(h.view.state.tr.deleteSelection())
      // What Shift+Enter runs: hardbreakKeymap replaces the selection with a
      // hardbreak node (attrs.isInline defaults to false).
      const hardbreak = h.view.state.schema.nodes.hardbreak
      h.view.dispatch(h.view.state.tr.replaceSelectionWith(hardbreak.create()))
      saved = await h.ed.save()
    } finally {
      h.destroy()
    }

    expect(saved).toContain('<br />')
    expect(saved).toContain('| H1')

    // The break may come back as a hardbreak node or as an inline html node; both
    // re-open as a break, which is what the defect destroyed.
    const reopened = await withEditor(saved, async (ed) => ({
      breaks: countLineBreaks(ed.getView()),
      md: await ed.save(),
    }))
    expect(reopened.breaks).toBeGreaterThan(0)
    // And the file is a fixpoint: a second open/save does not change the bytes.
    expect(reopened.md).toBe(saved)
  })

  it('keeps the row count so the table does not grow', async () => {
    const h = await withTable([
      ['H1', 'H2'],
      ['a', 'b'],
      ['c', 'd'],
    ])
    try {
      placeCursor(h.view, 1, 0)
      const before = tableCount(h.view)
      const hardbreak = h.view.state.schema.nodes.hardbreak
      h.view.dispatch(h.view.state.tr.replaceSelectionWith(hardbreak.create()))
      expect(tableCount(h.view)).toBe(before)
    } finally {
      h.destroy()
    }
  })
})
