import { describe, expect, it } from 'vitest'
import type { Node } from '@milkdown/prose/model'

import { basicPlugins, createEditor } from '../editor'
import { roundTrip } from '../serialize'
import { imageDimMarkdown } from './schema'

describe('imageDimMarkdown', () => {
  it('emits width and align', () => {
    expect(imageDimMarkdown(300, 'center')).toBe('{width=300 align=center}')
  })
  it('emits width only', () => {
    expect(imageDimMarkdown(300, null)).toBe('{width=300}')
  })
  it('emits align only', () => {
    expect(imageDimMarkdown(null, 'left')).toBe('{align=left}')
  })
  it('emits nothing when both are empty', () => {
    expect(imageDimMarkdown(null, null)).toBe('')
  })
})

describe('round-trip image dimensions', () => {
  it('preserves the trailing dimension block', () => {
    const md = '![a](http://x/a.png){width=300 align=center}\n'
    expect(roundTrip(md)).toBe(md)
  })
  it('preserves a plain image without dimensions', () => {
    const md = '![a](http://x/a.png)\n'
    expect(roundTrip(md)).toBe(md)
  })
})

function findImages(doc: Node): Node[] {
  const found: Node[] = []
  doc.descendants((n) => {
    if (n.type.name === 'image') found.push(n)
    return true
  })
  return found
}

describe('image dims editor integration', () => {
  it('extends the image schema with width/align attrs', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('![a](http://x/a.png)')
    const attrs = editor.getView().state.schema.nodes.image.spec.attrs ?? {}
    expect('width' in attrs).toBe(true)
    expect('align' in attrs).toBe(true)
    editor.destroy()
  })

  it('parses {width=300 align=center} into image attrs', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('![a](http://x/a.png){width=300 align=center}')

    const images = findImages(editor.getView().state.doc)
    expect(images.length).toBe(1)
    expect(images[0].attrs.width).toBe(300)
    expect(images[0].attrs.align).toBe('center')
    expect(await editor.save()).toContain('{width=300 align=center}')
    editor.destroy()
  })

  it('round-trips a resized image byte-faithfully', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    const md = '![a](attachments/a.png){width=480}\n'
    await editor.open(md)
    const images = findImages(editor.getView().state.doc)
    expect(images[0].attrs.width).toBe(480)
    expect(await editor.save()).toContain('![a](attachments/a.png){width=480}')
    editor.destroy()
  })
})
