import { describe, expect, it, vi } from 'vitest'
import { basicPlugins, createEditor } from '../editor'
import { getCommand, getToolbar } from '../registry'
import { MATH_COMMAND_ID, insertMath } from './feature'
import { openMathDialog } from './dialog'

vi.mock('mathlive', () => ({ MathfieldElement: undefined, convertLatexToMarkup: undefined }))

const { MFE } = vi.hoisted(() => {
  class MockMFE extends HTMLElement {
    value = ''
  }
  customElements.define('math-field-first-open', MockMFE)
  return { MFE: MockMFE }
})

describe('insertMath', () => {
  it('inserts inline math that round-trips', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('# T\n\n\n')
    await new Promise((r) => setTimeout(r, 0))
    const view = editor.getView()
    view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.nodes.paragraph.create()))
    insertMath(view, 'a+b', 'inline')
    const md = await editor.save()
    expect(md).toContain('$a+b$')
    editor.destroy()
  })

  it('inserts display math that round-trips', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('')
    const view = editor.getView()
    insertMath(view, 'x^2', 'display')
    const md = await editor.save()
    expect(md).toContain('$$')
    expect(md).toContain('x^2')
    editor.destroy()
  })
})

describe('mathFeature', () => {
  it('registers the math.insert command', () => {
    expect(getCommand(MATH_COMMAND_ID)).toBeDefined()
  })

  it('registers a toolbar item labeled with the math symbol', () => {
    const item = getToolbar().find((t) => t.id === MATH_COMMAND_ID)
    expect(item).toBeDefined()
    expect(item?.label).toBe('∑ f(x)')
  })
})

describe('openMathDialog', () => {
  it('opens the overlay and cancel removes it', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('')
    const view = editor.getView()

    openMathDialog(view, { mode: 'inline' })
    const overlay = document.querySelector('.math-overlay')
    expect(overlay).not.toBeNull()

    const cancel = Array.from(overlay?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent === '取消',
    )
    cancel?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(document.querySelector('.math-overlay')).toBeNull()
    editor.destroy()
  })

  it('confirm inserts inline math from the editor field', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('')
    const view = editor.getView()

    openMathDialog(view, { mode: 'inline' })
    const overlay = document.querySelector('.math-overlay')
    const host = overlay?.querySelector('.math-field-host')
    if (host) host.textContent = 'a+b'

    const ok = Array.from(overlay?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent === '确定',
    )
    ok?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(document.querySelector('.math-overlay')).toBeNull()
    const md = await editor.save()
    expect(md).toContain('$a+b$')
    editor.destroy()
  })

  it('confirm with empty latex cancels without inserting', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('')
    const view = editor.getView()

    openMathDialog(view, { mode: 'inline' })
    const overlay = document.querySelector('.math-overlay')
    const ok = Array.from(overlay?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent === '确定',
    )
    ok?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(document.querySelector('.math-overlay')).toBeNull()
    const md = await editor.save()
    expect(md).not.toContain('$')
    editor.destroy()
  })

  it('confirm with existingPos replaces the node and preserves its mode', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('Before $a+b$ after')
    const view = editor.getView()

    let existingPos: number | null = null
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'math_inline') {
        existingPos = pos
        return false
      }
      return true
    })
    expect(existingPos).not.toBeNull()

    openMathDialog(view, { mode: 'inline', latex: 'a+b', existingPos, schema: view.state.schema })
    const overlay = document.querySelector('.math-overlay')
    const host = overlay?.querySelector('.math-field-host')
    if (host) host.textContent = 'c+d'

    const radios = Array.from(overlay?.querySelectorAll('input[type=radio]') ?? [])
    radios[1]?.dispatchEvent(new MouseEvent('change', { bubbles: true }))

    const ok = Array.from(overlay?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent === '确定',
    )
    ok?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(document.querySelector('.math-overlay')).toBeNull()
    const md = await editor.save()
    expect(md).toContain('$c+d$')
    expect(md).not.toContain('$a+b$')
    editor.destroy()
  })

  it('cancel disposes the math editor handle', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('')
    const view = editor.getView()

    openMathDialog(view, { mode: 'inline' })
    const overlay = document.querySelector('.math-overlay')
    const host = overlay?.querySelector('.math-field-host')
    if (host) host.setAttribute('contenteditable', 'true')

    const cancel = Array.from(overlay?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent === '取消',
    )
    cancel?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(host?.getAttribute('contenteditable')).toBeNull()
    editor.destroy()
  })
})

describe('openMathDialog with MathLive available', () => {
  it('puts a real MathLive field in the FIRST dialog it opens', async () => {
    // Regression: the dialog used to attach whatever editor was possible at that
    // instant, and on the first open MathLive had not finished its lazy import —
    // so the first formula a user wrote got a bare contenteditable box and the
    // visual editor only showed up on some later open.
    vi.resetModules()
    vi.doMock('mathlive', () => ({ MathfieldElement: MFE, convertLatexToMarkup: undefined }))
    const { openMathDialog: open } = await import('./dialog')
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('')
    const view = editor.getView()

    open(view, { mode: 'inline' })
    // The upgrade is asynchronous: it lands after the lazy import resolves.
    await vi.waitFor(() => {
      expect(document.querySelector('.math-overlay math-field-first-open')).not.toBeNull()
    })
    const host = document.querySelector('.math-field-host')
    expect(host?.getAttribute('contenteditable')).toBeNull()
    document.querySelector('.math-overlay button:last-child')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    vi.doUnmock('mathlive')
    vi.resetModules()
    editor.destroy()
  })

})
