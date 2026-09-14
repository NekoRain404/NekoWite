import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import type { Node } from '@milkdown/prose/model'
import { createEditor } from '../editor'
import { registerComponent, unregisterComponent } from '../registry'
import { insertMdxComponent, mdxComponentToMarkdown, parseMdxTag } from './node'

const DummyCallout = defineComponent({
  props: { type: { type: String, default: 'info' }, children: { type: String, default: '' } },
  setup: (props) => () => h('aside', { class: `callout-${props.type}` }, props.children),
})

function findMdxComponent(doc: Node): Node | null {
  let found: Node | null = null
  doc.descendants((n) => {
    if (n.type.name === 'mdxComponent') {
      found = n
      return false
    }
    return true
  })
  return found
}

function findMdxComponentPos(doc: Node): number | null {
  let found: number | null = null
  doc.descendants((n, pos) => {
    if (n.type.name === 'mdxComponent') {
      found = pos
      return false
    }
    return true
  })
  return found
}

describe('parseMdxTag', () => {
  it('keeps attributes after a comparison inside a JSX expression', () => {
    const attrs = parseMdxTag('<Tag value={count > 0 ? "yes" : "no"} other="keep" />')
    expect(attrs.name).toBe('Tag')
    expect(attrs.props.other).toBe('keep')
  })

  it('does not treat a > inside nested braces as the tag closer', () => {
    const attrs = parseMdxTag('<Tag value={{ a: n > 1 }} other="keep" />')
    expect(attrs.props.other).toBe('keep')
  })

  it('still respects a > inside a quoted attribute value', () => {
    const attrs = parseMdxTag('<Tag title="a > b" other="keep" />')
    expect(attrs.props.title).toBe('a > b')
    expect(attrs.props.other).toBe('keep')
  })
})

describe('mdxComponentToMarkdown', () => {
  it('renders self-closing component', () => {
    expect(
      mdxComponentToMarkdown({ name: 'Callout', props: { type: 'info' }, children: '' })
    ).toBe('<Callout type="info" />')
  })
  it('renders component with children', () => {
    expect(
      mdxComponentToMarkdown({ name: 'Callout', props: {}, children: 'note' })
    ).toBe('<Callout>\n\nnote\n\n</Callout>')
  })

  // The source a node was parsed from is emitted verbatim only while it still
  // describes the node; see `rawIsCurrent`. These two pin both halves of that
  // rule: the form the author wrote survives, and an edit is not overwritten by
  // it.
  it('emits the captured source while the attrs still describe it', () => {
    expect(
      mdxComponentToMarkdown({
        name: 'FloatBox',
        props: { x: '20', y: '20' },
        children: '',
        raw: '<FloatBox  x="20" y="20"/>',
      })
    ).toBe('<FloatBox  x="20" y="20"/>')
  })
  it('re-serializes from the attrs once they no longer match the source', () => {
    expect(
      mdxComponentToMarkdown({
        name: 'FloatBox',
        props: { x: '99', y: '77' },
        children: '',
        raw: '<FloatBox x="20" y="20" />',
      })
    ).toBe('<FloatBox x="99" y="77" />')
  })
})

/**
 * Every FloatBox drag, resize, rotate and retext is a `setNodeMarkup` on the
 * `mdxComponent` node, and those transactions replace `attrs` while leaving the
 * captured source alone. The save wrote the source, so the edit was discarded:
 * the file kept the original coordinates and the box snapped back on reload.
 */
describe('an edited component is written back', () => {
  it('saves the moved coordinates, not the source the node was parsed from', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el)
    await editor.open('<FloatBox x="20" y="20" w="280" h="180" angle="0" z="1">box</FloatBox>\n')

    const view = editor.getView()
    const pos = findMdxComponentPos(view.state.doc)
    expect(pos).not.toBeNull()
    const node = view.state.doc.nodeAt(pos as number)
    // The transaction `updateFloatProps` dispatches on every drag frame.
    view.dispatch(
      view.state.tr.setNodeMarkup(pos as number, undefined, {
        ...node?.attrs,
        props: { ...(node?.attrs.props as Record<string, string>), x: '99', y: '77' },
      })
    )

    const md = await editor.save()
    expect(md).toContain('x="99"')
    expect(md).toContain('y="77"')
    expect(md).not.toContain('x="20"')
    editor.destroy()
  })
})

