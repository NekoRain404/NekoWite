import { createApp, h, ref, type App } from 'vue'
import type { EditorView } from '@milkdown/prose/view'

import { insertTable } from './plugin'

export interface TableDialogOptions {
  rows?: number
  cols?: number
}

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

  const cleanup = (): void => {
    app?.unmount()
    app = null
    overlay.remove()
  }

  const onConfirm = (rows: number, cols: number): void => {
    if (view.state.selection.from === view.state.selection.to) {
      insertTable(view, clamp(rows, 2, 50), clamp(cols, 1, 30))
    }
    cleanup()
  }

  app = createApp({
    setup() {
      const rows = ref<number>(opts.rows ?? 3)
      const cols = ref<number>(opts.cols ?? 3)
      const inc = (target: 'rows' | 'cols', delta: number): void => {
        const cur = target === 'rows' ? rows.value : cols.value
        const next = clamp(cur + delta, 1, 50)
        if (target === 'rows') rows.value = next
        else cols.value = next
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
