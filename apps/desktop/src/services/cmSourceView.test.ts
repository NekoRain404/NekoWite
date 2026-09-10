import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { sourceExtensions } from './cmSourceView'

type Binding = { key?: string; mac?: string; run?: (view: never) => boolean }

function bindings(doc = 'alpha'): { state: EditorState; bindings: Binding[] } {
  const state = EditorState.create({ doc, extensions: sourceExtensions() })
  return { state, bindings: state.facet(keymap).flat() as unknown as Binding[] }
}

/** Drive a binding against a minimal view; returns the resulting state. */
function apply(state: EditorState, binding: Binding): EditorState {
  let next = state
  const view = { state, dispatch: (tr: { state: EditorState }) => { next = tr.state } }
  binding.run?.(view as never)
  return next
}

describe('cmSourceView keymap', () => {
  it('binds Ctrl+Shift+Z, which the bundled history keymap only binds on Linux', () => {
    const { bindings: list } = bindings()
    expect(list.some((b) => b.key === 'Ctrl-Shift-z')).toBe(true)
    // The bundled history keymap still supplies Mod-y alongside it.
    expect(list.some((b) => b.key === 'Mod-y')).toBe(true)
  })

  it('redoes an undone edit through the Ctrl+Shift+Z binding', () => {
    const { state: initial, bindings: list } = bindings('alpha')
    const undoBinding = list.find((b) => b.key === 'Mod-z')!
    const redoBinding = list.find((b) => b.key === 'Ctrl-Shift-z')!

    // A user edit, then undo through the bundled binding.
    const edited = initial.update({ changes: { from: 5, insert: 'XYZ' } }).state
    expect(edited.doc.toString()).toBe('alphaXYZ')

    const undone = apply(edited, undoBinding)
    expect(undone.doc.toString()).toBe('alpha')

    // Redo must restore it on Windows too, not just under CM's linux flag.
    const redone = apply(undone, redoBinding)
    expect(redone.doc.toString()).toBe('alphaXYZ')
  })

  it('keeps Tab bound to indent rather than focus traversal', () => {
    const { bindings: list } = bindings()
    expect(list.find((b) => b.key === 'Tab')?.run).toBeTypeOf('function')
  })
})
