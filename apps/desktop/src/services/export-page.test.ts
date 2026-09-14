/**
 * The page's arithmetic, and the rule it produces.
 *
 * These are the numbers the printer and the preview both read, so a case here
 * is worth more than a screenshot of either: a preview whose page line sits
 * 4mm from the printer's is worse than no preview at all, and the only way to
 * know they agree is to check the one function they share.
 */
import { describe, expect, it } from 'vitest'
import {
  EXPORT_MARGIN_MM_DEFAULT,
  EXPORT_PAGE_SIZES,
  PX_PER_MM,
  clampMarginMm,
  exportPageCss,
  injectExportPageCss,
  pageBox,
  pageSizeMm,
} from './export-page'

describe('the paper sizes', () => {
  it('offers the five the export supports and no others', () => {
    expect([...EXPORT_PAGE_SIZES]).toEqual(['A3', 'A4', 'A5', 'Letter', 'Legal'])
  })

  it('quotes every size in millimetres, portrait', () => {
    for (const size of EXPORT_PAGE_SIZES) {
      const { width, height } = pageSizeMm(size)
      expect(width).toBeGreaterThan(0)
      expect(height).toBeGreaterThan(width)
    }
  })

  it('is ISO for the A series and US for Letter and Legal', () => {
    expect(pageSizeMm('A4')).toEqual({ width: 210, height: 297 })
    expect(pageSizeMm('A3')).toEqual({ width: 297, height: 420 })
    expect(pageSizeMm('A5')).toEqual({ width: 148, height: 210 })
    expect(pageSizeMm('Letter')).toEqual({ width: 215.9, height: 279.4 })
    expect(pageSizeMm('Legal')).toEqual({ width: 215.9, height: 355.6 })
  })
})

describe('pageBox', () => {
  it('gives A4 in CSS pixels at 96dpi', () => {
    const box = pageBox('A4', 'portrait', 0)
    expect(box.width).toBeCloseTo(210 * PX_PER_MM, 6)
    expect(box.height).toBeCloseTo(297 * PX_PER_MM, 6)
  })

  it('exchanges the sides for landscape rather than re-quoting the paper', () => {
    const portrait = pageBox('A4', 'portrait', 0)
    const landscape = pageBox('A4', 'landscape', 0)
    expect(landscape.width).toBeCloseTo(portrait.height, 6)
    expect(landscape.height).toBeCloseTo(portrait.width, 6)
  })

  it('takes the margin off all four sides', () => {
    const box = pageBox('A4', 'portrait', 20)
    const sheet = pageBox('A4', 'portrait', 0)
    expect(box.contentWidth).toBeCloseTo(sheet.width - 2 * 20 * PX_PER_MM, 6)
    expect(box.contentHeight).toBeCloseTo(sheet.height - 2 * 20 * PX_PER_MM, 6)
  })

  it('scales the sheet and the margin together, so a boundary lands in the same place', () => {
    const one = pageBox('A4', 'portrait', 15, 1)
    const half = pageBox('A4', 'portrait', 15, 0.5)
    expect(half.width).toBeCloseTo(one.width / 2, 6)
    expect(half.contentHeight).toBeCloseTo(one.contentHeight / 2, 6)
  })

  it('keeps a content box on the smallest sheet at the widest margin the UI allows', () => {
    // The clamp is what guarantees this, and it is why `pageBox` cannot produce
    // a content box of zero: A5's short side is 148mm and the margin is capped
    // at 50mm, so 48mm of column survives the worst case the settings allow.
    const box = pageBox('A5', 'portrait', 500)
    expect(box.contentWidth).toBeCloseTo(48 * PX_PER_MM, 6)
    expect(box.contentHeight).toBeCloseTo(110 * PX_PER_MM, 6)
  })
})

describe('clampMarginMm', () => {
  it('clamps rather than rejecting: a margin is not worth failing an export over', () => {
    expect(clampMarginMm(-5)).toBe(0)
    expect(clampMarginMm(999)).toBe(50)
    expect(clampMarginMm(Number.NaN)).toBe(EXPORT_MARGIN_MM_DEFAULT)
  })
})

describe('exportPageCss', () => {
  it('produces one @page rule carrying size, orientation and margin', () => {
    expect(exportPageCss('A4', 'portrait', 20)).toContain('@page{size:A4 portrait;margin:20mm;}')
  })

  it('carries every paper size as the name @page knows it', () => {
    for (const size of EXPORT_PAGE_SIZES) {
      expect(exportPageCss(size, 'landscape', 10)).toContain(`@page{size:${size} landscape;margin:10mm;}`)
    }
  })

  it('resets the renderer\'s window chrome', () => {
    // Without this the 2rem body padding stacks on top of the paper margin and
    // the number the user set is 8.47mm short of the number on the page.
    const css = exportPageCss('A4', 'portrait', 20)
    expect(css).toContain('body{margin:0;padding:0;max-width:none;}')
  })

  it('clamps the margin it is given, so a stale store cannot emit a rule the printer drops', () => {
    expect(exportPageCss('A4', 'portrait', -10)).toContain('margin:0mm;')
  })
})

describe('injectExportPageCss', () => {
  it('lands at the end of head, after the renderer\'s own stylesheet', () => {
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{padding:2rem}</style></head><body>x</body></html>'
    const out = injectExportPageCss(html, '@page{size:A4 portrait;margin:20mm;}')
    expect(out.indexOf('data-neko-export-page')).toBeGreaterThan(out.indexOf('body{padding:2rem}'))
    expect(out.indexOf('data-neko-export-page')).toBeLessThan(out.indexOf('</head>'))
    // The document is otherwise untouched.
    expect(out).toContain('<body>x</body>')
  })

  it('marks the style element, so the preview can rewrite it in place', () => {
    const out = injectExportPageCss('<html><head></head><body></body></html>', '@page{}')
    expect(out).toContain('data-neko-export-page')
  })

  it('still injects when there is no head to insert into', () => {
    expect(injectExportPageCss('<p>x</p>', '@page{}')).toContain('@page{}')
  })
})
