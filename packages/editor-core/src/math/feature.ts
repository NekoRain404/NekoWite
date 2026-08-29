import { editorViewCtx, EditorViewReady } from '@milkdown/core'
import type { MilkdownPlugin } from '@milkdown/ctx'
import type { EditorView } from '@milkdown/prose/view'

import { registerCommand, registerToolbar } from '../registry'
import { openMathDialog } from './dialog'

export const MATH_COMMAND_ID = 'math.insert'

let activeView: EditorView | null = null

export function insertMath(view: EditorView, latex: string, mode: 'inline' | 'display'): void {
  const { state } = view
  const type = mode === 'inline' ? state.schema.nodes.math_inline : state.schema.nodes.math_display
  if (!type) return
  const node = type.create({ latex })
  view.dispatch(state.tr.replaceSelectionWith(node))
}

export function mathFeature(): void {
  const run = (): void => {
    if (activeView) openMathDialog(activeView, { mode: 'inline' })
  }
  registerCommand({ id: MATH_COMMAND_ID, run })
  registerToolbar({ id: MATH_COMMAND_ID, label: '∑ f(x)', run })
}

export const mathFeaturePlugin: MilkdownPlugin = (ctx) => {
  return async () => {
    await ctx.wait(EditorViewReady)
    activeView = ctx.get(editorViewCtx)
  }
}

mathFeature()
