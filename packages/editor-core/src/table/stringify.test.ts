import { describe, expect, it } from 'vitest'
import { createEditor } from '../editor'
import { renderDocument } from '../export/html'

/**
 * A `|` inside a GFM table cell is a cell separator.
 *
 * Text nodes get escaped by the table construct's `|` unsafe pattern, but every
 * construct this app represents as raw HTML — `[[wikilink]]`, `<Comp/>`, the
 * empty-paragraph `<br />` marker — goes through `mdast-util-to-markdown`'s
 * default `html` handler, which emits the value verbatim. A piped wikilink in a
 * cell therefore reached disk as `| [[N | alias]] |`: one cell too many, and the
 * wikilink was gone the next time the file was opened.
 */
async function save(input: string): Promise<string> {
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

describe('pipes in raw HTML inside a table cell', () => {
  it('escapes the pipe of a wikilink so the row keeps its cell count', async () => {
    const input = '| a |\n| - |\n| [[N\\|alias]] |\n'
    const saved = await save(input)
    expect(saved).toContain('[[N\\|alias]]')
    // The row must still have one cell, i.e. only the delimiters are pipes.
    const row = saved.split('\n').find((line) => line.includes('[[N'))
    expect(row?.replace(/\\\|/g, '').split('|').filter((s) => s.trim()).length).toBe(1)
    // ... and the wikilink survives a reopen, which is the point of escaping it.
    expect(await save(saved)).toBe(saved)
    expect(renderDocument(saved, { math: 'text' })).toContain('data-target="N"')
  })

  it('escapes a pipe in a component inside a cell', async () => {
    // The author has to escape the pipe for the row to parse as one cell, and
    // the escape must survive the save so the next open still reads one cell.
    const input = '| a |\n| - |\n| <Comp a="x\\|y" /> |\n'
    const saved = await save(input)
    expect(saved).toContain('x\\|y')
    expect(await save(saved)).toBe(saved)
  })

  it('leaves a pipe in raw HTML outside a table alone', async () => {
    const input = '# H <Comp a="x|y" />\n'
    expect(await save(input)).toBe(input)
  })

  it('keeps a pipe inside an MDX expression inside its cell', async () => {
    // An MDX run is written back verbatim — but `|` still separates cells, so the
    // escape the author wrote must come back. The run is escaped by the MDX text
    // handler rather than by `state.safe` (see mdx/text.ts); without that the row
    // gained cells on the next save and the expression was split in two.
    const input = '| a | b |\n| - | - |\n| {x \\|\\| y} | z |\n'
    const saved = await save(input)
    expect(saved).toContain('{x \\|\\| y}')
    expect(await save(saved)).toBe(saved)
  })
})
