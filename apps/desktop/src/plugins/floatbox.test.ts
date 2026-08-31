import { describe, expect, it } from 'vitest'
import {
  applyDrag,
  applyResize,
  applyRotate,
  normalizeProps,
} from '../services/floatProps'

describe('floatbox geometry', () => {
  it('normalizes missing props', () => {
    expect(normalizeProps({})).toEqual({ x: 0, y: 0, w: 240, h: 160, angle: 0, z: 1 })
  })
  it('drag adds delta', () => {
    expect(applyDrag({ x: 10, y: 20 }, 5, -3)).toEqual({ x: 15, y: 17 })
  })
  it('se-resize grows w/h', () => {
    expect(applyResize({ x: 0, y: 0, w: 100, h: 50 }, 'se', 10, 20)).toEqual({ x: 0, y: 0, w: 110, h: 70 })
  })
  it('nw-resize shifts x/y and grows', () => {
    expect(applyResize({ x: 50, y: 40, w: 100, h: 50 }, 'nw', -5, -10)).toEqual({ x: 45, y: 30, w: 105, h: 60 })
  })
  it('resize clamps minimum size', () => {
    expect(applyResize({ x: 0, y: 0, w: 30, h: 30 }, 'se', -100, -100)).toEqual({ x: 0, y: 0, w: 20, h: 20 })
  })
  it('rotate adds angle delta', () => {
    expect(applyRotate({ angle: 15 }, 5)).toEqual({ angle: 20 })
  })
})