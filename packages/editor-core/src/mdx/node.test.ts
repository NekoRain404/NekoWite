import { describe, expect, it } from 'vitest'
import { createEditor } from '../editor'
import { insertMdxComponent, mdxComponentToMarkdown } from './node'

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
  })
})
