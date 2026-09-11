import { describe, expect, it } from 'vitest'
import { renderDocument } from './html'

/** Just the document body, so assertions are not distracted by the stylesheet. */
function body(html: string): string {
  const start = html.indexOf('<body>')
  const end = html.lastIndexOf('</body>')
  return start >= 0 && end > start ? html.slice(start + 6, end) : html
}

/**
 * Every markdown node type has to survive an export.
 *
 * A node the renderer does not recognise falls through to
 * `renderChildren`, which returns an EMPTY string for a leaf node — so an
 * unhandled type disappears from the output silently rather than failing. That
 * is how display math was lost from every exported HTML/PDF: remark-math emits
 * `math`, but the renderer matched the non-existent `displayMath`.
 *
 * `math: 'text'` is used throughout so the result never depends on whether
 * KaTeX happens to be loaded in this process.
 */
const text = (md: string): string => body(renderDocument(md, { math: 'text' }))

describe('export renders every node type', () => {
  it('renders display math instead of dropping it', () => {
    // The regression: this used to render as an empty string.
    const out = text('$$\nE = mc^2\n$$\n')
    expect(out).toContain('E = mc^2')
    expect(out).toContain('math-latex')
  })

  it('renders inline math', () => {
    expect(text('text $a$ more\n')).toContain('<span class="math-latex">$a$</span>')
  })

  it('keeps a whole document intact (no node silently vanishes)', () => {
    const md = [
      '---',
      'title: T',
      '---',
      '',
      '# Heading',
      '',
      'Body with *em*, **strong**, `code` and a [link](https://x.test/a).',
      '',
      '- item one',
      '- item two',
      '',
      '> quoted',
      '',
      '```js',
      'const a = 1',
      '```',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '---',
      '',
      '$$',
      'E = mc^2',
      '$$',
      '',
    ].join('\n')
    const out = text(md)
    for (const fragment of [
      'title: T',
      'Heading',
      'em',
      'strong',
      'code',
      'https://x.test/a',
      'item one',
      'item two',
      'quoted',
      'const a = 1',
      '<table>',
      '<hr>',
      'E = mc^2',
    ]) {
      expect(out, `missing: ${fragment}`).toContain(fragment)
    }
  })
})

/**
 * The export pipeline only ran the mdx/cite/reference/image transforms, so
 * `==highlight==` and `[[wikilink]]` reached the renderer as raw text, and the
 * GFM footnote nodes reached it with no renderer case at all (a footnote
 * reference is a leaf, so `renderChildren` dropped it silently).
 */
describe('export keeps structured markdown features', () => {
  it('renders GFM task list state instead of dropping it', () => {
    const out = text('- [x] done\n- [ ] todo\n')
    expect(out).toContain('contains-task-list')
    expect(out).toContain('task-list-item')
    expect(out).toContain('checked')
    expect(out).toContain('done')
    expect(out).toContain('todo')
    expect(out).not.toContain('[x]')
    expect(out).not.toContain('[ ]')
  })

  it('renders a footnote reference and its definition as a numbered pair', () => {
    const out = text('Note[^1]\n\n[^1]: The definition\n')
    expect(out).toContain('class="footnote-ref"')
    expect(out).toContain('href="#fn-1"')
    expect(out).toContain('id="fn-1"')
    expect(out).toContain('href="#fnref-1"')
    expect(out).toContain('The definition')
    expect(out).not.toContain('[^1]')
  })

  it('renders ==highlight== as <mark> instead of leaking the delimiters', () => {
    const out = text('a ==marked== b\n')
    expect(out).toContain('<mark')
    expect(out).toContain('marked')
    expect(out).not.toContain('==')
  })

  it('renders [[wikilink|alias]] as a labelled link instead of leaking the brackets', () => {
    const out = text('see [[Other Note|alias]] now\n')
    expect(out).toContain('alias')
    expect(out).toContain('data-target="Other Note"')
    expect(out).not.toContain('[[')
  })
})

/**
 * Milkdown writes a standalone `<br />` where the document has an empty
 * paragraph, so that an intentional blank line survives a reopen, and removes
 * the marker again while parsing (`visitEmptyLine`). The editor therefore never
 * shows it. The export parses the raw file, so without the same step the marker
 * is escaped and printed as the literal text `<br />` — most visibly inside
 * every empty table cell, which is where the marker is written most often.
 */
describe('export hides the empty-paragraph marker', () => {
  it('drops a marker standing in for an empty paragraph', () => {
    const out = text('a\n\n<br />\n\nb\n')
    expect(out).toContain('<p>a</p>')
    expect(out).toContain('<p>b</p>')
    expect(out).not.toContain('br')
  })

  it('renders an empty table cell as empty instead of printing the marker', () => {
    const out = text('| a | b |\n| - | - |\n| <br /> | 2 |\n')
    expect(out).toContain('<td></td>')
    expect(out).not.toContain('br')
  })

  it('accepts every marker spelling milkdown strips', () => {
    for (const marker of ['<br />', '<br>', '<br >', '<br/>']) {
      expect(text(`a\n\n${marker}\n\nb\n`), marker).not.toContain('br')
    }
  })

  it('strips a marker nested in a block container', () => {
    // Exactly the bytes the editor writes for a blockquote holding an empty
    // paragraph between two filled ones.
    const out = text('> a\n>\n> <br />\n>\n> b\n')
    expect(out).not.toContain('br')
    expect(out).toContain('<blockquote>')
  })

  it('keeps a <br> the author wrote inline', () => {
    // Only a block-level marker stands in for an empty paragraph. A `<br>` next
    // to text is the author's inline HTML, which the export escapes like any
    // other raw HTML.
    const out = text('line one<br>line two\n')
    expect(out).toContain('&lt;br&gt;')
  })
})
