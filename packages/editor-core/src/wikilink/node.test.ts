import { describe, expect, it } from 'vitest'
import type { Node } from '@milkdown/prose/model'

import { basicPlugins, createEditor } from '../editor'
import { roundTrip } from '../serialize'
import { wikiLinkToMarkdown } from './node'

describe('wikiLinkToMarkdown', () => {
  it('renders a wikilink with an alias', () => {
    expect(wikiLinkToMarkdown('target', 'alias')).toBe('[[target|alias]]')
  })
  it('renders a wikilink without an alias', () => {
    expect(wikiLinkToMarkdown('target')).toBe('[[target]]')
  })
  it('ignores an empty alias', () => {
    expect(wikiLinkToMarkdown('target', '')).toBe('[[target]]')
  })
})

describe('round-trip wikilinks', () => {
  it('preserves a wikilink with an alias', () => {
    expect(roundTrip('[[a|b]]\n')).toBe('[[a|b]]\n')
  })
  it('preserves a lone wikilink', () => {
    expect(roundTrip('See [[solo]].\n')).toBe('See [[solo]].\n')
  })
  it('preserves mixed inline text', () => {
    const md = 'See [[a|b]] and [[c]] again.\n'
    expect(roundTrip(md)).toBe(md)
  })
})

function findWikilinks(doc: Node): Node[] {
  const found: Node[] = []
  doc.descendants((n) => {
    if (n.type.name === 'wikilink') found.push(n)
    return true
  })
  return found
}

describe('wikilink editor integration', () => {
  it('parses [[a|b]] into a wikilink node', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('See [[a|b]].')

    const links = findWikilinks(editor.getView().state.doc)
    expect(links.length).toBe(1)
    expect(links[0].attrs.target).toBe('a')
    expect(links[0].attrs.alias).toBe('b')
    expect(await editor.save()).toContain('[[a|b]]')
    editor.destroy()
  })

  it('parses a lone [[solo]] into a wikilink without alias', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('link to [[solo]].')

    const links = findWikilinks(editor.getView().state.doc)
    expect(links.length).toBe(1)
    expect(links[0].attrs.target).toBe('solo')
    expect(links[0].attrs.alias).toBe('')
    editor.destroy()
  })

  it('keeps an escaped \\[[a]] as literal text without creating a wikilink', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('literal \\[[a]] here.')
    const doc = editor.getView().state.doc
    expect(findWikilinks(doc).length).toBe(0)
    expect(doc.textContent).toContain('[[a]]')
    editor.destroy()
  })

  it('parses unescaped wikilinks around an escaped one', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('See [[a]] and \\[[b]] and [[c]].')
    const targets = findWikilinks(editor.getView().state.doc).map((n) => String(n.attrs.target))
    expect(targets).toEqual(['a', 'c'])
    editor.destroy()
  })
})
