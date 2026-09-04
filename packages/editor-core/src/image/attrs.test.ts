import { afterEach, describe, expect, it } from 'vitest'
import { undoDepth } from '@milkdown/prose/history'
import { NodeSelection } from '@milkdown/prose/state'

import { basicPlugins, createEditor } from '../editor'
import {
  deleteImageNode,
  getImageAttrs,
  restoreImageSize,
  updateImageAttrs,
} from './attrs'

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

function selectImage(view: import('@milkdown/prose/view').EditorView, pos: number): void {
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
}

afterEach(() => {
  document.body.innerHTML = ''
})

async function makeEditor(md: string): Promise<{
  editor: ReturnType<typeof createEditor>
  view: import('@milkdown/prose/view').EditorView
}> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createEditor(el, { plugins: basicPlugins })
  await editor.open(md)
  return { editor, view: editor.getView() }
}

describe('image attrs (property panel)', () => {
  it('writes alt, title, width, align in a single undo step', async () => {
    const { editor, view } = await makeEditor('![old](attachments/a.png)')
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)

    const before = undoDepth(view.state)
    const node = updateImageAttrs(view, pos, {
      alt: 'new alt',
      title: 'A caption',
      width: 320,
      align: 'center',
    })
    expect(node).toBeTruthy()

    const attrs = getImageAttrs(view, pos)
    expect(attrs?.alt).toBe('new alt')
    expect(attrs?.title).toBe('A caption')
    expect(attrs?.width).toBe(320)
    expect(attrs?.align).toBe('center')

    // ONE setNodeMarkup transaction -> exactly one undo step.
    expect(undoDepth(view.state)).toBe(before + 1)
    expect(await editor.save()).toContain(
      '![new alt](attachments/a.png "A caption"){width=320 align=center}',
    )
    editor.destroy()
  })

  it('restore size clears width/height back to intrinsic', async () => {
    const { editor, view } = await makeEditor('![a](attachments/a.png){width=480}')
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)
    restoreImageSize(view, pos)
    const attrs = getImageAttrs(view, pos)
    expect(attrs?.width).toBeNull()
    expect(await editor.save()).toBe('![a](attachments/a.png)\n')
    editor.destroy()
  })

  it('has no effect when pos is not an image', async () => {
    const { view } = await makeEditor('# Title\n')
    // Position 1 is inside the heading text node, not an image.
    const node = updateImageAttrs(view, 1, { alt: 'x' })
    expect(node).toBeNull()
    expect(getImageAttrs(view, 1)).toBeNull()
  })

  it('delete removes the image and is one undo step', async () => {
    const { editor, view } = await makeEditor('![a](attachments/a.png)')
    const pos = findImagePos(view.state.doc)
    selectImage(view, pos)
    const before = undoDepth(view.state)
    const ok = deleteImageNode(view, pos)
    expect(ok).toBe(true)
    expect(findImagePos.bind(null, view.state.doc)).toThrow()
    expect(undoDepth(view.state)).toBe(before + 1)
    expect(await editor.save()).not.toContain('](')
    editor.destroy()
  })

  it('serializes a proportional height and round-trips', async () => {
    const md = '![a](attachments/a.png){width=400 height=300 align=center}\n'
    const { editor } = await makeEditor(md)
    expect(await editor.save()).toBe(md)
    editor.destroy()
  })
})
