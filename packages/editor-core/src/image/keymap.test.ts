import { afterEach, describe, expect, it } from 'vitest'
import { undoDepth } from '@milkdown/prose/history'
import { NodeSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'

import { basicPlugins, createEditor } from '../editor'

function findImagePos(doc: unknown): number {
  let pos: number | null = null
  ;(doc as import('@milkdown/prose/model').Node).descendants((n, p) => {
    if (n.type.name === 'image') {
      pos = p
      return false
    }
    return true
  })
  if (pos === null) throw new Error('no image found')
  return pos
}

function selectImage(view: EditorView, pos: number): void {
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
}

afterEach(() => {
  document.body.innerHTML = ''
})

async function makeEditor(md: string): Promise<{
  editor: ReturnType<typeof createEditor>
  view: EditorView
}> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createEditor(el, { plugins: basicPlugins })
  await editor.open(md)
  return { editor, view: editor.getView() }
}

describe('image keyboard width adjust', () => {
  it('arrow-right grows width by KEY_STEP in a single undo step', async () => {
    const { editor, view } = await makeEditor('![a](attachments/a.png){width=300}')
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)
    const before = undoDepth(view.state)

    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
    const handled = view.someProp('handleKeyDown', (f) => f(view, event))
    expect(handled).toBe(true)

    const node = view.state.doc.nodeAt(pos) as import('@milkdown/prose/model').Node
    expect(node.attrs.width).toBe(310)
    expect(undoDepth(view.state)).toBe(before + 1)
    expect(await editor.save()).toContain('{width=310}')
    editor.destroy()
  })

  it('shift+arrow-right locks aspect and stores both width and height', async () => {
    const { editor, view } = await makeEditor('![a](attachments/a.png){width=400 height=300}')
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)

    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true })
    view.someProp('handleKeyDown', (f) => f(view, event))

    const node = view.state.doc.nodeAt(pos) as import('@milkdown/prose/model').Node
    expect(node.attrs.width).toBe(410)
    expect(node.attrs.height).toBe(308) // 410 / (400/300)
    expect(await editor.save()).toContain('{width=410 height=308}')
    editor.destroy()
  })

  it('arrow-left shrinks width and clamps above 1px', async () => {
    const { view } = await makeEditor('![a](attachments/a.png){width=15}')
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)
    const event = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })
    view.someProp('handleKeyDown', (f) => f(view, event))
    const node = view.state.doc.nodeAt(pos) as import('@milkdown/prose/model').Node
    expect(node.attrs.width).toBeGreaterThanOrEqual(1)
  })

  it('does nothing when the selection is not an image node', async () => {
    const { view } = await makeEditor('# Heading\n')
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
    const handled = view.someProp('handleKeyDown', (f) => f(view, event))
    expect(handled ?? false).toBe(false)
  })
})
