import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createMathEditor, renderLatexMarkup } from './atoms'

const { MFE, instances } = vi.hoisted(() => {
  type MockMathfield = HTMLElement & { value: string }
  const instances: MockMathfield[] = []
  class MockMFE extends HTMLElement {
    value = ''
    constructor() {
      super()
      instances.push(this)
    }
  }
  customElements.define('math-field-mock', MockMFE)
  return { MFE: MockMFE, instances }
})

vi.mock('mathlive', () => ({ MathfieldElement: MFE, convertLatexToMarkup: undefined }))

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
    expect(renderLatexMarkup('a < b')).toBe('a &lt; b')
  })
})

describe('createMathEditor', () => {
  beforeEach(() => {
    instances.length = 0
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses MathfieldElement and fires onChange on input', () => {
    const el = document.createElement('div')
    const onChange = vi.fn()
    const editor = createMathEditor(el, { value: 'x^2', onChange })
    expect(instances).toHaveLength(1)
    const mfe = instances[0]
    expect(mfe.value).toBe('x^2')
    mfe.dispatchEvent(new Event('input'))
    expect(onChange).toHaveBeenCalledWith('x^2')
    editor.setValue('y^3')
    expect(mfe.value).toBe('y^3')
    expect(editor.getValue()).toBe('y^3')
    expect(el.contains(mfe as unknown as Node)).toBe(true)
    editor.dispose()
    expect(el.contains(mfe as unknown as Node)).toBe(false)
  })

  it('contenteditable fallback fires onChange on input', () => {
    vi.stubGlobal('MathLive', {})
    const el = document.createElement('div')
    const onChange = vi.fn()
    const editor = createMathEditor(el, { value: 'a < b', onChange })
    expect(el.getAttribute('contenteditable')).toBe('true')
    el.dispatchEvent(new Event('input'))
    expect(onChange).toHaveBeenCalledWith('a < b')
    editor.setValue('c^2')
    expect(editor.getValue()).toBe('c^2')
    editor.dispose()
    expect(el.getAttribute('contenteditable')).toBeNull()
  })
})
