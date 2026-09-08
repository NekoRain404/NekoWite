import { describe, expect, it } from 'vitest'
import { mdxJsxMdast } from './remark'

describe('mdxJsxMdast (pure)', () => {
  it('collapses whole-block component into mdxJsxFlowElement', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'html', value: '<Callout>' },
            { type: 'text', value: 'note' },
            { type: 'html', value: '</Callout>' },
          ],
        },
      ],
    }
    mdxJsxMdast(tree, { value: '<Callout>\n\nnote\n\n</Callout>' })
    const kid = tree.children[0] as { type: string; value?: string }
    expect(kid.type).toBe('mdxJsxFlowElement')
    expect(kid.value).toContain('Callout')
  })
})