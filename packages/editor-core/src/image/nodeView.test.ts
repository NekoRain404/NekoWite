import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Node as ProseNode } from '@milkdown/prose/model'

import { configureImageResolver } from './resolver'
import { makeImageNodeView } from './nodeView'

/** Flush every pending microtask (resolver chain) before asserting. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// Real ProseMirror nodes share one type object per schema; mirror that so
// the nodeView's `newNode.type !== node.type` identity check behaves the same.
const IMAGE_TYPE = { name: 'image' }

function fakeNode(attrs: Record<string, string>): ProseNode {
  return {
    attrs,
    type: IMAGE_TYPE,
  } as unknown as ProseNode
}

function makeView(node: ProseNode): { dom: HTMLImageElement; update: (n: ProseNode) => boolean } {
  // The factory only reads `node`; the view/getPos args stay unused there.
  const spec = (makeImageNodeView as (n: ProseNode) => unknown)(node) as {
    dom: HTMLImageElement
    update: (n: ProseNode) => boolean
  }
  return spec
}

afterEach(() => {
  configureImageResolver(null)
})

describe('image node view', () => {
  it('renders an img with the raw document src when no resolver is set', () => {
    const { dom } = makeView(fakeNode({ src: 'attachments/a.png', alt: 'A', title: '' }))
    expect(dom.tagName).toBe('IMG')
    expect(dom.getAttribute('src')).toBe('attachments/a.png')
    expect(dom.getAttribute('alt')).toBe('A')
    expect(dom.hasAttribute('title')).toBe(false)
  })

  it('swaps in the resolved display URL asynchronously, keeping attrs intact', async () => {
    configureImageResolver(async () => 'data:image/png;base64,XYZ')
    const { dom } = makeView(fakeNode({ src: 'attachments/a.png', alt: 'A', title: 'T' }))
    expect(dom.getAttribute('src')).toBe('attachments/a.png')
    await flush()
    expect(dom.getAttribute('src')).toBe('data:image/png;base64,XYZ')
    expect(dom.getAttribute('alt')).toBe('A')
    expect(dom.getAttribute('title')).toBe('T')
  })

  it('applies a newer update and ignores the stale resolution result', async () => {
    configureImageResolver(async (src) => `resolved:${src}`)
    const node = fakeNode({ src: 'a.png', alt: '', title: '' })
    const { dom, update } = makeView(node)
    // Re-render with a different src before the first promise settles.
    const second = fakeNode({ src: 'b.png', alt: '', title: '' })
    expect(update(second)).toBe(true)
    await flush()
    expect(dom.getAttribute('src')).toBe('resolved:b.png')
  })

  it('rejects updates of a different node type', () => {
    const node = fakeNode({ src: 'a.png', alt: '', title: '' })
    const { update } = makeView(node)
    const other = { attrs: {}, type: { name: 'paragraph' } } as unknown as ProseNode
    expect(update(other)).toBe(false)  })

  it('renders an empty img for an empty src', () => {
    const { dom } = makeView(fakeNode({ src: '', alt: '', title: '' }))
    expect(dom.hasAttribute('src')).toBe(false)
  })

  it('never lets the async swap mutate the document model', async () => {
    const resolve = vi.fn(async () => 'data:image/png;base64,XYZ')
    configureImageResolver(resolve)
    const node = fakeNode({ src: 'attachments/a.png', alt: '', title: '' })
    makeView(node)
    await flush()
    // The node's attrs are untouched — serialization fidelity is preserved.
    expect(node.attrs.src).toBe('attachments/a.png')
  })
})
