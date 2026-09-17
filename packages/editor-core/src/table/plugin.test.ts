import { describe, expect, it, afterEach } from 'vitest'
import { createEditor } from '../editor'
import { basicPlugins } from '../plugins/basic'
import { getCommand, getMarkdownPrompt } from '../registry'
import { insertTable, TABLE_COMMAND_ID, tableMarkdown } from './plugin'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('tableMarkdown', () => {
  it('builds a gfm table markdown', () => {
    expect(tableMarkdown(2, 2)).toBe('| a | b |\n| - | - |\n| 1 | 2 |')
  })
})

describe('insertTable', () => {
  it('inserts a gfm table that round-trips through editor save', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('')

    const view = editor.getView()
    insertTable(view, 2, 2)

    const md = await editor.save()
    expect(md).toMatch(/^\|/m)
    // Every cell of a fresh table is empty, so every cell here is genuinely
    // empty on disk. This used to assert `---`, which passed for the wrong
    // reason: the placeholder `<br />` the serializer wrote into each blank cell
    // is six characters wide, and the delimiter row is padded to the widest cell
    // — so the row was `| ------ | ------ |` because of the marker, not because
    // the columns were anything. The assertion is now about the shape.
    expect(md.trim().split('\n')[1]).toBe('| - | - |')
    expect(md).not.toContain('<br')
    expect(await (async () => (await editor.open(md), editor.save()))()).toBe(md)
  })

  it('inserts a custom rows×cols table with the right dimensions', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('')

    const view = editor.getView()
    insertTable(view, 3, 4)

    const md = await editor.save()
    // 3 rows + the GFM header separator line.
    const lines = md.trim().split('\n')
    expect(lines).toHaveLength(4)
    // Every table line has exactly 4 columns.
    for (const line of lines) {
      expect(line.split('|').filter((s) => s.length > 0)).toHaveLength(4)
    }
    editor.destroy()
  })

  /**
   * The delimiter row of a table the app created, as one colon shape per
   * column: `:-` left, `-:` right, `:-:` center, `-` neither. Runs of hyphens
   * collapse to one — how many hyphens a column gets is remark-stringify's
   * re-padding (`serialize-fuzz.test.ts`), and what this file is about is
   * whether a column carries an alignment at all.
   */
  const delimiterColons = (md: string): string[] =>
    md
      .trim()
      .split('\n')[1]
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => cell !== '')
      .map((cell) => cell.replace(/-+/g, '-'))

  it('writes no alignment on a table the author has not aligned', async () => {
    // The schema's `alignment` default is `'left'` and a column nobody has
    // marked parses as `null`; `createAndFill()` took the default, so a table
    // inserted from the toolbar, the slash command or the size dialog was
    // written `| :--- | :--- | :--- |` — explicit left alignment on every
    // column of a table the author had not aligned. The app is not entitled to
    // put syntax in the file that the author did not choose.
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('')
    insertTable(editor.getView(), 2, 3)

    expect(delimiterColons(await editor.save())).toEqual(['-', '-', '-'])
    editor.destroy()
  })

  it('is a fixpoint: a fresh table survives save, reopen and save again', async () => {
    // The row above is about the first write; this is about the second. A file
    // the app wrote while the cells still carried `'left'` re-parsed as `null`,
    // so the delimiter row changed on the next save — a table that respells
    // itself once. Three cycles, so a rule that is only stable from the second
    // pass on cannot pass this by accident.
    const el = document.createElement('div')
    document.body.appendChild(el)
    const first = createEditor(el, { plugins: basicPlugins })
    await first.open('')
    insertTable(first.getView(), 2, 3)
    const saved = await first.save()
    first.destroy()

    let current = saved
    const seen: string[] = [delimiterColons(current).join(' ')]
    for (let cycle = 0; cycle < 3; cycle++) {
      const el2 = document.createElement('div')
      document.body.appendChild(el2)
      const editor = createEditor(el2, { plugins: basicPlugins })
      await editor.open(current)
      current = await editor.save()
      seen.push(delimiterColons(current).join(' '))
      editor.destroy()
    }
    expect(seen).toEqual(['- - -', '- - -', '- - -', '- - -'])
  })

  it('registers a source-mode prompt, so the source pane gets the size dialog too', async () => {
    // Source mode used to insert a hardcoded 3×3 — one button meaning two
    // different things in two view modes, and no way for the reader to say how
    // big the table was. The prompt is the same dialog, writing the Markdown the
    // answer describes.
    const prompt = getMarkdownPrompt(TABLE_COMMAND_ID)
    expect(prompt).toBeDefined()

    const produced: Array<{ text: string; caret?: number }> = []
    prompt?.ask((insert) => {
      if (typeof insert !== 'string') produced.push(insert)
    })
    await Promise.resolve()

    expect(document.querySelector('.table-dialog')).toBeTruthy()
    const ok = [...document.querySelectorAll('.table-dialog-actions button')].find(
      (b) => b.textContent?.trim() === '确定',
    ) as HTMLButtonElement
    ok.click()

    // The Markdown that came back is the size the dialog is showing. What the
    // STEPPERS do is not asserted here and cannot be: they sit inside a
    // `<label>`, and happy-dom does not deliver a click on a button there — the
    // handler never runs, while the same app's cancel and confirm handlers do.
    // In the engine that ships they work, and the run that says so is the
    // WebKitGTK probe (`apps/desktop/e2e/webkit/probe-table.mjs`), which stepped
    // 3×3 to 4×5 through real driver clicks and got a 4-row, 5-column table.
    expect(produced).toHaveLength(1)
    expect(produced[0].text).toBe(`\n${tableMarkdown(3, 3)}\n`)
    expect(document.querySelector('.table-dialog')).toBeNull()
  })

  it('inserts nothing when the source-mode size dialog is cancelled', () => {
    // The fallback template is still registered for a host that does not resolve
    // prompts, but a host that does must not insert a default the reader did not
    // choose.
    const produced: unknown[] = []
    getMarkdownPrompt(TABLE_COMMAND_ID)?.ask((insert) => produced.push(insert))
    const cancel = [...document.querySelectorAll('.table-dialog-actions button')][0] as HTMLButtonElement
    cancel.click()
    expect(produced).toEqual([])
  })

  it('table.insert command opens the size dialog instead of inserting fixed 3×3', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('')

    const cmd = getCommand(TABLE_COMMAND_ID)
    expect(cmd).toBeDefined()
    cmd?.run()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.querySelector('.table-dialog')).toBeTruthy()
    const md = await editor.save()
    expect(md).not.toContain('|')
    editor.destroy()
  })
})