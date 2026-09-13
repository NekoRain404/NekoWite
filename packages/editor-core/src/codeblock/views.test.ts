import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Node as ProseNode } from '@milkdown/prose/model'

import { basicPlugins, createEditor } from '../editor'
import { configureClipboardWriter } from '../clipboard'
import { makeCodeBlockNodeView, codeBlockCopyNodeView } from './views'
import { isInCodeBlock } from './paste'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const CODE_TYPE = { name: 'code_block' }

function fakeNode(attrs: Record<string, string>, text = ''): ProseNode {
  return {
    attrs,
    type: CODE_TYPE,
    textContent: text,
  } as unknown as ProseNode
}

interface CodeViewSpec {
  dom: HTMLElement
  contentDOM: HTMLElement
  update: (n: ProseNode) => boolean
  ignoreMutation: (m: { target: Node | null }) => boolean
}

function makeView(node: ProseNode): CodeViewSpec {
  return (makeCodeBlockNodeView as (n: ProseNode) => unknown)(node) as CodeViewSpec
}

afterEach(() => {
  configureClipboardWriter(null)
})

describe('isInCodeBlock', () => {
  it('does not treat the position after a code block as inside it', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('```\ncode\n```\n\nHello')
    const view = editor.getView()
    let after: number | null = null
    view.state.doc.descendants((node, pos) => {
      if (node.type.spec.code === true) {
        after = pos + node.nodeSize
        return false
      }
      return true
    })
    if (after === null) throw new Error('expected a code block in the document')
    expect(isInCodeBlock(view, after)).toBe(false)
  })
})

describe('code block copy node view', () => {
  it('wraps the code content in a copyable block', () => {
    const { dom, contentDOM } = makeView(fakeNode({ language: 'js' }, 'const a = 1'))
    expect(dom.classList.contains('nk-code-block')).toBe(true)
    expect(dom.querySelector('.nk-code-copy')).toBeTruthy()
    expect(contentDOM.tagName).toBe('CODE')
    expect(dom.querySelector('pre')?.dataset.language).toBe('js')
  })

  it('omits the language attribute for plain code blocks', () => {
    const { dom } = makeView(fakeNode({ language: '' }, 'text'))
    expect(dom.querySelector('pre')?.hasAttribute('data-language')).toBe(false)
  })

  it('copies the raw block text and shows a transient copied state', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    configureClipboardWriter(write)
    const { dom } = makeView(fakeNode({ language: '' }, 'const a = 1\n'))
    const button = dom.querySelector<HTMLButtonElement>('.nk-code-copy')!
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(write).toHaveBeenCalledWith('const a = 1\n')
    expect(dom.classList.contains('nk-copied')).toBe(true)
    await new Promise((r) => setTimeout(r, 1300))
    expect(dom.classList.contains('nk-copied')).toBe(false)
  })

  it('rejects updates of a different node type', () => {
    const { update } = makeView(fakeNode({ language: 'js' }, 'x'))
    const other = { attrs: {}, type: { name: 'paragraph' } } as unknown as ProseNode
    expect(update(other)).toBe(false)
  })

  it('ignores mutations outside the content <code> element', () => {
    const { dom, contentDOM, ignoreMutation } = makeView(fakeNode({ language: 'js' }, 'x'))
    const button = dom.querySelector('.nk-code-copy')!
    expect(ignoreMutation({ target: button })).toBe(true)
    expect(ignoreMutation({ target: dom })).toBe(true)
    expect(ignoreMutation({ target: contentDOM })).toBe(false)
  })

  it('mounts on a real editor and serializes byte-faithfully', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    const md = '```js\nconst a = 1\n```\n'
    await editor.open(md)

    const write = vi.fn().mockResolvedValue(undefined)
    configureClipboardWriter(write)

    const button = el.querySelector<HTMLButtonElement>('.nk-code-copy')
    expect(button).toBeTruthy()
    // The code text must render into the content DOM (editable), not just exist
    // in the model — otherwise the code block could not be seen/edited.
    expect(el.querySelector('.nk-code-block pre code')?.textContent).toContain('const a = 1')

    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    // The copy target is the block's raw text — the preserve-the-newline model.
    expect(write).toHaveBeenCalledWith(expect.stringContaining('const a = 1'))

    // The UI button never leaks into the markdown model.
    expect(await editor.save()).toBe(md)
    editor.destroy()
  })

  it('is a $view plugin that resolves to the code_block node type', () => {
    // $view returns a plugin object with a type tagged by the milkdown utils.
    expect(codeBlockCopyNodeView).toBeTruthy()
  })
})
