import { $mark } from '@milkdown/utils'

export const highlight = $mark('highlight', () => ({
  parseDOM: [{ tag: 'mark' }],
  toDOM: () => ['mark', { class: 'nk-highlight' }],
  parseMarkdown: {
    match: (node) => node.type === 'nekoHighlight',
    runner: (state, node, markType) => {
      state.openMark(markType)
      state.next(node.children)
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'highlight',
    runner: (state, mark) => {
      state.withMark(mark, 'highlight')
    },
  },
}))
