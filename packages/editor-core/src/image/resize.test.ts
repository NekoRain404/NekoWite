import { describe, expect, it } from 'vitest'

import { clampWidth, nextWidth } from './resize'

describe('resize helpers', () => {
  it('clamps negative widths to 1px', () => {
    expect(clampWidth(-50)).toBe(1)
  })
  it('clamps to the maximum', () => {
    expect(clampWidth(9999, 2000)).toBe(2000)
  })
  it('rounds fractional widths', () => {
    expect(clampWidth(123.6)).toBe(124)
  })
  it('nextWidth applies the drag delta', () => {
    expect(nextWidth(300, 42)).toBe(342)
  })
  it('nextWidth shrinks when dragging left', () => {
    expect(nextWidth(300, -80)).toBe(220)
  })
})
