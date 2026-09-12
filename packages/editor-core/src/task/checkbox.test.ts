import { describe, expect, it } from 'vitest'

import { createEditor } from '../editor'
import type { NekoEditor } from '../editor'
import { basicPlugins } from '../plugins/basic'

async function setup(markdown: string): Promise<{ editor: NekoEditor; save: () => Promise<string> }> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createEditor(el, { plugins: basicPlugins })
  await editor.open(markdown)
  return { editor, save: async () => (await editor.save()).replace(/\n$/, '') }
}

function taskItems(editor: NekoEditor): HTMLElement[] {
  return [...editor.getView().dom.querySelectorAll<HTMLElement>('li[data-item-type="task"]')]
}

function click(li: HTMLElement, clientX: number, init: MouseEventInit = {}): void {
  li.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX, ...init }))
}

describe('task checkbox click', () => {
  it('renders a task item for `- [ ]`', async () => {
    const { editor } = await setup('- [ ] todo\n- [x] done\n')
    expect(taskItems(editor)).toHaveLength(2)
    expect(taskItems(editor)[0]!.getAttribute('data-checked')).toBe('false')
  })

  it('toggles an unchecked task when its box is clicked', async () => {
    const { editor, save } = await setup('- [ ] todo\n')
    click(taskItems(editor)[0]!, 2)
    expect(taskItems(editor)[0]!.getAttribute('data-checked')).toBe('true')
    expect(await save()).toBe('- [x] todo')
  })

  it('toggles a checked task back off', async () => {
    const { editor, save } = await setup('- [x] done\n')
    click(taskItems(editor)[0]!, 2)
    expect(taskItems(editor)[0]!.getAttribute('data-checked')).toBe('false')
    expect(await save()).toBe('- [ ] done')
  })

  it('ignores a click on the item text', async () => {
    const { editor, save } = await setup('- [ ] todo\n')
    click(taskItems(editor)[0]!, 400)
    expect(taskItems(editor)[0]!.getAttribute('data-checked')).toBe('false')
    expect(await save()).toBe('- [ ] todo')
  })

  it('ignores modifier clicks so selection keeps working', async () => {
    const { editor } = await setup('- [ ] todo\n')
    click(taskItems(editor)[0]!, 2, { shiftKey: true })
    click(taskItems(editor)[0]!, 2, { ctrlKey: true })
    click(taskItems(editor)[0]!, 2, { metaKey: true })
    click(taskItems(editor)[0]!, 2, { button: 2 })
    expect(taskItems(editor)[0]!.getAttribute('data-checked')).toBe('false')
  })

  it('is a single undo step', async () => {
    const { undo, undoDepth } = await import('@milkdown/prose/history')
    const { editor } = await setup('- [ ] todo\n')
    click(taskItems(editor)[0]!, 2)
    expect(undoDepth(editor.getView().state)).toBe(1)
    undo(editor.getView().state, (tr) => editor.getView().dispatch(tr))
    expect(taskItems(editor)[0]!.getAttribute('data-checked')).toBe('false')
  })

  it('toggles only the clicked item in a mixed list', async () => {
    const { editor, save } = await setup('- [ ] one\n- [x] two\n- [ ] three\n')
    click(taskItems(editor)[1]!, 2)
    expect(await save()).toBe('- [ ] one\n- [ ] two\n- [ ] three')
  })
})
