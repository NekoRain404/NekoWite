import { describe, expect, it } from 'vitest'
import { renderDocument } from './html'
import { safeImageUrl, safeLinkUrl, urlScheme } from './url'

/** The href of the first anchor in `html`, or null when there is none. */
function firstHref(html: string): string | null {
  return /<a[^>]*\shref="([^"]*)"/.exec(html)?.[1] ?? null
}

/** The src of the first image in `html`, or null when there is none. */
function firstSrc(html: string): string | null {
  return /<img[^>]*\ssrc="([^"]*)"/.exec(html)?.[1] ?? null
}

describe('urlScheme', () => {
  it.each([
    ['javascript:alert(1)', 'javascript:'],
    ['JavaScript:alert(1)', 'javascript:'],
    ['https://example.test/a', 'https:'],
    ['mailto:a@b.test', 'mailto:'],
    ['data:image/png;base64,AA', 'data:'],
  ])('reads the scheme of %s', (url, expected) => {
    expect(urlScheme(url)).toBe(expected)
  })

  it.each(['notes/other.md', '/abs/path.md', '#anchor', './x.png', '../attachments/a.png'])(
    'treats %s as having no scheme',
    (url) => {
      expect(urlScheme(url)).toBeNull()
    },
  )

  it('sees through control characters a browser ignores', () => {
    // `java\tscript:` and `java\nscript:` both execute after the browser strips
    // the control character, so the check must strip it too.
    expect(urlScheme('java\tscript:alert(1)')).toBe('javascript:')
    expect(urlScheme('java\nscript:alert(1)')).toBe('javascript:')
    expect(urlScheme('jav\u0000ascript:alert(1)')).toBe('javascript:')
  })
})

describe('safeLinkUrl', () => {
  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://x.test/abc',
  ])('rejects %s', (url) => {
    expect(safeLinkUrl(url)).toBeNull()
  })

  it.each([
    'https://example.test/a',
    'http://example.test/a',
    'mailto:a@b.test',
    'tel:+123',
    'notes/other.md',
    '/abs/path.md',
    '#anchor',
  ])('allows %s', (url) => {
    expect(safeLinkUrl(url)).toBe(url)
  })

  it('returns null for empty input', () => {
    expect(safeLinkUrl('')).toBeNull()
    expect(safeLinkUrl(null)).toBeNull()
    expect(safeLinkUrl(undefined)).toBeNull()
    expect(safeLinkUrl('   ')).toBeNull()
  })
})

describe('safeImageUrl', () => {
  it('allows inline image data', () => {
    expect(safeImageUrl('data:image/png;base64,AA')).toBe('data:image/png;base64,AA')
  })

  it('rejects non-image and script-capable data payloads', () => {
    // A non-image payload would be a navigation hazard if the src is ever used
    // as a link, and SVG can carry script that runs when the payload is opened
    // as a document.
    expect(safeImageUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(safeImageUrl('data:image/svg+xml,<svg onload=alert(1)>')).toBeNull()
    // Raster formats have no such capability.
    expect(safeImageUrl('data:image/gif;base64,AA')).toBe('data:image/gif;base64,AA')
  })

  it.each(['javascript:alert(1)', 'vbscript:x', 'file:///etc/passwd'])('rejects %s', (url) => {
    expect(safeImageUrl(url)).toBeNull()
  })

  it('allows relative paths and http(s)', () => {
    expect(safeImageUrl('welcome_assets/pic.png')).toBe('welcome_assets/pic.png')
    expect(safeImageUrl('https://example.test/a.png')).toBe('https://example.test/a.png')
  })

  it('allows the asset URLs the app itself resolves to', () => {
    // Stripping these would blank every image in an export.
    expect(safeImageUrl('asset://localhost/a.png')).toBe('asset://localhost/a.png')
    expect(safeImageUrl('http://asset.localhost/C%3A/a.png')).toBe(
      'http://asset.localhost/C%3A/a.png',
    )
  })
})

describe('renderDocument link and image safety', () => {
  it('does not emit a javascript: href, keeping the text', () => {
    const out = renderDocument('[click me](javascript:alert(document.domain))\n')
    expect(firstHref(out)).toBeNull()
    expect(out).not.toContain('javascript:')
    // The link text survives, so nothing is silently dropped.
    expect(out).toContain('click me')
  })

  it('does not emit a data:text/html href', () => {
    const out = renderDocument('[x](data:text/html,<script>alert(1)</script>)\n')
    expect(firstHref(out)).toBeNull()
  })

  it('does not emit a javascript: image src', () => {
    const out = renderDocument('![a](javascript:alert(1))\n')
    expect(firstSrc(out)).toBeNull()
    // The alt text still identifies the image.
    expect(out).toContain('alt="a"')
  })

  it('keeps ordinary links and images working', () => {
    const link = renderDocument('[ok](https://example.test/a)\n')
    expect(firstHref(link)).toBe('https://example.test/a')
    const rel = renderDocument('[rel](notes/other.md)\n')
    expect(firstHref(rel)).toBe('notes/other.md')
    const img = renderDocument('![p](welcome_assets/pic.png)\n')
    expect(firstSrc(img)).toBe('welcome_assets/pic.png')
  })

  it('keeps an inlined image data URL', () => {
    const out = renderDocument('![p](data:image/png;base64,AA)\n')
    expect(firstSrc(out)).toBe('data:image/png;base64,AA')
  })

  it('escapes a quote so a URL cannot break out of the attribute', () => {
    const out = renderDocument('[x](https://example.test/a"onmouseover=alert(1))\n')
    expect(out).not.toContain('"onmouseover=')
  })

  it('sanitises a reference url from a bib entry', () => {
    const out = renderDocument('[@a]\n', {
      refs: new Map([['a', { key: 'a', title: 'T', url: 'javascript:alert(1)' }]]),
    })
    // A .bib file is user-supplied too. The URL degrades to inert text rather
    // than a destination; the string may still appear as escapeHtml'd text.
    expect(firstHref(out)).toBeNull()
    expect(out).not.toMatch(/href="[^"]*javascript:/i)
  })
})
