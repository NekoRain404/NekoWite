import { editorViewCtx, EditorViewReady } from '@milkdown/core'
import type { MilkdownPlugin } from '@milkdown/ctx'
import type { EditorView } from '@milkdown/prose/view'

import { registerCommand, registerMarkdownCommand, registerToolbar, unregisterCommand } from '../registry'
import { isInTableCell } from '../table/context'
import { openMathDialog } from './dialog'
import { mathToMarkdown } from './nodes'

export const MATH_COMMAND_ID = 'math.insert'

let activeView: EditorView | null = null

/**
 * Keep the dialog command's view reference in sync with the live editor.
 * createEditor sets it when the view is ready and clears it on destroy, so
 * the command can never dispatch into a dead view.
 */
export function setMathFeatureView(view: EditorView | null): void {
  activeView = view
}

/**
 * Insert a formula. Returns false when the insertion is not possible here.
 *
 * Inline math is an inline node and always fits. Display math is a BLOCK: inside a
 * table cell it would be lifted out by the fitter and split the table in two, so
 * it is refused — the caller reports that to the user instead of silently
 * rewriting the table.
 */
export function insertMath(view: EditorView, latex: string, mode: 'inline' | 'display'): boolean {
  const { state } = view
  const type = mode === 'inline' ? state.schema.nodes.math_inline : state.schema.nodes.math_display
  if (!type) return false
  if (mode === 'display' && isInTableCell(state)) return false
  const node = type.create({ latex })
  view.dispatch(state.tr.replaceSelectionWith(node))
  return true
}

export function mathFeature(): void {
  const run = (): void => {
    if (activeView) openMathDialog(activeView, { mode: 'inline' })
  }
  // `registerCommand` throws on a duplicate id; `registerToolbar` replaces in
  // place, so only the command needs the pre-clear. Unregistering the toolbar
  // entry first would move the button to the END of the toolbar instead.
  unregisterCommand(MATH_COMMAND_ID)
  registerCommand({ id: MATH_COMMAND_ID, run })
  registerToolbar({ id: MATH_COMMAND_ID, label: '∑ f(x)', run })
  // Source mode has no math node: insert the display-math Markdown with the
  // caret inside the delimiters, ready for the LaTeX to be typed.
  registerMarkdownCommand(MATH_COMMAND_ID, () => {
    const text = mathToMarkdown('', 'display')
    return { text, caret: text.indexOf('\n') + 1 }
  })
}

export const mathFeaturePlugin: MilkdownPlugin = (ctx) => {
  return async () => {
    await ctx.wait(EditorViewReady)
    activeView = ctx.get(editorViewCtx)
  }
}

mathFeature()
