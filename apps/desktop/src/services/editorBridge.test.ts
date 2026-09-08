import { describe, expect, it, vi } from 'vitest'
import { editorBridge } from './editorBridge'
import { insertCiteAtCursor } from './editorBridge'

describe('editorBridge', () => {
  it('inserts a cite node at cursor via the registered editor', () => {
    const dispatch = vi.fn()
    const state = {
      schema: { nodes: { cite: { create: vi.fn(() => ({ node: true })) } } },
      tr: { replaceSelectionWith: vi.fn(() => ({ ok: true })) },
    }
    editorBridge.setEditor({ getView: () => ({ state, dispatch }) } as never)
    insertCiteAtCursor('smith2020')
    expect(state.schema.nodes.cite.create).toHaveBeenCalledWith({ key: 'smith2020' })
    expect(state.tr.replaceSelectionWith).toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledWith({ ok: true })
    editorBridge.setEditor(null)
  })

  it('returns null view when no editor is registered or view is not ready', () => {
    editorBridge.setEditor(null)
    expect(editorBridge.getView()).toBeNull()
    editorBridge.setEditor({
      getView: () => {
        throw new Error('view not ready')
      },
    } as never)
    expect(editorBridge.getView()).toBeNull()
    editorBridge.setEditor(null)
  })

  it('no-ops when the cite node type is missing from the schema', () => {
    const dispatch = vi.fn()
    const state = {
      schema: { nodes: {} },
      tr: { replaceSelectionWith: vi.fn() },
    }
    editorBridge.setEditor({ getView: () => ({ state, dispatch }) } as never)
    insertCiteAtCursor('smith2020')
    expect(dispatch).not.toHaveBeenCalled()
    editorBridge.setEditor(null)
  })
})
