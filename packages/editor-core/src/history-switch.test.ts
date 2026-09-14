import { describe, expect, it } from 'vitest'
import { undo, undoDepth } from '@milkdown/prose/history'

import { createEditor } from './editor'

/**
 * Switching notes must not leave the PREVIOUS note's history armed.
 *
 * \`open()\` dispatched the new document with \`addToHistory: false\`, which kept
 * the load itself out of the undo stack but left everything typed in the old
 * note on it. The first Ctrl+Z after the switch therefore consumed that stale
 * event — \`undoDepth\` dropped from 1 to 0 and the new note did not change — so
 * undo looked broken. Rebuilding the editor state for the load gives the new
 * note its own (empty) history.
 */
describe('D8: undo after switching notes', () => {
  it('does not consume the previous note history on the first Ctrl+Z', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el)
    try {
      await editor.open('# Note A\n\nbody A\n')
      const view = editor.getView()
      view.dispatch(view.state.tr.insertText('typed in A'))
      expect(undoDepth(view.state)).toBeGreaterThan(0)

      await editor.open('# Note B\n\nbody B\n')
      expect(undoDepth(view.state)).toBe(0)

      const apply = (tr: Parameters<typeof view.dispatch>[0]) => view.dispatch(tr)
      const before = await editor.save()
      expect(undo(view.state, apply)).toBe(false)
      expect(undoDepth(view.state)).toBe(0)
      expect(await editor.save()).toBe(before)
    } finally {
      editor.destroy()
      el.remove()
    }
  })

  it('typing in the new note is undoable, and undo returns to the opened text', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el)
    try {
      await editor.open('# A\n')
      const view = editor.getView()
      view.dispatch(view.state.tr.insertText('A edit'))

      await editor.open('# B\n\nB body\n')
      const opened = await editor.save()
      view.dispatch(view.state.tr.insertText('B edit'))
      const edited = await editor.save()
      expect(edited).not.toBe(opened)

      const apply = (tr: Parameters<typeof view.dispatch>[0]) => view.dispatch(tr)
      expect(undo(view.state, apply)).toBe(true)
      expect(await editor.save()).toBe(opened)
      expect(undoDepth(view.state)).toBe(0)
    } finally {
      editor.destroy()
      el.remove()
    }
  })

  it('open() itself stays out of the history', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el)
    try {
      await editor.open('# First\n')
      await editor.open('# Second\n')
      const view = editor.getView()
      expect(undoDepth(view.state)).toBe(0)
      expect(view.state.doc.textContent).toContain('Second')
    } finally {
      editor.destroy()
      el.remove()
    }
  })
})
