import { describe, expect, it } from 'vitest'

import { clampWidth, nextWidth, proportionalSize, safeRatio } from './resize'

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

describe('proportional (aspect-lock) resize', () => {
  it('derives height from the intrinsic ratio', () => {
    expect(proportionalSize(400, 300, 200)).toEqual({ width: 200, height: 150 })
  })
  it('keeps the ratio when scaling up', () => {
    expect(proportionalSize(400, 300, 800)).toEqual({ width: 800, height: 600 })
  })
  it('rounds the height to a whole pixel', () => {
    const { height } = proportionalSize(333, 123, 200)
    expect(Number.isInteger(height)).toBe(true)
  })
  it('guards against a zero/unmeasurable ratio (falls back to square)', () => {
    expect(safeRatio(0, 0)).toBe(1)
    expect(proportionalSize(0, 0, 100)).toEqual({ width: 100, height: 100 })
  })
  it('never produces a height below 1px', () => {
    const { height } = proportionalSize(2000, 2000, 1)
    expect(height).toBe(1)
  })
})
