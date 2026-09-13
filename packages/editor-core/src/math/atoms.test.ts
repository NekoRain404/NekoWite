import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createMathEditor, createMathEditorWhenReady, renderLatexMarkup, upgradeMathEditor, warmMathLive } from './atoms'

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

  it('uses MathfieldElement and fires onChange on input', async () => {
    await warmMathLive()
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

describe('upgradeMathEditor', () => {
  beforeEach(() => {
    instances.length = 0
  })

  it('replaces the fallback with a MathLive field and carries the value over', async () => {
    // The fallback is what `createMathEditor` produces while MathLive is still
    // loading — always the case on the first open of the dialog. Without the
    // upgrade the user's first formula got a bare text box.
    const el = document.createElement('div')
    document.body.appendChild(el)
    // Simulate the fallback state: contenteditable plus a text node.
    el.setAttribute('contenteditable', 'true')
    el.textContent = 'x+1'

    const upgraded = await upgradeMathEditor(el, () => 'x+1')

    expect(upgraded).not.toBeNull()
    expect(el.getAttribute('contenteditable')).toBeNull()
    expect(el.textContent).toBe('')                    // fallback text removed
    expect(el.querySelector('math-field-mock')).not.toBeNull()
    expect(upgraded!.getValue()).toBe('x+1')           // value carried over
  })

  it('reads the value at SWAP time, not when the upgrade was requested', async () => {
    // The load is async, so anything typed while it is in flight must survive:
    // capturing the value at call time replaced the user's typing with whatever
    // was there before ('' on a freshly opened dialog).
    const el = document.createElement('div')
    document.body.appendChild(el)
    let typed = 'early'
    const pending = upgradeMathEditor(el, () => typed)
    typed = 'late'
    const upgraded = await pending
    expect(upgraded!.getValue()).toBe('late')
  })

  it('leaves the host untouched when MathLive is unavailable', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    el.setAttribute('contenteditable', 'true')
    el.textContent = 'y'
    vi.resetModules()
    vi.doMock('mathlive', () => ({ MathfieldElement: undefined, convertLatexToMarkup: undefined }))
    const mod = await import('./atoms')
    const upgraded = await mod.upgradeMathEditor(el, () => 'y')
    expect(upgraded).toBeNull()
    expect(el.getAttribute('contenteditable')).toBe('true')
    expect(el.textContent).toBe('y')
    vi.doUnmock('mathlive')
    vi.resetModules()
  })
})

describe('createMathEditorWhenReady', () => {
  it('produces a real MathLive field on the first call', async () => {
    instances.length = 0
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = await createMathEditorWhenReady(el, { value: 'a^2' })
    expect(editor).not.toBeNull()
    expect(el.querySelector('math-field-mock')).not.toBeNull()
    expect(editor!.getValue()).toBe('a^2')
  })
})
