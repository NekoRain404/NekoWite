import { $node } from '@milkdown/utils'

export interface MathAttrs {
  latex: string
}

export function mathToMarkdown(latex: string, mode: 'inline' | 'display'): string {
  if (mode === 'inline') return `$${latex}$`
  return `$$\n${latex}\n$$`
}

const inlineAttrs = { latex: { default: '' } }
const displayAttrs = { latex: { default: '' } }

export const mathInline = $node('math_inline', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  attrs: inlineAttrs,
  parseDOM: [{ tag: 'math[data-math-inline]' }],
  toDOM: (node) => {
    const el = document.createElement('math')
    el.setAttribute('data-math-inline', '')
    el.textContent = String(node.attrs.latex ?? '')
    return el
  },
  parseMarkdown: {
    match: (n) => n.type === 'inlineMath' && typeof n.value === 'string',
    runner: (state, node, type) => {
      state.addNode(type, { latex: String(node.value ?? '') })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'math_inline',
    runner: (state, node) => {
      state.addNode('html', undefined, mathToMarkdown(String(node.attrs.latex ?? ''), 'inline'))
    },
  },
}))

export const mathDisplay = $node('math_display', () => ({
  group: 'block',
  atom: true,
  attrs: displayAttrs,
  parseDOM: [{ tag: 'math[data-math-display]' }],
  toDOM: (node) => {
    const el = document.createElement('math')
    el.setAttribute('data-math-display', '')
    el.textContent = String(node.attrs.latex ?? '')
    return el
  },
  parseMarkdown: {
    match: (n) => n.type === 'math' && n.meta === null && typeof n.value === 'string',
    runner: (state, node, type) => {
      state.addNode(type, { latex: String(node.value ?? '') })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'math_display',
    runner: (state, node) => {
      state.addNode('html', undefined, mathToMarkdown(String(node.attrs.latex ?? ''), 'display'))
    },
  },
}))
