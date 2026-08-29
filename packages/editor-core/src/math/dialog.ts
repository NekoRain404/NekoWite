import { createApp, h, ref, type App, type ComponentPublicInstance } from 'vue'
import type { EditorView } from '@milkdown/prose/view'
import type { Schema } from '@milkdown/prose/model'

import { createMathEditor, type MathEditorHandle } from './atoms'
import { insertMath } from './feature'

export interface OpenMathOptions {
  mode: 'inline' | 'display'
  latex?: string
  existingPos?: number | null
  schema?: Schema
}

export function openMathDialog(view: EditorView, opts: OpenMathOptions): void {
  const overlay = document.createElement('div')
  overlay.className = 'math-overlay'
  document.body.appendChild(overlay)

  let mf: MathEditorHandle | null = null
  let resolved: 'inline' | 'display' = opts.mode
  let app: App | null = null
  const isEditingExisting = opts.existingPos != null && opts.schema != null

  const cleanup = (): void => {
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
              if (el) mf = createMathEditor(el as HTMLElement, { value: opts.latex ?? '' })
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
