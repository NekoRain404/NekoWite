import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { basicPlugins, createEditor } from '../editor'
import { getCommand, getToolbar } from '../registry'
import { docCheck, placeCursor, tableCount, withTable } from '../testkit'
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

/**
 * A refused insert must not take the dialog with it.
 *
 * `insertMath` refuses display math inside a table cell — a block there is lifted
 * out by the fitter and SPLITS the table in two, the defect commit `6aefb19`
 * fixed. The refusal is right; what was wrong is that the dialog discarded the
 * answer and ran `cleanup()` in a `finally`, so a refusal was indistinguishable
 * from a success: the dialog closed, the document was unchanged, nothing was
 * said, and the LaTeX the user had just typed left with the disposed editor.
 *
 * What the fix owes the user is the formula, not an apology: the dialog stays
 * open with the text still in it and says why.
 */
describe('openMathDialog: a refused insert keeps the dialog and the formula', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  /** The dialog's 确定 button. */
  const confirmIn = (overlay: Element): HTMLButtonElement | undefined =>
    Array.from(overlay.querySelectorAll('button')).find((b) => b.textContent === '确定')

  /** Type into the dialog's field the way the fallback editor exposes its value. */
  const typeInto = (overlay: Element, latex: string): HTMLElement => {
    const host = overlay.querySelector('.math-field-host') as HTMLElement
    host.textContent = latex
    return host
  }

  it('keeps the dialog, the typed latex and the table when 块级 math is refused in a cell', async () => {
    const h = await withTable([
      ['H1', 'H2'],
      ['a', 'b'],
    ])
    try {
      placeCursor(h.view, 1, 0)
      const before = await h.ed.save()

      openMathDialog(h.view, { mode: 'inline' })
      const overlay = document.querySelector('.math-overlay') as HTMLElement
      // 块级 is live: the dialog was opened with no `existingPos`, so `setMode`
      // does not return early and the radios are not locked.
      const radios = Array.from(overlay.querySelectorAll<HTMLInputElement>('input[type=radio]'))
      radios[1].dispatchEvent(new MouseEvent('change', { bubbles: true }))
      typeInto(overlay, 'x^2')

      confirmIn(overlay)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      // The message is state, so it reaches the DOM on Vue's next flush.
      await nextTick()

      // Before the fix the overlay was already detached here, `x^2` was inside
      // it, and neither the document nor the user had heard anything.
      expect(overlay.isConnected, 'the dialog must survive a refused insert').toBe(true)
      expect(
        (overlay.querySelector('.math-field-host') as HTMLElement).textContent,
        'the typed latex is the whole point: it must still be there',
      ).toBe('x^2')
      expect(
        (overlay.querySelector('.math-dialog-refusal')?.textContent ?? '').trim(),
        'a refusal the user cannot see is the defect, not the fix',
      ).not.toBe('')
      expect(tableCount(h.view)).toBe(1)
      expect(await h.ed.save()).toBe(before)
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      document.querySelector('.math-overlay')?.remove()
      h.destroy()
    }
  })

  it('still inserts 行内 math from the same cell and disposes (the success path is unchanged)', async () => {
    const h = await withTable([
      ['H1', 'H2'],
      ['a', 'b'],
    ])
    try {
      placeCursor(h.view, 1, 0)
      openMathDialog(h.view, { mode: 'inline' })
      const overlay = document.querySelector('.math-overlay') as HTMLElement
      typeInto(overlay, 'c+d')

      confirmIn(overlay)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

      expect(document.querySelector('.math-overlay')).toBeNull()
      expect(tableCount(h.view)).toBe(1)
      expect(await h.ed.save()).toContain('$c+d$')
      expect(() => docCheck(h.view), 'document must stay valid').not.toThrow()
    } finally {
      document.querySelector('.math-overlay')?.remove()
      h.destroy()
    }
  })

  it('still inserts 块级 math outside a table and disposes', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = createEditor(el, { plugins: basicPlugins })
    await editor.open('')
    const view = editor.getView()

    openMathDialog(view, { mode: 'display' })
    const overlay = document.querySelector('.math-overlay') as HTMLElement
    typeInto(overlay, 'y^2')

    confirmIn(overlay)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(document.querySelector('.math-overlay')).toBeNull()
    const md = await editor.save()
    expect(md).toContain('$$')
    expect(md).toContain('y^2')
    editor.destroy()
    el.remove()
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