describe('insertMdxComponent', () => {
  it('inserts a node that round-trips through editor save', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el)
    await editor.open('')

    const view = editor.getView()
    insertMdxComponent(view, {
      name: 'Callout',
      props: { type: 'info' },
      children: 'note',
    })

    const md = await editor.save()
    expect(md).toContain('<Callout')
    expect(md).toContain('note')

    // True two-way round-trip: reopening the saved markdown must reconstruct
    // a real mdxComponent node (not degrade to plain paragraphs).
    await editor.open(md)
    const node = findMdxComponent(editor.getView().state.doc)
    expect(node).not.toBeNull()
    expect(node!.attrs.name).toBe('Callout')
    expect(node!.attrs.props).toEqual({ type: 'info' })
    expect((node!.attrs.children as string).trim()).toBe('note')
  })

  it('reconstructs a multiline component body on reopen', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el)
    const md = '<Callout type="warn">\n\nbold **body** here\n\n</Callout>'
    await editor.open(md)

    const node = findMdxComponent(editor.getView().state.doc)
    expect(node).not.toBeNull()
    expect(node!.attrs.name).toBe('Callout')
    expect(node!.attrs.props).toEqual({ type: 'warn' })
    expect((node!.attrs.children as string).trim()).toContain('bold **body** here')
  })
})

describe('inline component data-loss regression', () => {
  it('preserves leading text before an inline component', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el)
    const input = 'intro text <Callout>note</Callout>'
    await editor.open(input)
    const md = await editor.save()
    expect(md).toContain('intro text')
    expect(md).toContain('<Callout')
    expect(md).toContain('note')
    expect(md).toContain('</Callout>')

    await editor.open(md)
    const md2 = await editor.save()
    expect(md2).toContain('intro text')
    expect(md2).toContain('<Callout')
    expect(md2).toContain('note')
  })

  it('preserves trailing text after an inline component', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el)
    const input = '<Callout>note</Callout> tail text'
    await editor.open(input)
    const md = await editor.save()
    expect(md).toContain('<Callout')
    expect(md).toContain('note')
    expect(md).toContain('</Callout>')
    expect(md).toContain('tail text')

    await editor.open(md)
    const md2 = await editor.save()
    expect(md2).toContain('<Callout')
    expect(md2).toContain('note')
    expect(md2).toContain('tail text')
  })
})

describe('mdxComponent node view rendering', () => {
  it('renders a placeholder for an unregistered component without throwing', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el)
    await editor.open('<Note type="tip">hello</Note>')

    const host = el.querySelector('.mdx-component')
    expect(host).not.toBeNull()
    expect(host!.className).toContain('mdx-component-placeholder')
    const source = el.querySelector('.mdx-component-source')
    expect(source).not.toBeNull()
    expect(source!.textContent).toContain('hello')
    expect(source!.textContent).toContain('type="tip"')
  })

  it('renders the registered Vue component when its name matches', async () => {
    registerComponent('Callout', DummyCallout)
    try {
      const el = document.createElement('div')
      document.body.appendChild(el)
      const editor = createEditor(el)
      await editor.open('<Callout type="warn">\n\nrender me\n\n</Callout>')

      const host = el.querySelector('.mdx-component')
      expect(host).not.toBeNull()
      expect(host!.className).not.toContain('mdx-component-placeholder')
      const inner = el.querySelector('aside.callout-warn')
      expect(inner).not.toBeNull()
      expect(inner!.textContent).toContain('render me')
    } finally {
      unregisterComponent('Callout')
    }
  })
})
