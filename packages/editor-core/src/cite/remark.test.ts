import { describe, expect, it } from 'vitest'
import { citeMdast } from './remark'

describe('citeMdast (pure)', () => {
  it('splits [@key] out of a paragraph', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'See [@a] and [@b].' }],
        },
      ],
    }
    citeMdast(tree, { value: '' })
    const kids = tree.children[0].children
    expect(
      kids.some((n) => n.type === 'nekoCite' && n.value === '[@a]'),
    ).toBe(true)
    expect(
      kids.some((n) => n.type === 'nekoCite' && n.value === '[@b]'),
    ).toBe(true)
  })
})