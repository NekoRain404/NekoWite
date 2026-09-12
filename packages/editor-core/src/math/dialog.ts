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

export function openMathDialog(view: EditorView, opts: OpenMathOptions): void {
  warmMathLive()
  const overlay = document.createElement('div')
  overlay.className = 'math-overlay'
  document.body.appendChild(overlay)

  let mf: MathEditorHandle | null = null
  let resolved: 'inline' | 'display' = opts.mode
  let app: App | null = null
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
    try {
      const latex = mf?.getValue() ?? ''
      if (!latex.trim()) {
        cleanup()
        return
      }
      const nodeMode = isEditingExisting ? opts.mode : resolved
      if (opts.existingPos != null && opts.schema) {
        const tr = view.state.tr
        const nodeType =
          nodeMode === 'inline' ? opts.schema.nodes.math_inline : opts.schema.nodes.math_display
        const node = nodeType.create({ latex })
        view.dispatch(tr.replaceWith(opts.existingPos, opts.existingPos + 1, node))
      } else {
        insertMath(view, latex, nodeMode)
      }
    } finally {
      cleanup()
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
