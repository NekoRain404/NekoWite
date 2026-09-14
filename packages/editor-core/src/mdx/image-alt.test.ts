import { describe, expect, it } from 'vitest'

import { createEditor } from '../editor'

/**
 * An image alt must not depend on which reader read the file.
 *
 * micromark computes `image.alt` from the label’s tokens, and the MDX token types
 * (`mdxJsxTextElement`, `mdxTextExpression`) are not types it counts, so an image
 * read as MDX had `alt: 'ab'` where the same bytes read as Markdown had
 * `alt: 'a<br/>b'`. The alt is a plain string the serializer writes back
 * verbatim, so the tag was silently gone from the file the next time the note was
 * saved — the one place in this package where opening a document could destroy
 * part of it. Titles, link text and definition titles were never affected: the
 * alt is the only field built out of a label’s inline content.
 *
 * The answer is not re-derived here. `mdx/document.ts` hands the image’s own
 * source back to the SAME processor the Markdown path uses — the copy taken
 * before the MDX extension went on — and takes its `alt`, so the two paths agree
 * by construction rather than by a second implementation that happens to match.
 * These tests compare the two readers directly for that reason: parity is the
 * property, and a corpus is what says it holds for more than the reported case.
 */

interface Reading {
  alt: string
  title: string
  saved: string
}

/** What each reader makes of the same bytes, and what it writes back. */
async function read(md: string, kind: 'md' | 'mdx'): Promise<Reading> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const ed = createEditor(el)
  try {
    await ed.open(md, kind === 'mdx' ? 'note.mdx' : 'note.md')
    let alt = ''
    let title = ''
    ed.getView().state.doc.descendants((node) => {
      if (node.type.name === 'image' && alt === '') {
        alt = String(node.attrs.alt ?? '')
        title = String(node.attrs.title ?? '')
        return false
      }
      return true
    })
    return { alt, title, saved: await ed.save() }
  } finally {
    ed.destroy()
    el.remove()
  }
}

/** The label as the two readers see it, saved as the two readers write it. */
async function bothWays(md: string): Promise<[Reading, Reading]> {
  return [await read(md, 'md'), await read(md, 'mdx')]
}

describe('an image alt reads the same whichever reader ran', () => {
  const corpus: Array<[string, string]> = [
    ['a void tag', '![a<br/>b](p.png)\n'],
    ['a paired tag', '![a<i>x</i>b](p.png)\n'],
    ['a component', '![a<Badge />b](p.png)\n'],
    ['an expression', '![a{x}b](p.png)\n'],
    ['an entity', '![a&amp;b](p.png)\n'],
    ['emphasis', '![a**b**c](p.png)\n'],
    ['a code span', '![a `c` b](p.png)\n'],
    ['balanced brackets', '![a[b]c](p.png)\n'],
    ['an escaped tag', '![a\\<br/>b](p.png)\n'],
    ['a reference image', '![a<br/>b][r]\n\n[r]: p.png\n'],
    ['a label across lines', '![a\n<br/>b](p.png)\n'],
    ['a title with a tag', '![alt](p.png "t<br/>u")\n'],
    // Constructs the MDX masker hides behind a same-length placeholder
    // (`mask.ts`): the reader that REPAIRS the alt must read the author's bytes,
    // not the placeholder, or the placeholder is what gets written back.
    ['an expression the masker hides', '![a{1 2}b](p.png)\n'],
    ['an image attribute expression', '![a{width=640 align=center}b](p.png)\n'],
    ['an autolink-looking tag', '![a<https://example.com>b](p.png)\n'],
    ['inside a list item', '- ![a<br/>b](p.png)\n'],
    ['inside a blockquote', '> ![a<br/>b](p.png)\n'],
    ['inside a table cell', '| ![a<br/>b](p.png) | c |\n| - | - |\n| x | y |\n'],
  ]

  for (const [label, md] of corpus) {
    it(label, async () => {
      const [markdown, mdx] = await bothWays(md)
      expect(mdx.alt, `${label}: alt`).toBe(markdown.alt)
      expect(mdx.saved, `${label}: saved bytes`).toBe(markdown.saved)
    })
  }

  it('keeps the tag, and every spelling of it', async () => {
    for (const marker of ['<br/>', '<br />', '<br>', '<br >']) {
      const md = `![a${marker}b](p.png)\n`
      const { alt, saved } = await read(md, 'mdx')
      expect(alt, marker).toBe(`a${marker}b`)
      expect(saved, marker).toContain('<br')
      // ... and the same bytes again on the next pass.
      const again = await read(saved, 'mdx')
      expect(again.alt, marker).toBe(`a${marker}b`)
      expect(await again.saved, marker).toBe(saved)
    }
  })

  it('still strips markup and resolves entities, as Markdown does', async () => {
    // The fix must not turn the label into raw source: what the Markdown reader
    // does with markup and entities is what both readers must keep doing.
    expect((await read('![a**b**c](p.png)\n', 'mdx')).alt).toBe('abc')
    expect((await read('![a&amp;b](p.png)\n', 'mdx')).alt).toBe('a&b')
  })
})
