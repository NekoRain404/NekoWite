import { describe, expect, it } from 'vitest'
import { createEditor } from '../editor'
import { basicPlugins } from '../plugins/basic'
import { getCommand } from '../registry'
import { insertTable, TABLE_COMMAND_ID, tableMarkdown } from './plugin'

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

  it('table.insert command inserts through the captured editor view', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('')

    const cmd = getCommand(TABLE_COMMAND_ID)
    expect(cmd).toBeDefined()
    cmd?.run()

    const md = await editor.save()
    expect(md).toContain('|')
    expect(md).toContain('---')
  })
})