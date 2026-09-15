import { createApp, h, ref, type App, type ComponentPublicInstance } from 'vue'
import type { EditorView } from '@milkdown/prose/view'
import type { Schema } from '@milkdown/prose/model'

import { createMathEditor, upgradeMathEditor, warmMathLive, type MathEditorHandle } from './atoms'
import { insertMath } from './feature'

export interface OpenMathOptions {
  mode: 'inline' | 'display'
  latex?: string
  existingPos?: number | null
  schema?: Schema
}

/**
 * What the dialog says when `insertMath` refuses.
 *
 * The only refusal reachable from here is display math inside a table cell
 * (`insertMath` has no other reason to say no, and this dialog is only opened
 * from a caret), so the message can name the case and the way out instead of
 * being a generic "could not insert".
 */
const REFUSED_IN_CELL =
  '表格单元格内不能插入块级公式 $$…$$——它会把表格拆成两半。请改用行内公式 $…$，或在表格外的位置插入。'

export function openMathDialog(view: EditorView, opts: OpenMathOptions): void {
  warmMathLive()
  const overlay = document.createElement('div')
  overlay.className = 'math-overlay'
  document.body.appendChild(overlay)

  let mf: MathEditorHandle | null = null
  let resolved: 'inline' | 'display' = opts.mode
  let app: App | null = null
  // The dialog's own message area, filled in only by a refused insert — the one
  // outcome that keeps the dialog open.
  const refusal = ref<string | null>(null)
  // Set once the dialog is closed, so an upgrade that resolves late does not
  // attach a MathLive field to a host that is already detached.
  let closed = false
  const isEditingExisting = opts.existingPos != null && opts.schema != null

  /**
   * Give the host a working editor immediately, then swap in MathLive once its
   * (lazily imported) module arrives.
   *
   * `createMathEditor` degrades to a plain contenteditable box while MathLive is
   * still loading — and on the FIRST open it always is, because the import only
   * starts here. Without the upgrade the visual editor appeared only on some
   * later open, so a user's first formula got a bare text field. Upgrading
   * instead of blocking keeps the dialog usable at once, and the text already
   * typed is carried across.
   */
  const attachEditor = (el: HTMLElement): void => {
    const options = { value: opts.latex ?? '' }
    mf = createMathEditor(el, options)
    void upgradeMathEditor(el, () => mf?.getValue() ?? '').then((better) => {
      if (!better) return
      if (closed || !overlay.isConnected) {
        better.dispose()
        return
      }
      // Read, swap, then dispose: the confirm handler reads `mf` at any moment,
      // and a window where it pointed at a disposed editor would drop the user's
      // formula on confirm.
      const typed = mf?.getValue() ?? ''
      const previous = mf
      better.setValue(typed)
      mf = better
      previous?.dispose()
    })
  }

  const cleanup = (): void => {
    closed = true
    mf?.dispose()
    mf = null
    app?.unmount()
    app = null
    overlay.remove()
  }

  const onConfirm = (): void => {
    // `dispose` stays false for exactly one outcome: a refused insert. The
    // dialog is the only place the typed LaTeX exists, so closing it would
    // destroy the user's work and any message afterwards would be an apology for
    // a loss. Every other outcome — an insert that landed, an empty field, a
    // throw from the dispatch — disposes, as it always has; a dialog that never
    // closes would be its own defect.
    let dispose = true
    try {
      const latex = mf?.getValue() ?? ''
      if (!latex.trim()) return
      const nodeMode = isEditingExisting ? opts.mode : resolved
      if (opts.existingPos != null && opts.schema) {
        const tr = view.state.tr
        const nodeType =
          nodeMode === 'inline' ? opts.schema.nodes.math_inline : opts.schema.nodes.math_display
        const node = nodeType.create({ latex })
        view.dispatch(tr.replaceWith(opts.existingPos, opts.existingPos + 1, node))
      } else if (!insertMath(view, latex, nodeMode)) {
        refusal.value = REFUSED_IN_CELL
        dispose = false
      }
    } finally {
      if (dispose) cleanup()
    }
  }

  const onCancel = (): void => {
    cleanup()
  }

  app = createApp({
    setup() {
      const mode = ref<'inline' | 'display'>(opts.mode)
      const setMode = (m: 'inline' | 'display'): void => {
        if (isEditingExisting) return
        resolved = m
        mode.value = m
        // The message describes the mode just left. Keeping it while the user
        // picks the one that would work would accuse the wrong action.
        refusal.value = null
      }
      return () =>
        h('div', { class: 'math-dialog', onClick: (e: MouseEvent) => e.stopPropagation() }, [
          h('div', { class: 'math-dialog-title' }, '插入 / 编辑公式'),
          h('div', {
            ref: (el: Element | ComponentPublicInstance | null) => {
              // Runs once when the host is created: attach the editor and queue
              // the MathLive upgrade.
              if (el && !mf) attachEditor(el as HTMLElement)
            },
            class: 'math-field-host',
          }),
          h('div', { class: 'math-mode-toggle' }, [
            h('label', [
              h('input', {
                type: 'radio',
                name: 'math-mode',
                checked: mode.value === 'inline',
                onChange: () => setMode('inline'),
              }),
              ' 行内 $..$',
            ]),
            h('label', [
              h('input', {
                type: 'radio',
                name: 'math-mode',
                checked: mode.value === 'display',
                onChange: () => setMode('display'),
              }),
              ' 块级 $$..$$',
            ]),
          ]),
          // `role="alert"` so the refusal is announced, not just painted: the
          // dialog is not a native modal and focus does not move.
          refusal.value
            ? h('div', { class: 'math-dialog-refusal', role: 'alert' }, refusal.value)
            : null,
          h('div', { class: 'math-actions' }, [
            h('button', { onClick: onCancel }, '取消'),
            h('button', { class: 'primary', onClick: onConfirm }, '确定'),
          ]),
        ])
    },
  })

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) onCancel()
  })
  app.mount(overlay)
  ;(overlay.firstElementChild as HTMLElement | null)?.focus?.()
}
