import { describe, expect, it, vi, afterEach } from 'vitest'
import { renderLatexMarkup } from './atoms'

describe('renderLatexMarkup', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns MathLive markup when available', () => {
    vi.stubGlobal('MathLive', { convertLatexToMarkup: (s: string) => `<math>${s}</math>` })
    expect(renderLatexMarkup('E=mc^2')).toBe('<math>E=mc^2</math>')
  })

  it('degrades to escaped latex when MathLive unavailable', () => {
    vi.stubGlobal('MathLive', undefined)
    expect(renderLatexMarkup('a < b')).toContain('a')
  })
})
