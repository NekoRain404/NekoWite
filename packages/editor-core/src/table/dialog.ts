import { createApp, h, ref, type App } from 'vue'
import type { EditorView } from '@milkdown/prose/view'

import { insertTable } from './plugin'

export interface TableDialogOptions {
  rows?: number
  cols?: number
}

/**
 * The sizes a GFM table can actually have.
 *
 * A table always has a header row plus at least one data row, so 2 is the real
 * floor for rows — and it has to be the floor of the STEPPER too. It used to be 1
 * there while `onConfirm` clamped to 2, so a user who asked for 1 row got a
 * 2-row table: the number on screen was silently not the number in the document.
 * The column floor stays 1 (a single-column table is valid GFM).
 */
export const TABLE_MIN_ROWS = 2
export const TABLE_MAX_ROWS = 50
export const TABLE_MIN_COLS = 1
export const TABLE_MAX_COLS = 30

/**
 * What the dialog says when `insertTable` refuses.
 *
 * The refusal is a caret inside a table cell, where a second table would be
 * lifted out by the fitter and split the host table in two, so the message names
 * the case and the way out instead of being a generic "could not insert".
 */
const REFUSED_IN_CELL =
  '不能在表格单元格内插入表格——它会把当前表格拆成两半。请关闭本对话框，把光标移到表格外，再插入。'

const clamp = (v: number, min: number, max: number): number =>
  Math.max(min, Math.min(Math.round(Number.isFinite(v) ? v : min), max))

/**
 * Show a rows × cols stepper dialog and insert the resulting GFM table at the
 * cursor. A single dialog interaction is a single undo step. Falls back to a
 * 2×2 default when the user confirms with the default values.
 */
export function openTableDialog(view: EditorView, opts: TableDialogOptions = {}): void {
  const overlay = document.createElement('div')
  overlay.className = 'table-overlay'
  document.body.appendChild(overlay)

  let app: App | null = null
  // The dialog's own message area, filled in only by a refused insert — the one
  // outcome that keeps the dialog open.
  const refusal = ref<string | null>(null)

  const cleanup = (): void => {
    app?.unmount()
    app = null
    overlay.remove()
  }

  const onConfirm = (rows: number, cols: number): void => {
    // Confirm must always do something visible. It used to require a COLLAPSED
    // selection, so confirming with text selected silently inserted nothing —
    // the dialog closed and the document was unchanged, with no explanation.
    // `insertTable` replaces the selection, which is what "insert a table"
    // means everywhere else (and matches the same command's behavior when the
    // caret is merely collapsed).
    const inserted = insertTable(
      view,
      clamp(rows, TABLE_MIN_ROWS, TABLE_MAX_ROWS),
      clamp(cols, TABLE_MIN_COLS, TABLE_MAX_COLS),
    )
    // A refusal (the caret is in a cell) used to be discarded: the dialog closed
    // on a document that had not changed and the user was told nothing. The
    // answer is now the reason the dialog stays up.
    if (!inserted) {
      refusal.value = REFUSED_IN_CELL
      return
    }
    cleanup()
  }

  app = createApp({
    setup() {
      // The initial values go through the same clamp as the steppers, so the
      // dialog shows a legal size even when the caller passes an impossible one.
      const rows = ref<number>(clamp(opts.rows ?? 3, TABLE_MIN_ROWS, TABLE_MAX_ROWS))
      const cols = ref<number>(clamp(opts.cols ?? 3, TABLE_MIN_COLS, TABLE_MAX_COLS))
      const inc = (target: 'rows' | 'cols', delta: number): void => {
        if (target === 'rows') {
          rows.value = clamp(rows.value + delta, TABLE_MIN_ROWS, TABLE_MAX_ROWS)
        } else {
          cols.value = clamp(cols.value + delta, TABLE_MIN_COLS, TABLE_MAX_COLS)
        }
      }
      return () =>
        h('div', { class: 'table-dialog', onClick: (e: MouseEvent) => e.stopPropagation() }, [
          h('div', { class: 'table-dialog-title' }, '插入表格'),
          h('div', { class: 'table-dialog-grid' }, [
            h('label', { class: 'table-dialog-field' }, [
              '行数',
              h('div', { class: 'table-dialog-stepper' }, [
                h('button', { type: 'button', onClick: () => inc('rows', -1) }, '−'),
                h('span', {}, String(rows.value)),
                h('button', { type: 'button', onClick: () => inc('rows', 1) }, '+'),
              ]),
            ]),
            h('label', { class: 'table-dialog-field' }, [
              '列数',
              h('div', { class: 'table-dialog-stepper' }, [
                h('button', { type: 'button', onClick: () => inc('cols', -1) }, '−'),
                h('span', {}, String(cols.value)),
                h('button', { type: 'button', onClick: () => inc('cols', 1) }, '+'),
              ]),
            ]),
          ]),
          // `role="alert"` so the refusal is announced, not just painted: the
          // dialog is not a native modal and focus does not move.
          refusal.value
            ? h('div', { class: 'table-dialog-refusal', role: 'alert' }, refusal.value)
            : null,
          h('div', { class: 'table-dialog-actions' }, [
            h('button', { onClick: () => cleanup() }, '取消'),
            h('button', { class: 'primary', onClick: () => onConfirm(rows.value, cols.value) }, '确定'),
          ]),
        ])
    },
  })

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cleanup()
  })
  app.mount(overlay)
  ;(overlay.firstElementChild as HTMLElement | null)?.focus?.()
}
