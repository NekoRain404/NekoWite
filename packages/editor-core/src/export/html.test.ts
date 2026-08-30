import { describe, expect, it } from 'vitest'
import { renderDocument } from './html'
import type { ExportRef } from './html'

describe('renderDocument', () => {
  it('renders headings, lists, links, code', () => {
    const html = renderDocument('# Title\n\n- a\n- b\n\n[link](https://x.dev)\n\n`code`\n')
    expect(html).toContain('<h1')
    expect(html).toContain('<li>')
    expect(html).toContain('href="https://x.dev"')
    expect(html).toContain('<code>')
  })

  it('renders katex math', () => {
    const html = renderDocument('Inline $E=mc^2$ and block:\n\n$$x^2$$\n')
    expect(html).toContain('katex')
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
})
