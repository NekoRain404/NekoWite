import { describe, expect, it } from 'vitest'
import { renderDocument } from './index'
import { slugify, headingAnchorIds } from '../slugify'
import { createEditor } from '../editor'

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

/**
 * The anchor button and the exported `id` must be derived from the SAME heading
 * text, or the link one produces does not resolve in the other. The editor
 * reads `textContent` off its rendered heading (that is what the user sees and
 * what the button's link is built from), so the export has to reproduce that
 * text — which is not the same as concatenating the Markdown source, because
 * some inline nodes are atoms that render without text and others carry their
 * label in an attribute rather than in `value`.
 */
describe('exported ids agree with the editor anchors', () => {
  const DOCS: Array<[string, string]> = [
    ['plain', '# One\n\n## Two\n'],
    ['duplicate titles', '# Same\n\n## Same\n\n### Same\n'],
    ['strong and code', '# **Bold** and `code`\n'],
    ['emphasis', '# *Em* text\n'],
    ['strikethrough', '# Text ~~gone~~\n'],
    ['highlight', '# ==marked== text\n'],
    ['link', '# See [text](https://x.test)\n'],
    ['wikilink aliased', '# Title [[Other Note|Alias]]\n'],
    ['wikilink plain', '# Title [[Other Note]]\n'],
    ['citation', '# Claim [@smith2020]\n'],
    ['footnote', '# Note[^1]\n\n## Plain\n\n[^1]: def\n'],
    ['inline math', '# Formula $a^2$\n'],
    ['image', '# Title ![alt](https://x.test/a.png)\n'],
    ['mdx component', '# Title <Callout type="info" />\n'],
    ['cjk', '# 中文 标题\n'],
    ['mixed atoms', '# A [[N|B]] C [@k] D $x$ E\n'],
  ]

  it('reports every divergent heading at once', async () => {
    const mismatches: Array<{ label: string; editor: string[]; exported: string[] }> = []
    for (const [label, md] of DOCS) {
      const el = document.createElement('div')
      document.body.appendChild(el)
      const ed = createEditor(el)
      try {
        await ed.open(md)
        const texts: string[] = []
        ed.getView().state.doc.descendants((child) => {
          if (child.type.name === 'heading') texts.push(child.textContent)
          return true
        })
        const editor = headingAnchorIds(texts)
        const html = renderDocument(md, { math: 'text' })
        const exported = [...html.matchAll(/<h[1-6] id="([^"]*)"/g)].map((m) => m[1])
        if (JSON.stringify(editor) !== JSON.stringify(exported)) {
          mismatches.push({ label, editor, exported })
        }
      } finally {
        ed.destroy()
        el.remove()
      }
    }
    expect(mismatches).toEqual([])
  })
})

/**
 * A heading inside an mdx component body is NOT a heading of the document: the
 * editor holds the component as an atom whose body is opaque source, so the
 * anchor buttons never enumerate it. The export rendered that body through the
 * same id list, so each heading in it consumed an id meant for a real document
 * heading — shifting every later id and duplicating the last one.
 */
describe('headings inside an mdx component body', () => {
  const renderers = {
    Box: (_props: Record<string, string>, children: string) =>
      `<section class="box">${children}</section>`,
  }

  it('does not consume a document anchor id', () => {
    const md = [
      '# Aaa',
      '',
      '# Bbb',
      '',
      '<Box>',
      '',
      '## Inside',
      '',
      '</Box>',
      '',
      '# Ccc',
      '',
    ].join('\n')
    const out = renderDocument(md, { componentRenderers: renderers, math: 'text' })
    // The real document headings keep the ids their own anchors point at.
    expect(out).toContain('<h1 id="aaa">Aaa</h1>')
    expect(out).toContain('<h1 id="bbb">Bbb</h1>')
    expect(out).toContain('<h1 id="ccc">Ccc</h1>')
    // The component body's heading is rendered, but carries no document anchor:
    // the editor offers no anchor button for it, so an id here would be a link
    // target nothing can ever produce.
    expect(out).toContain('<h2>Inside</h2>')
  })

  it('never emits the same document id twice', () => {
    const md = ['# Ccc', '', '<Box>', '', '## Unique', '', '</Box>', '', '# Ddd', ''].join('\n')
    const out = renderDocument(md, { componentRenderers: renderers, math: 'text' })
    const ids = [...out.matchAll(/<h[1-6] id="([^"]*)"/g)].map((m) => m[1])
    expect(ids).toEqual([...new Set(ids)])
    expect(ids).toEqual(['ccc', 'ddd'])
  })
})
