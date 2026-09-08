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
    expect(dom.tagName).toBe('H2')
    expect(dom.classList.contains('nk-heading')).toBe(true)
    expect(dom.querySelector('.nk-heading-anchor')).toBeTruthy()
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
    // The heading text must render into the content DOM (editable).
    expect(el.querySelector('h1')?.textContent).toContain('Hello World')

    anchor!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(write).toHaveBeenCalledWith('#hello-world')

    expect(await editor.save()).toBe(md)
    editor.destroy()
  })
})
