import type { EditorView } from '@milkdown/prose/view'
import type { Schema } from '@milkdown/prose/model'

export interface OpenMathOptions {
  mode: 'inline' | 'display'
  latex?: string
  existingPos?: number | null
  schema?: Schema
}

export function openMathDialog(_view: EditorView, _opts: OpenMathOptions): void {
  void _view
  void _opts
  // TODO: implemented in Task 3. Keeping the node views compilable now.
}
