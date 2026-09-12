import { afterEach, describe, expect, it } from 'vitest'

import { createEditor } from '../editor'
import type { NekoEditor } from '../editor'
import { basicPlugins } from '../plugins/basic'
import { TASK_MARKER_ATTR, TASK_PLAIN_CLASS, configureTaskChecklistRendering } from './checkbox'

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

describe('task-list rendering setting', () => {
  // The switch is module state (see checkbox.ts), so every case must leave it
  // where the rest of the file expects it.
  afterEach(() => configureTaskChecklistRendering(true))

  it('renders the markdown marker as text and does not toggle when the boxes are off', async () => {
    configureTaskChecklistRendering(false)
    const { editor, save } = await setup('- [ ] todo\n- [x] done\n')

    const items = taskItems(editor)
    expect(items).toHaveLength(2)
    expect(items[0]!.classList.contains(TASK_PLAIN_CLASS)).toBe(true)
    // The marker rides on the item as an attribute (the stylesheet paints it),
    // so a checked item stays distinguishable from an unchecked one even though
    // the box is gone.
    expect(items[0]!.getAttribute(TASK_MARKER_ATTR)).toBe('[ ]')
    expect(items[1]!.getAttribute(TASK_MARKER_ATTR)).toBe('[x]')
    expect(items[0]!.textContent).toBe('todo')

    click(items[0]!, 2)
    expect(taskItems(editor)[0]!.getAttribute('data-checked')).toBe('false')
    expect(await save()).toBe('- [ ] todo\n- [x] done')
  })

  it('keeps the interactive box while the setting is on (default)', async () => {
    const { editor } = await setup('- [ ] todo\n')

    expect(taskItems(editor)[0]!.classList.contains(TASK_PLAIN_CLASS)).toBe(false)
    expect(taskItems(editor)[0]!.getAttribute(TASK_MARKER_ATTR)).toBeNull()
    click(taskItems(editor)[0]!, 2)
    expect(taskItems(editor)[0]!.getAttribute('data-checked')).toBe('true')
  })

  it('re-renders an editor that is already open when the setting flips', async () => {
    const { editor, save } = await setup('- [ ] todo\n')

    configureTaskChecklistRendering(false)
    const li = taskItems(editor)[0]!
    expect(li.classList.contains(TASK_PLAIN_CLASS)).toBe(true)
    expect(li.getAttribute(TASK_MARKER_ATTR)).toBe('[ ]')
    click(li, 2)
    expect(await save()).toBe('- [ ] todo')

    configureTaskChecklistRendering(true)
    expect(taskItems(editor)[0]!.classList.contains(TASK_PLAIN_CLASS)).toBe(false)
    expect(taskItems(editor)[0]!.getAttribute(TASK_MARKER_ATTR)).toBeNull()
    click(taskItems(editor)[0]!, 2)
    expect(await save()).toBe('- [x] todo')
  })
})
