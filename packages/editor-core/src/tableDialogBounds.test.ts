import { afterEach, describe, expect, it } from 'vitest'

import { createEditor } from './editor'
import { basicPlugins } from './plugins/basic'
import {
  openTableDialog,
  TABLE_MAX_COLS,
  TABLE_MAX_ROWS,
  TABLE_MIN_COLS,
  TABLE_MIN_ROWS,
} from './table/dialog'

afterEach(() => {
  document.body.innerHTML = ''
})

async function makeEditor(md: string) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createEditor(el, { plugins: basicPlugins })
  await editor.open(md)
  await new Promise((r) => setTimeout(r, 0))
  return { editor, el }
}

/** Let Vue flush its queued re-render after a click. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Click the steppers until each field shows `rows`/`cols`, then confirm.
 *
 * The clicks are separated by a real tick: the dialog is a Vue component, and its
 * re-render is queued on the microtask queue, so reading the DOM synchronously
 * after `click()` would see the pre-click value.
 */
async function confirmWith(rows: number, cols: number): Promise<void> {
  const fields = [...document.querySelectorAll('.table-dialog-stepper')]
  expect(fields.length).toBe(2)
  const step = async (field: Element, target: number): Promise<void> => {
    const buttons = [...field.querySelectorAll('button')] as HTMLButtonElement[]
    const shown = (): number => Number(field.querySelector('span')?.textContent ?? '0')
    let guard = 0
    while (shown() !== target && guard++ < 200) {
      if (shown() > target) buttons[0].click()
      else buttons[1].click()
      await settle()
    }
    expect(shown()).toBe(target)
  }
  await step(fields[0], rows)
  await step(fields[1], cols)
  const ok = [...document.querySelectorAll('.table-dialog-actions button')].find(
    (b) => b.textContent?.trim() === '确定',
  ) as HTMLButtonElement
  ok.click()
}

/**
 * The dialog's stepper floor must match what confirm() actually inserts.
 *
 * It was 1 while `onConfirm` clamped rows to 2 (a GFM table always has a header
 * row plus at least one data row), so asking for 1 silently produced 2 — the
 * number on screen was not the number in the document. The stepper now stops at
 * the same floor.
 */
describe('D12: the table dialog shows the size it inserts', () => {
  it('uses the real GFM minimum for rows', () => {
    expect(TABLE_MIN_ROWS).toBe(2)
    expect(TABLE_MIN_ROWS).toBeLessThanOrEqual(TABLE_MAX_ROWS)
    expect(TABLE_MIN_COLS).toBeGreaterThanOrEqual(1)
    expect(TABLE_MIN_COLS).toBeLessThanOrEqual(TABLE_MAX_COLS)
  })

  it('the rows stepper cannot go below the GFM minimum', async () => {
    const { editor, el } = await makeEditor('# T\n\nbody\n')
    try {
      openTableDialog(editor.getView(), {})
      const rowsField = document.querySelectorAll('.table-dialog-stepper')[0]
      const minus = rowsField.querySelectorAll('button')[0] as HTMLButtonElement
      for (let i = 0; i < 10; i++) {
        minus.click()
        await settle()
      }
      expect(Number(rowsField.querySelector('span')?.textContent)).toBe(TABLE_MIN_ROWS)
    } finally {
      editor.destroy()
      el.remove()
    }
  })

  it('confirming with the minimum produces that many rows', async () => {
    const { editor, el } = await makeEditor('# T\n\nbody\n')
    try {
      openTableDialog(editor.getView(), {})
      await confirmWith(TABLE_MIN_ROWS, 2)
      const md = await editor.save()
      // Every line of a GFM table contains a pipe: header, the |---| separator,
      // then one line per data row.
      const lines = md.split('\n').filter((line) => line.includes('|'))
      expect(lines.length).toBe(TABLE_MIN_ROWS + 1)
    } finally {
      editor.destroy()
      el.remove()
    }
  })

  it('a request for 1 row is shown as the legal 2, not silently rewritten at confirm', async () => {
    const { editor, el } = await makeEditor('# T\n\nbody\n')
    try {
      openTableDialog(editor.getView(), { rows: 1, cols: 1 })
      const rowsField = document.querySelectorAll('.table-dialog-stepper')[0]
      // Whatever the caller passed, the field already shows a legal value.
      expect(Number(rowsField.querySelector('span')?.textContent)).toBe(TABLE_MIN_ROWS)
      await confirmWith(TABLE_MIN_ROWS, 1)
      const md = await editor.save()
      expect(md.split('\n').filter((line) => line.includes('|')).length).toBe(TABLE_MIN_ROWS + 1)
    } finally {
      editor.destroy()
      el.remove()
    }
  })
})
