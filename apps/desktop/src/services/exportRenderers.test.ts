import { describe, expect, it } from 'vitest'
import { buildComponentRenderers } from './exportRenderers'

describe('FloatBox renderer', () => {
  it('emits an absolutely-positioned div with props', () => {
    const out = buildComponentRenderers().FloatBox!(
      { x: '10', y: '20', w: '100', h: '50', angle: '15', z: '3' },
      '<p>hi</p>',
    )
    expect(out).toContain('position:absolute')
    expect(out).toContain('left:10px')
    expect(out).toContain('top:20px')
    expect(out).toContain('width:100px')
    expect(out).toContain('height:50px')
    expect(out).toContain('rotate(15deg)')
    expect(out).toContain('z-index:3')
    expect(out).toContain('<p>hi</p>')
  })

  it('applies defaults when props are empty', () => {
    const out = buildComponentRenderers().FloatBox!({}, '<p>hi</p>')
    expect(out).toContain('left:0px')
    expect(out).toContain('top:0px')
    expect(out).toContain('width:240px')
    expect(out).toContain('height:160px')
    expect(out).toContain('rotate(0deg)')
    expect(out).toContain('z-index:1')
  })
})