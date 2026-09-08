import { describe, expect, it, afterEach } from 'vitest'
import { createEditor } from '../editor'
import { basicPlugins } from '../plugins/basic'
import { getCommand } from '../registry'
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
    expect(md).toContain('|')
    expect(md).toMatch(/^|/m)
    expect(md).toContain('---')
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