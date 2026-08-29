import { describe, expect, it, vi } from 'vitest'
import { basicPlugins, createEditor } from '../editor'
import { getCommand, getToolbar } from '../registry'
import { MATH_COMMAND_ID, insertMath } from './feature'
import { openMathDialog } from './dialog'

vi.mock('mathlive', () => ({ MathfieldElement: undefined, convertLatexToMarkup: undefined }))

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
})
