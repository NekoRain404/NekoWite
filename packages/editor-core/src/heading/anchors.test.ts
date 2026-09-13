import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Node as ProseNode } from '@milkdown/prose/model'

import { basicPlugins, createEditor } from '../editor'
import { configureClipboardWriter } from '../clipboard'
import { configureHeadingAnchorUrl, makeHeadingAnchorNodeView } from './anchors'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function fakeNode(attrs: Record<string, number>, text = ''): ProseNode {
  return {
    attrs,
    type: { name: 'heading' },
    textContent: text,
  } as unknown as ProseNode
}

function makeView(node: ProseNode): {
  dom: HTMLElement
  contentDOM: HTMLElement
  update: (n: ProseNode) => boolean
} {
  return (makeHeadingAnchorNodeView as (n: ProseNode) => unknown)(node) as {
    dom: HTMLElement
    contentDOM: HTMLElement
    update: (n: ProseNode) => boolean
  }
}

afterEach(() => {
  configureClipboardWriter(null)
  configureHeadingAnchorUrl(null)
})

describe('heading anchor node view', () => {
  it('renders the heading tag matching its level with an anchor button', () => {
    const { dom } = makeView(fakeNode({ level: 2 }, 'Getting Started'))
    expect(dom.classList.contains('nk-heading')).toBe(true)
    // The wrapper carries the deep-link anchor; the actual heading element is
    // the editable content DOM.
    expect(dom.querySelector<HTMLElement>('.nk-heading-content')?.tagName).toBe('H2')
    expect(dom.querySelector('.nk-heading-anchor')).toBeTruthy()
  })

  it('keeps the anchor button outside the editable content DOM', () => {
    const { dom, contentDOM } = makeView(fakeNode({ level: 1 }, 'Hello'))
    // The editable heading text lives in the heading element; the "#" anchor is
    // an absolutely-positioned UI element in the wrapper, never inside
    // contentDOM. This keeps every editable pixel inside contentDOM so the
    // browser cannot place the caret in a non-content boundary.
    expect(contentDOM).not.toBe(dom)
    expect(contentDOM.tagName).toBe('H1')
    expect(contentDOM.classList.contains('nk-heading-content')).toBe(true)
    expect(contentDOM.parentElement).toBe(dom)
    expect(dom.querySelector('.nk-heading-anchor')?.parentElement).toBe(dom)
    expect(dom.querySelector('.nk-heading-anchor')).not.toContain(contentDOM)
  })

  it('copies the default `#slug` fragment on click', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    configureClipboardWriter(write)
    const { dom } = makeView(fakeNode({ level: 1 }, 'Hello World'))
    const anchor = dom.querySelector<HTMLButtonElement>('.nk-heading-anchor')!
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(write).toHaveBeenCalledWith('#hello-world')
  })

  it('uses the configured builder (e.g. vault/path) when set', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    configureClipboardWriter(write)
    configureHeadingAnchorUrl((slug) => `/vault/notes/readme.md#${slug}`)
    const { dom } = makeView(fakeNode({ level: 2 }, '第1章 引言'))
    const anchor = dom.querySelector<HTMLButtonElement>('.nk-heading-anchor')!
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(write).toHaveBeenCalledWith('/vault/notes/readme.md#第1章-引言')
  })

  it('rejects updates of a different node type', () => {
    const { update } = makeView(fakeNode({ level: 1 }, 'A'))
    const other = { attrs: {}, type: { name: 'paragraph' } } as unknown as ProseNode
    expect(update(other)).toBe(false)
  })

  it('mounts on a real editor and keeps serialization byte-faithful', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    const md = '# Hello World\n\nSome text.\n'
    await editor.open(md)

    const write = vi.fn().mockResolvedValue(undefined)
    configureClipboardWriter(write)

    const anchor = el.querySelector<HTMLButtonElement>('.nk-heading-anchor')
    expect(anchor).toBeTruthy()
    // The heading element is the editable content DOM; the anchor button sits in
    // the wrapper outside it, so it is never parsed as document content.
    expect(el.querySelector('.nk-heading .nk-heading-content')?.tagName).toBe('H1')
    expect(el.querySelector('h1')?.textContent).toContain('Hello World')

    anchor!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(write).toHaveBeenCalledWith('#hello-world')

    expect(await editor.save()).toBe(md)
    editor.destroy()
  })

  it('gives each duplicate heading its own link, on a real document', async () => {
    // Every "Same" used to copy `#same`, so the links from the second and third
    // headings all landed on the first. Each heading now copies the id it
    // actually owns, matching what the export emits.
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('# Same\n\n# Same\n\n# Same\n')

    const write = vi.fn().mockResolvedValue(undefined)
    configureClipboardWriter(write)

    const anchors = Array.from(el.querySelectorAll<HTMLButtonElement>('.nk-heading-anchor'))
    expect(anchors).toHaveLength(3)
    for (const anchor of anchors) {
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flush()
    }

    expect(write.mock.calls.map((call) => call[0])).toEqual(['#same', '#same-1', '#same-2'])
    editor.destroy()
  })

  it('falls back to the plain slug when it has no view to consult', async () => {
    // The node view is also constructible without a view (unit harnesses), and
    // must still produce a usable fragment rather than throwing.
    const write = vi.fn().mockResolvedValue(undefined)
    configureClipboardWriter(write)
    const { dom } = makeView(fakeNode({ level: 1 }, 'Hello World'))
    const anchor = dom.querySelector<HTMLButtonElement>('.nk-heading-anchor')!
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(write).toHaveBeenCalledWith('#hello-world')
  })
})
