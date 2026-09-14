import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import katexCss from 'katex/dist/katex.min.css?inline'
import { renderDocument, renderDocumentAsync } from './index'
import type { ExportImageTarget, ExportRef, RenderDocumentOptions } from './index'

/**
 * Byte-exact golden for the exporter.
 *
 * The export renderer's output is a *user artifact*: a file written to disk and
 * opened in a browser (or printed to PDF) somewhere the app is not running. Its
 * bytes are the contract, so a refactor of this module has to be provably
 * byte-neutral — attribute order, entity choice, whitespace and the stylesheet
 * all included. The tests beside this one assert `toContain`, which cannot see
 * a changed byte in text they do not name.
 *
 * The corpus below is deliberately the awkward half of the renderer rather than
 * a representative document: frontmatter, duplicate and markup-bearing headings,
 * hard breaks, task lists, reference-style links/images, aligned tables with
 * nested inline content, display and inline math, wikilinks, highlights,
 * citations (rich, plain, escaped and missing-from-the-map), footnotes, images
 * with each dimension and alignment attribute, mdx components with and without a
 * renderer, and the destinations the URL allowlist is supposed to reject.
 *
 * `renderDocumentAsync` is the entry point used for the corpus so the image
 * pre-pass is covered too; a separate case pins the sync path to the same bytes.
 *
 * `math: 'text'` (except for the KaTeX case at the end) keeps the golden
 * independent of process state: KaTeX is loaded into a module-level cache by the
 * first async render, so a KaTeX-mode document renders differently before and
 * after that happens. `includeCss` is off for all but one case — the print
 * stylesheet is a constant, and repeating it once per case would make every
 * future change to it a dozen-line edit that invites regenerating the golden
 * blind.
 */

// happy-dom installs its own global `URL`, which Node's `fileURLToPath` refuses,
// so the URL is flattened to its string form before it is converted.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'golden.html')

const COMPONENT_RENDERERS: Record<string, (props: Record<string, string>, childrenHtml: string) => string> = {
  Callout: (props, childrenHtml) =>
    `<aside class="callout callout-${props.type ?? 'info'}"><div class="callout-body">${childrenHtml}</div></aside>`,
  FloatBox: (_props, childrenHtml) => `<div class="float-box">${childrenHtml}</div>`,
}

const REFS = new Map<string, ExportRef>([
  [
    'smith2020',
    {
      key: 'smith2020',
      title: 'A Study of <Things>',
      authors: ['John Smith', 'Jane Doe', 'A. Third', 'B. Fourth'],
      year: '2020',
      journal: 'Journal of Testing',
      volume: '12',
      issue: '3',
      pages: '45-67',
      doi: '10.1000/abc',
    },
  ],
  ['doe2021', { key: 'doe2021', title: 'Plain Entry', authors: ['Doe'], year: '2021' }],
  ['escaped2022', { key: '<b>k</b>', title: 'T', authors: ['<script>x</script>'], year: '<i>2022</i>' }],
  ['web2023', { key: 'web2023', title: 'Web Source', url: 'javascript:alert(9)' }],
  ['pub2024', { key: 'pub2024', title: 'Published', publisher: 'ACME <Press>' }],
])

const BASE: RenderDocumentOptions = {
  refs: REFS,
  componentRenderers: COMPONENT_RENDERERS,
  math: 'text',
  includeCss: false,
}

/** Deterministic stand-in for the vault resolver. It records the `target` it was
 *  asked for in the URL it returns, so a case can pin which src form the two
 *  export paths request. */
const resolveImage = async (src: string, target: ExportImageTarget): Promise<string> =>
  target === 'data' ? `data:image/png;base64,RESOLVED-${target}-${src}` : `asset://localhost/RESOLVED-${target}-${src}`

type Case = [label: string, markdown: string, options?: RenderDocumentOptions]

