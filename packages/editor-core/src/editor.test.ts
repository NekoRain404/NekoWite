import { describe, expect, it } from 'vitest'

import { basicPlugins, createEditor } from './editor'

describe('createEditor', () => {
  it('exposes open/save API', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('# Hello')
    const md = await editor.save()
    expect(md).toContain('# Hello')
  })

  it('preserves yaml frontmatter across open/save', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    // Without extraction the model would parse the block as a thematic break
    // plus a setext heading and rewrite it on save.
    const md = '---\ntitle: hello\ntags: []\n---\n\n# Body\n\ncontent\n'
    await editor.open(md)
    expect(await editor.save()).toBe(md)
  })

  it('re-extracts frontmatter when reopened with a different block', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('---\ntitle: a\n---\n\nOne\n')
    await editor.open('---\ntitle: b\n---\n\nTwo\n')
    expect(await editor.save()).toBe('---\ntitle: b\n---\n\nTwo\n')
  })

  it('open() is excluded from undo history', async () => {
    const { undo, undoDepth } = await import('@milkdown/prose/history')
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('# First')
    await editor.open('# Second')
    const view = editor.getView()
    // A document load must not be undoable: undoing after switching documents
    // would otherwise wipe the freshly opened doc instead of the user's edit.
    expect(undoDepth(view.state)).toBe(0)
    expect(undo(view.state, () => undefined)).toBe(false)
    expect(view.state.doc.textContent).toContain('Second')
  })

  it('insertMarkdownAtCursor inserts a parsed image at the caret', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('Hello\n')
    await editor.insertMarkdownAtCursor('\n\n![pic](attachments/2026-09/a.png)\n\n')
    const md = await editor.save()
    // Serialization keeps the original (vault-relative) src — display-side
    // resolution must never leak into the document model.
    expect(md).toContain('![pic](attachments/2026-09/a.png)')
    expect(md).toContain('Hello')
  })
})
