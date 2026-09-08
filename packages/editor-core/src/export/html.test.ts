import { describe, expect, it, vi } from 'vitest'
import { renderDocument, renderDocumentAsync, formatReference, doiUrl } from './html'
import type { ExportRef } from './html'

describe('renderDocument', () => {
  // Kept first in this describe: it must run before any async render, since
  // the async entry point loads KaTeX into the module-level cache that the
  // synchronous path reuses. With KaTeX not yet loaded, sync math must throw.
  it('throws a clear error for math when KaTeX is not loaded', () => {
    expect(() => renderDocument('Inline $E=mc^2$\n')).toThrowError(/KaTeX is not loaded/)
  })

  it('renders headings, lists, links, code', () => {
    const html = renderDocument('# Title\n\n- a\n- b\n\n[link](https://x.dev)\n\n`code`\n')
    expect(html).toContain('<h1')
    expect(html).toContain('<li>')
    expect(html).toContain('href="https://x.dev"')
    expect(html).toContain('<code>')
  })

  it('renders katex math', async () => {
    const html = await renderDocumentAsync('Inline $E=mc^2$ and block:\n\n$$x^2$$\n')
    expect(html).toContain('katex')
  })

  // Runs after the async render above, so the module-level KaTeX instance is
  // already loaded: the sync path must reuse it and render math properly
  // (not degrade to raw LaTeX).
  it('renders katex math synchronously when KaTeX is already loaded', () => {
    const html = renderDocument('Inline $E=mc^2$\n')
    expect(html).toContain('katex')
    expect(html).not.toContain('math-latex')
    expect(html).not.toContain('$E=mc^2$')
  })

  it('numbers citations and appends reference list', () => {
    const refs = new Map<string, ExportRef>()
    refs.set('a', { key: 'a', title: 'Alpha', authors: ['Smith'], year: '2020' })
    refs.set('b', { key: 'b', title: 'Beta', authors: ['Doe'], year: '2021' })
    const html = renderDocument('See [@a] and [@b] and [@a].\n', { refs })
    expect(html).toContain('>1<')   // first [@a]
    expect(html).toContain('>2<')   // [@b]
    expect(html.match(/>1</g)).toHaveLength(2)  // repeat [@a] reuses 1, never 3
    expect(html).not.toContain('>3<')
    expect(html).toMatch(/参考文献/)
    expect(html).toContain('Alpha')
    expect(html).toContain('Beta')
  })

  it('renders mdx components via renderer map', () => {
    const renderers = { Callout: (props: Record<string, string>, childrenHtml: string) => `<aside class="callout callout-${props.type ?? 'info'}">${childrenHtml}</aside>` }
    const html = renderDocument('<Callout type="warn">Heads up</Callout>\n', { componentRenderers: renderers })
    expect(html).toContain('class="callout callout-warn"')
    expect(html).toContain('Heads up')
  })

  it('keeps citations inside mdx component children literal (aligned with editor)', () => {
    const refs = new Map<string, ExportRef>()
    refs.set('a', { key: 'a', title: 'Alpha', authors: ['Smith'], year: '2020' })
    const renderers = {
      Callout: (props: Record<string, string>, childrenHtml: string) =>
        `<aside class="callout callout-${props.type ?? 'info'}"><div class="callout-body">${childrenHtml}</div></aside>`,
    }
    const html = renderDocument('<Callout type="warn">See [@a]</Callout>\n\nSee [@a].\n', { refs, componentRenderers: renderers })
    // Component children render the literal [@a], NOT a numbered span.
    expect(html).toContain('callout-body"><p>See [@a]</p>')
    expect(html.match(/<span class="cite">/g)).toHaveLength(1) // only the main-body cite
    // The [@a] inside the component is NOT registered in the reference list.
    expect(html.match(/参考文献/)).toBeTruthy()
    expect(html.match(/<li>\[\d+\]/g)).toHaveLength(1) // only the main-body cite in refs
    expect(html).toContain('>1<') // main-body [@a] still numbered 1
    expect(html).not.toContain('>2<')
  })

  it('degrades math to latex when math=text', () => {
    const html = renderDocument('$E=mc^2$\n', { math: 'text' })
    expect(html).not.toContain('katex')
    expect(html).toContain('E=mc^2')
  })

  it('export body is positioned relative for floats', () => {
    const html = renderDocument('text')
    // printCss body includes position: relative so floats anchor to the body
    expect(html).toMatch(/body\s*{[^}]*position\s*:\s*relative/)
  })

  it('renders reference-style links/images resolved from their definitions', () => {
    const html = renderDocument(
      'See [text][ref] and ![alt][img].\n\n[ref]: https://example.com\n[img]: https://example.com/a.png\n',
    )
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('src="https://example.com/a.png"')
    expect(html).toContain('alt="alt"')
    expect(html).toContain('See <a href="https://example.com">text</a>')
  })

  it('renders journal italic and a DOI link in the reference list when metadata is present', () => {
    const refs = new Map<string, ExportRef>()
    refs.set('a', {
      key: 'a',
      title: 'Great Paper',
      authors: ['John Smith'],
      year: '2020',
      journal: 'Journal of Testing',
      volume: '12',
      issue: '3',
      pages: '45-67',
      doi: '10.1000/abc',
    })
    const html = renderDocument('See [@a].\n', { refs })
    expect(html).toContain('<em>Journal of Testing</em>')
    expect(html).toContain('href="https://doi.org/10.1000/abc"')
  })

  it('degrades to the plain numbered entry when a reference has no rich metadata', () => {
    const refs = new Map<string, ExportRef>()
    refs.set('a', { key: 'a', title: 'Alpha', authors: ['Smith'], year: '2020' })
    const html = renderDocument('See [@a].\n', { refs })
    expect(html).toContain('a — Alpha (Smith, 2020)')
    expect(html).not.toContain('<em>')
  })
})

