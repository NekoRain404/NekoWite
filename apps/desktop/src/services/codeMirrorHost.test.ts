import { afterEach, describe, expect, it, vi } from 'vitest'
import { undo } from '@codemirror/commands'
import type { EditorView } from '@codemirror/view'
import { sourceExtensions } from './cmSourceView'
import { createCodeMirrorHost, type CodeMirrorHostHandle } from './codeMirrorHost'

// C8 regression coverage. The source pane keeps ONE CodeMirror instance across
// tab switches (view/SourcePane.vue mirrors the new tab into it), so whatever
// the instance carries over is carried into a DIFFERENT note: a stale undo entry
// that re-inserts text deleted in the previous note makes the debounced snapshot
// publish that text as the new note's body, and autosave writes it to the new
// note's file.

const NOTE_A = 'AAA note A body'
const NOTE_B = 'BBB note B body'

let host: CodeMirrorHostHandle | null = null

afterEach(() => {
  host?.destroy()
  host = null
  document.body.innerHTML = ''
})

function mount(doc: string, onChange: (value: string) => void = vi.fn()): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  host = createCodeMirrorHost({ doc, extensions: sourceExtensions(), onChange })
  host.mount(parent)
  const view = host.getView()
  if (!view) throw new Error('the host did not mount an EditorView')
  return view
}

describe('createCodeMirrorHost document swap', () => {
  it('does not resurrect the deleted text of the previous document on undo', () => {
    const view = mount(NOTE_A)
    // A deletion-class edit in note A: its inverse (re-insert "note ") is the
    // kind of history entry that stays executable after a document swap.
    view.dispatch({ changes: { from: 4, to: 9 } })
    expect(view.state.doc.toString()).toBe('AAA A body')

    host!.setText(NOTE_B)
    expect(view.state.doc.toString()).toBe(NOTE_B)

    // Ctrl+Z in note B. Whatever the history does, note A's deleted text must
    // never appear in note B.
    undo(view)
    expect(view.state.doc.toString()).toBe(NOTE_B)
  })

  it('still undoes edits made in the new document', () => {
    const view = mount(NOTE_A)
    view.dispatch({ changes: { from: 4, to: 9 } })
    host!.setText(NOTE_B)

    view.dispatch({ changes: { from: 0, insert: 'X' } })
    expect(view.state.doc.toString()).toBe(`X${NOTE_B}`)
    undo(view)
    expect(view.state.doc.toString()).toBe(NOTE_B)
  })

  it('drops the stack on an explicit reset even when the mirrored text is unchanged', () => {
    // Two notes can hold byte-identical text (a template, a duplicated file).
    // setText then has nothing to write, but the swap still happened.
    const view = mount(NOTE_A)
    view.dispatch({ changes: { from: 4, to: 9 } })
    host!.flush()
    host!.setText('AAA A body')
    host!.resetHistory()
    undo(view)
    expect(view.state.doc.toString()).toBe('AAA A body')
  })
})