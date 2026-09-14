/**
 * Plain text and CSV, read off the renderer's own output.
 *
 * The rule these cases hold to: the text an export produces is what the
 * document says, not a second reading of the Markdown that could disagree with
 * the HTML one. Every fixture here is shaped like the renderer's output
 * (`<body>`, a `<table>` of `<thead>`/`<tbody>`, `<pre>` blocks), not like
 * Markdown.
 */
import { describe, expect, it } from 'vitest'
import { csvField, htmlTablesToCsv, htmlToPlainText } from './export-text'

const doc = (body: string): string =>
  `<!DOCTYPE html><html><head><title>t</title><style>body{color:#222}</style></head><body>${body}</body></html>`

describe('htmlToPlainText', () => {
  it('keeps block boundaries as line breaks', () => {
    expect(htmlToPlainText(doc('<h1>Title</h1><p>One</p><p>Two</p>'))).toBe('Title\n\nOne\n\nTwo')
  })

  it('reads CJK without touching it', () => {
    expect(htmlToPlainText(doc('<p>这是一个中文段落。</p><p>English text.</p>'))).toBe('这是一个中文段落。\n\nEnglish text.')
  })

  it('preserves whitespace inside a code block', () => {
    // A code block flattened onto one line is a code block that no longer runs.
    const html = doc('<pre>def f():\n    return 1\n</pre>')
    expect(htmlToPlainText(html)).toBe('def f():\n    return 1')
  })

  it('collapses runs of whitespace inside a paragraph', () => {
    expect(htmlToPlainText(doc('<p>a\n    b\t\tc</p>'))).toBe('a b c')
  })

  it('turns a hard break into a line break', () => {
    expect(htmlToPlainText(doc('<p>one<br>two</p>'))).toBe('one\ntwo')
  })

  it('keeps an image\'s alt text rather than dropping the picture silently', () => {
    expect(htmlToPlainText(doc('<p>before <img src="a.png" alt="图表"> after</p>'))).toBe('before [图表] after')
  })

  it('leaves no trace of the stylesheet', () => {
    expect(htmlToPlainText(doc('<p>x</p>'))).not.toContain('color')
  })

  it('lists one item per line', () => {
    expect(htmlToPlainText(doc('<ul><li>一</li><li>two</li></ul>'))).toBe('一\n\ntwo')
  })

  it('renders a table as one line per row, cells separated by a space', () => {
    // The line has to stay the row: a cell break that became a newline would
    // leave a reader unable to tell which cell belonged to which row.
    const html = doc('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>')
    expect(htmlToPlainText(html)).toBe('A B\n\n1 2')
  })

  it('is empty for an empty document rather than throwing', () => {
    expect(htmlToPlainText(doc(''))).toBe('')
  })
})

describe('csvField', () => {
  it('leaves a plain value alone', () => {
    expect(csvField('plain')).toBe('plain')
  })

  it('quotes a value containing the delimiter', () => {
    expect(csvField('a,b')).toBe('"a,b"')
  })

  it('doubles a quote and wraps the value', () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
  })

  it('quotes a value with a newline', () => {
    expect(csvField('a\nb')).toBe('"a\nb"')
  })

  it('quotes leading or trailing space a reader would otherwise eat', () => {
    expect(csvField(' a')).toBe('" a"')
    expect(csvField('a ')).toBe('"a "')
  })

  it('leaves CJK unquoted, because nothing in it needs escaping', () => {
    expect(csvField('列一甲')).toBe('列一甲')
  })
})

describe('htmlTablesToCsv', () => {
  const table = (rows: string[][]): string =>
    `<table><thead><tr>${rows[0]!.map((c) => `<th>${c}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`

  it('is null when the document has no table at all', () => {
    // Not an empty string: the caller has to be able to tell "no table" from
    // "a table with nothing in it", and writing an empty file instead is the
    // failure this returns null to prevent.
    expect(htmlTablesToCsv(doc('<p>no tables here</p>'))).toBeNull()
  })

  it('maps the header row and the body rows straight across', () => {
    expect(htmlTablesToCsv(doc(table([['列一', 'Column two', '3'], ['甲乙丙', 'value', '42']]))))
      .toBe('列一,Column two,3\r\n甲乙丙,value,42\r\n')
  })

  it('carries the renderer\'s alignment without leaking it into the cell text', () => {
    const html = doc('<table><thead><tr><th style="text-align: right">N</th></tr></thead><tbody><tr><td style="text-align: right">7</td></tr></tbody></table>')
    expect(htmlTablesToCsv(html)).toBe('N\r\n7\r\n')
  })

  it('keeps several tables apart instead of splicing them into one grid', () => {
    const html = doc(table([['a'], ['1']]) + table([['b'], ['2']]))
    expect(htmlTablesToCsv(html)).toBe('a\r\n1\r\n\r\nb\r\n2\r\n')
  })

  it('separates a table with no header row from the one before it', () => {
    const html = doc('<table><tbody><tr><td>only</td></tr></tbody></table>')
    expect(htmlTablesToCsv(html)).toBe('only\r\n')
  })
})
