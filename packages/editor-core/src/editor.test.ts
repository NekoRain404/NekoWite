import { describe, expect, it } from 'vitest'

import { basicPlugins, createEditor, splitFrontmatter } from './editor'

describe('createEditor', () => {
  it('exposes open/save API', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('# Hello')
    const md = await editor.save()
    expect(md).toContain('# Hello')
  })

  it('recognises an empty frontmatter block', () => {
    const md = '---\n---\n\n# Body\n'
    const { front, body } = splitFrontmatter(md)
    expect(front).toBe('---\n---\n\n')
    expect(body).toBe('# Body\n')
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

  it('undo() then redo() restores, re-applies and restores the edited content', async () => {
    const { undo, redo, undoDepth, redoDepth } = await import('@milkdown/prose/history')
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('# Title\n\nSome body text.\n')
    const original = await editor.save()

    // A regular document-changing transaction is undoable (unlike open()).
    const view = editor.getView()
    view.dispatch(view.state.tr.insertText('EDITED'))
    const edited = await editor.save()
    expect(edited).not.toBe(original)
    expect(undoDepth(view.state)).toBeGreaterThan(0)

    // Undo: content returns to the opened document. The dispatch callback must
    // actually apply the undo transaction (a no-op callback works only for the
    // "nothing to undo" assertion above, where nothing is dispatched).
    const apply = (tr: Parameters<typeof view.dispatch>[0]) => view.dispatch(tr)
    expect(undo(view.state, apply)).toBe(true)
    expect(undoDepth(view.state)).toBe(0)
    expect(await editor.save()).toBe(original)

    // Redo: the edit re-applies.
    expect(redoDepth(view.state)).toBeGreaterThan(0)
    expect(redo(view.state, apply)).toBe(true)
    expect(await editor.save()).toBe(edited)

    // Undo again: back to the original once more.
    expect(undo(view.state, apply)).toBe(true)
    expect(await editor.save()).toBe(original)
    expect(redoDepth(view.state)).toBeGreaterThan(0)
  })

  it('fires onContentChange on a plain doc-changing dispatch (not only via markdownUpdated)', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('# Hello\n')
    let fired = 0
    editor.onContentChange(() => {
      fired++
    })
    // A plain typed-character transaction updates the DOM but may not re-derive
    // a *different* markdown string, so Milkdown's markdownUpdated does not
    // always fire. The content-sync + lifecycle emit(keyed off onContentChange)
    // must still run — keyed off ProseMirror's authoritative docChanged signal.
    const view = editor.getView()
    view.dispatch(view.state.tr.insertText(' world'))
    expect(fired).toBeGreaterThan(0)
    // And the change is observable through save().
    expect(await editor.save()).toContain('Hello world')
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