const CASES: Case[] = [
  [
    'frontmatter and headings',
    [
      '---',
      'title: Export Corpse',
      'author: Neko',
      '---',
      '',
      '# Heading One',
      '',
      '## Heading One',
      '',
      '### **Bold** and `code` heading',
      '',
      '#### Claim [@smith2020]',
      '',
      '##### A [[Other Note|Alias]] B',
      '',
      '###### Formula $a^2$',
    ].join('\n'),
  ],
  [
    'frontmatter without a title',
    ['---', 'author: Nobody', '---', '', 'Body only.', ''].join('\n'),
  ],
  [
    'inline marks, breaks and raw html',
    [
      'Body with *em*, **strong**, `code`, ~~gone~~ and a [link](https://example.com/a?b=1&c=2).',
      '',
      'line one\\',
      'line two  ',
      'line three',
      '',
      '---',
      '',
      'Raw <span style="color:red">html</span> & an entity &amp; and an inline <br> break.',
      '',
      'A reference link [text][ref] and a reference image ![alt][img].',
      '',
      '![orphan][missing]',
      '',
      '[ref]: https://example.com/ref',
      '[img]: https://example.com/a.png',
    ].join('\n'),
  ],
  [
    'lists and task state',
    [
      '- item one',
      '- [x] done',
      '- [ ] todo',
      '',
      '1. first',
      '2. second',
      '',
      '5. five',
      '6. six',
      '',
      '- l1',
      '  - l2',
      '    - l3',
    ].join('\n'),
  ],
  [
    'blockquote nesting and code fence',
    [
      '> quoted text',
      '>',
      '> > inner',
      '',
      '```ts',
      'const a = 1 < 2 && "b"',
      '```',
      '',
      '```',
      'no language',
      '```',
    ].join('\n'),
  ],
  [
    'aligned table with nested content',
    [
      '| left | center | right | none |',
      '| :--- | :----: | ----: | ---- |',
      '| a | `code` | **bold** | [text](https://x.test) |',
      '| ==hi== | [[N\\|alias]] | [@doe2021] |  |',
      '| $z^2$ | ![alt](https://x.test/a.png) | - [x] done | <br /> |',
      '',
      '| only |',
      '| ---- |',
      '',
      'n[^1]',
      '',
      '[^1]: footnote with a definition',
    ].join('\n'),
  ],
  [
    'math inline and display',
    [
      'Inline $E = mc^2$ and another $x < y & z$.',
      '',
      '$$',
      '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
      '$$',
      '',
      '> math in a quote $y^2$',
      '',
      '- $$',
      '  Z = 1',
      '  $$',
    ].join('\n'),
  ],
  [
    'wikilinks, highlights and citations',
    [
      'See [[Other Note]] and [[Other Note|alias]] and [[Target With Spaces|label with spaces]].',
      '',
      'An empty alias [[OnlyTarget|]] stays.',
      '',
      'Marked ==text with *em* inside== and ==plain==.',
      '',
      'Citations: [@smith2020], [@doe2021], [@escaped2022], [@web2023], [@pub2024], [@missingkey]',
      'and again [@smith2020].',
    ].join('\n'),
  ],
  [
    'footnotes',
    [
      'Note[^1] and another[^2] and an unreferenced one below.',
      '',
      '[^1]: First definition with `code`.',
      '',
      '[^2]: Second with a [link](https://example.com/f).',
      '',
      '    - nested',
      '    - items',
      '',
      '[^unused]: never referenced',
    ].join('\n'),
  ],
  [
    'images with dimensions and alignment',
    [
      '![plain](https://example.com/a.png)',
      '',
      '![sized](https://example.com/b.png){width=300}',
      '',
      '![both](https://example.com/c.png){width=300 height=150}',
      '',
      '![centered](https://example.com/d.png){width=200 align=center}',
      '',
      '![left](https://example.com/e.png){width=200 align=left}',
      '',
      '![right](https://example.com/f.png){width=200 align=right}',
      '',
      '![titled](https://example.com/g.png "a title")',
      '',
      '![an <alt> with & markup](https://example.com/h.png){width=100}',
    ].join('\n'),
  ],
  [
    'destinations the allowlist rejects',
    [
      '[js](javascript:alert(1))',
      '',
      '[data](data:text/html,<script>alert(1)</script>)',
      '',
      '[vb](vbscript:msgbox(1))',
      '',
      '[jsx](jav&#x61;script:alert(2))',
      '',
      '[relative](notes/other.md)',
      '',
      '[absolute](/abs/path)',
      '',
      '[fragment](#anchor)',
      '',
      '[mail](mailto:a@b.c) and <tel:1234>',
      '',
      '![js-image](javascript:alert(3))',
      '',
      '![svg-payload](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)',
      '',
      '![svg-utf8](data:image/svg+xml,%3Csvg%20onload%3Dalert(4)%3E)',
      '',
      '![mime-prefix](data:image/pngx;base64,AAAA)',
      '',
      '![raster-ok](data:image/png;base64,AAAA)',
      '',
      '![already-inline]("onerror=alert(5))',
    ].join('\n'),
  ],
  [
    'mdx components',
    [
      '<Callout type="warn">Heads up with [@smith2020] and an ![in body](attachments/body.png)</Callout>',
      '',
      '<FloatBox>',
      '',
      '## Inside heading',
      '',
      'Body inside.',
      '',
      '</FloatBox>',
      '',
      '<Unknown thing={1}>raw body</Unknown>',
      '',
      '| a |',
      '| - |',
      '| <Callout>cell</Callout> |',
    ].join('\n'),
  ],
  [
    'empty paragraph markers',
    ['a', '', '<br />', '', 'b', '', '<br>', '', 'c', '', '<br >', '', '<br/>', '', 'end'].join('\n'),
  ],
  [
    'image resolution, display target',
    [
      '![relative](attachments/local.png)',
      '',
      '![already absolute](https://example.com/remote.png)',
      '',
      '<Callout>',
      '',
      '![in body](attachments/body.png)',
      '',
      '</Callout>',
      '',
      '- ![in list](attachments/list.png)',
    ].join('\n'),
    { ...BASE, resolveImage },
  ],
  [
    'image resolution, data target',
    [
      '![relative](attachments/local.png)',
      '',
      '![nested](../assets/deep/other.png){width=64}',
    ].join('\n'),
    { ...BASE, resolveImage, imageSrcTarget: 'data' },
  ],
  [
    'print stylesheet included once',
    ['# Styled', '', 'Body.', ''].join('\n'),
    { ...BASE, includeCss: true },
  ],
]