describe('formatReference', () => {
  it('renders a full bibliography entry with italic journal and DOI link', () => {
    const s = formatReference({
      key: 'k',
      title: 'Great Paper',
      authors: ['John Smith', 'Jane Doe'],
      year: '2020',
      journal: 'Journal of Testing',
      volume: '12',
      issue: '3',
      pages: '45-67',
      doi: '10.1000/abc',
    })
    expect(s).toContain('John Smith')
    expect(s).toContain('2020')
    expect(s).toContain('<em>Journal of Testing</em>')
    expect(s).toContain('12(3)')
    expect(s).toContain('45-67')
    expect(s).toContain('href="https://doi.org/10.1000/abc"')
  })

  it('truncates to three authors with "et al."', () => {
    const s = formatReference({
      key: 'k',
      title: 'T',
      authors: ['A1', 'A2', 'A3', 'A4'],
      year: '2020',
      doi: '10.1000/x',
    })
    expect(s).toContain('A1, A2, A3, et al.')
  })

  it('degrades to key — title (authors, year) when no rich fields exist', () => {
    const s = formatReference({ key: 'a', title: 'Alpha', authors: ['Smith'], year: '2020' })
    expect(s).toBe('a — Alpha (Smith, 2020)')
  })
})

describe('doiUrl', () => {
  it('builds a doi.org link for a valid DOI', () => {
    expect(doiUrl('10.1000/xyz')).toBe('https://doi.org/10.1000/xyz')
  })

  it('normalizes an existing doi.org prefix', () => {
    expect(doiUrl('https://doi.org/10.1000/xyz')).toBe('https://doi.org/10.1000/xyz')
  })

  it('returns null for empty, missing or invalid DOIs', () => {
    expect(doiUrl('')).toBeNull()
    expect(doiUrl('not-a-doi')).toBeNull()
    expect(doiUrl(undefined)).toBeNull()
  })
})

describe('renderDocumentAsync', () => {
  it('resolves relative image srcs via resolveImage before rendering', async () => {
    const html = await renderDocumentAsync('![pic](attachments/a.png)\n', {
      resolveImage: async (src) => `data:image/png;base64,${src}`,
    })
    expect(html).toContain('src="data:image/png;base64,attachments/a.png"')
  })

  it('leaves absolute http(s)/data srcs untouched and keeps alt text', async () => {
    const resolve = vi.fn(async (src: string) => `resolved:${src}`)
    const html = await renderDocumentAsync(
      '![one](https://x.dev/a.png) ![two](attachments/a.png)\n',
      { resolveImage: resolve },
    )
    expect(html).toContain('src="https://x.dev/a.png"')
    expect(html).toContain('src="resolved:attachments/a.png"')
    expect(html).toContain('alt="one"')
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('keeps the raw src when the resolver rejects', async () => {
    const html = await renderDocumentAsync('![pic](attachments/a.png)\n', {
      resolveImage: async () => {
        throw new Error('boom')
      },
    })
    expect(html).toContain('src="attachments/a.png"')
  })

  it('resolves images nested inside lists', async () => {
    const html = await renderDocumentAsync('- ![pic](attachments/a.png)\n', {
      resolveImage: async () => 'asset://localhost/a.png',
    })
    expect(html).toContain('src="asset://localhost/a.png"')
  })

  it('matches the sync renderer output when no resolver is given', async () => {
    const md = '# Title\n\n- a\n\n![pic](attachments/a.png)\n'
    expect(await renderDocumentAsync(md)).toBe(renderDocument(md))
  })
})
