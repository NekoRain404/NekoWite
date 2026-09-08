import { remarkStringifyOptionsCtx } from '@milkdown/core'
import type { MilkdownPlugin } from '@milkdown/ctx'

type RemarkState = {
  enter: (name: string) => () => void
  createTracker: (info: Record<string, unknown>) => {
    move: (value: string) => string
    current: () => Record<string, unknown>
  }
  containerPhrasing: (node: unknown, options?: Record<string, unknown>) => string
}

const highlightHandler = (
  node: unknown,
  _parent: unknown,
  state: RemarkState,
  info: Record<string, unknown>,
): string => {
  const exit = state.enter('highlight')
  const tracker = state.createTracker(info)
  let value = tracker.move('==')
  value += tracker.move(
    state.containerPhrasing(node, { before: value, after: '==', ...tracker.current() }),
  )
  value += tracker.move('==')
  exit()
  return value
}

// Register a custom remark-stringify handler so the editor's getMarkdown emits
// the `==text==` form for the highlight mark instead of dropping the delimiters.
export const highlightStringify: MilkdownPlugin = (ctx) => {
  ctx.update(remarkStringifyOptionsCtx, (prev) => ({
    ...prev,
    handlers: { ...prev.handlers, highlight: highlightHandler },
  }))
  return () => undefined
}
