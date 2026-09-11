import { describe, expect, it } from 'vitest'
import { renderDocument } from './html'
import { slugify } from '../slugify'

describe('exported heading ids', () => {
  it('gives a heading the id its anchor link points at', () => {
    // The editor's heading anchors copy `#slug` deep links; without matching
    // ids in the export every one of those links is dead.
    const out = renderDocument('# Hello World\n')
    expect(out).toContain(`<h1 id="${slugify('Hello World')}">`)
    expect(out).toContain('id="hello-world"')
  })

  it('ids every heading level', () => {
    const out = renderDocument('# One\n\n## Two\n\n### Three\n')
    expect(out).toContain('<h1 id="one">')
    expect(out).toContain('<h2 id="two">')
    expect(out).toContain('<h3 id="three">')
  })

  it('de-duplicates a repeated title so the anchor is unambiguous', () => {
    const out = renderDocument('# Same\n\n# Same\n\n# Same\n')
    expect(out).toContain('<h1 id="same">')
    expect(out).toContain('<h1 id="same-1">')
    expect(out).toContain('<h1 id="same-2">')
  })

  it('slugs the heading TEXT, not its markup', () => {
    const out = renderDocument('# **Bold** and `code`\n')
    // Markup must not leak into the id (the editor slugs the plain text).
    expect(out).toContain(`id="${slugify('Bold and code')}"`)
  })

  it('escapes a quote so an id cannot break out of the attribute', () => {
    const out = renderDocument('# a" onmouseover=alert(1) x\n')
    expect(out).not.toContain('" onmouseover=')
  })

  it('keeps working for a heading that slugs to the fallback', () => {
    const out = renderDocument('# !!!\n')
    expect(out).toContain('<h1 id="section">')
  })
})
