import { describe, expect, it } from 'vitest'

import { NoDocumentLoadedError, basicPlugins, createEditor, splitFrontmatter } from './editor'

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

  /**
   * M1/M3 (task-37) through the REPRODUCED shape: the report's steps are "open a
   * CRLF file, type one character, save" — a no-edit round trip is the corpus's
   * job (`mdx/byte-fidelity.test.ts`), and this is the save the user actually
   * makes.
   */
  describe('an edited document keeps the bytes the file came with', () => {
    const editAndSave = async (input: string): Promise<string> => {
      const el = document.createElement('div')
      document.body.appendChild(el)
      const editor = createEditor(el, { plugins: basicPlugins })
      try {
        await editor.open(input)
        const view = editor.getView()
        view.dispatch(view.state.tr.insertText('!', view.state.doc.content.size - 1))
        return await editor.save()
      } finally {
        editor.destroy()
        el.remove()
      }
    }

    it('writes a CRLF document back in CRLF, frontmatter included', async () => {
      expect(await editAndSave('---\r\ntitle: x\r\n---\r\n\r\nbody line\r\n')).toBe(
        '---\r\ntitle: x\r\n---\r\n\r\nbody line!\r\n',
      )
    })

    it('writes a BOM document back with its BOM', async () => {
      expect(await editAndSave('﻿# Title\r\n\r\nbody\r\n')).toBe(
        '﻿# Title\r\n\r\nbody!\r\n',
      )
    })
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

  /**
   * C1 (task-37 report, critical) — the editor-core half.
   *
   * `open()` committed the new file's frontmatter BEFORE the parse that can
   * throw, so a refused open left the editor holding the PREVIOUS document under
   * THIS file's frontmatter. `save()` then returned that chimera — the exact
   * string the P0 reproduction wrote to disk — or, in a session that had not
   * loaded a document yet, `""` (the app wrote 0 bytes).
   *
   * The shape now: an editor holds a document or it does not, and a load that
   * fails leaves it holding none. `save()` answers with the document it holds or
   * refuses; it can never answer with the one it does not hold.
   *
   * `DEEP` is the report's ~2 KB trigger. Since task-53 it is refused by the
   * open budget (open-budget.ts) before the parser is reached; the parser's own
   * `RangeError` on this shape is what that budget replaced. The two are the
   * same refusal as far as these tests are concerned — both throw from the same
   * place in `open()` — and the assertions are about what a refused open leaves
   * behind, not about which check refused it or about this particular input.
   */
  describe('a refused open', () => {
    const DEEP = '>'.repeat(2000) + ' deep\n'
    const NOTE_A = '---\ntitle: a\n---\n\n# Note A\n\nThe other note the user had open.\n'
    const BAD = '---\ntitle: bad\n---\n\n' + DEEP

    const mount = () => {
      const el = document.createElement('div')
      document.body.appendChild(el)
      return { el, editor: createEditor(el, { plugins: basicPlugins }) }
    }

    it('leaves nothing to save when it was the session’s first open', async () => {
      const { el, editor } = mount()
      try {
        await expect(editor.open(DEEP)).rejects.toThrow()
        // Not `""`: an empty string is what the app wrote over the 2 KB note.
        await expect(editor.save()).rejects.toThrow(NoDocumentLoadedError)
      } finally {
        editor.destroy()
        el.remove()
      }
    })

    it('leaves nothing to save when another document was loaded before it', async () => {
      const { el, editor } = mount()
      try {
        await editor.open(NOTE_A)
        expect(await editor.save()).toBe(NOTE_A)
        await expect(editor.open(BAD)).rejects.toThrow()
        // The previous document is NOT discarded — another caller's state (the
        // view, the undo stack, the caret) is still there…
        expect(editor.getView().state.doc.textContent).toContain('Note A')
        // …but it is not offered up as the content of the file that failed, with
        // or without that file's frontmatter glued on top.
        await expect(editor.save()).rejects.toThrow(NoDocumentLoadedError)
      } finally {
        editor.destroy()
        el.remove()
      }
    })

    it('saves again once an open succeeds', async () => {
      const { el, editor } = mount()
      try {
        await editor.open(NOTE_A)
        await expect(editor.open(BAD)).rejects.toThrow()
        await editor.open('# Fine\n')
        expect(await editor.save()).toBe('# Fine\n')
      } finally {
        editor.destroy()
        el.remove()
      }
    })

    it('refuses to save before anything has been opened at all', async () => {
      // The mount window: the pane exists and the user presses Ctrl+S before the
      // first document has loaded. There is no document to write, and an empty
      // one must not be written in its place.
      const { el, editor } = mount()
      try {
        await expect(editor.save()).rejects.toThrow(NoDocumentLoadedError)
      } finally {
        editor.destroy()
        el.remove()
      }
    })

    it('reads the document kind of the file that failed, not of the one it holds', async () => {
      // `mdxDocument` was committed before the parse too, so a refused `.mdx`
      // open left the Markdown document behind being re-serialized through the
      // MDX parser on the next save.
      const { el, editor } = mount()
      try {
        await editor.open('<Callout {...props} />\n')
        expect(await editor.save()).toBe('<Callout {...props} />\n')
        await expect(editor.open(BAD, '/vault/bad.mdx')).rejects.toThrow()
        await expect(editor.save()).rejects.toThrow(NoDocumentLoadedError)
      } finally {
        editor.destroy()
        el.remove()
      }
    })
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