/** One corpus render: every case, prefixed with the label that produced it so a
 *  byte diff points at the case that changed rather than at an offset. */
async function renderCorpus(): Promise<string> {
  const parts: string[] = []
  for (const [label, markdown, options] of CASES) {
    const html = await renderDocumentAsync(markdown, options ?? BASE)
    parts.push(`<!-- case: ${label} -->\n${html}`)
  }
  return parts.join('\n')
}

describe('exporter golden output', () => {
  it('matches the fixture byte for byte', async () => {
    const actual = await renderCorpus()
    if (process.env.UPDATE_GOLDEN === '1') {
      writeFileSync(FIXTURE, actual)
    }
    expect(actual).toBe(readFileSync(FIXTURE, 'utf8'))
  })

  it('renders the same bytes through the synchronous entry point', async () => {
    // The two entry points differ only in the image pre-pass; with no resolver
    // they must agree exactly, or a caller gets different documents depending on
    // which one it happened to call.
    for (const [label, markdown, options] of CASES) {
      const opts = options ?? BASE
      if (opts.resolveImage) continue
      expect(renderDocument(markdown, opts), label).toBe(await renderDocumentAsync(markdown, opts))
    }
  })
})

describe('exporter golden output: KaTeX branch', () => {
  const MATH_DOC = ['Inline $E = mc^2$.', '', '$$', 'x^2', '$$', ''].join('\n')

  it('injects the KaTeX stylesheet ahead of the print stylesheet when math is rendered', async () => {
    const html = await renderDocumentAsync(MATH_DOC, { math: 'katex' })
    expect(html).toContain(`<style>${katexCss}`)
    expect(html).toContain('class="katex"')
  })

  it('leaves the KaTeX stylesheet out of a document with no math', async () => {
    const html = await renderDocumentAsync('No math here.\n', { math: 'katex' })
    expect(html).not.toContain('katex')
  })

  it('degrades to raw LaTeX when math is set to text', async () => {
    const html = await renderDocumentAsync(MATH_DOC, { math: 'text' })
    expect(html).toContain('<div class="math-latex">$$x^2$$</div>')
    expect(html).not.toContain('katex')
  })
})
