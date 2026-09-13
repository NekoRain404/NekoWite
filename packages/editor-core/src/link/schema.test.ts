import { describe, expect, it } from 'vitest'
import { createEditor } from '../editor'

/**
 * A link whose text is formatted must keep the link OUTSIDE the formatting.
 *
 * Milkdown's serializer nests marks by `spec.priority` (lowest opens first, so
 * it ends up outermost). Every text mark defaults to 50, which left same-priority
 * marks in ProseMirror's own order — and `strong` ranks before `link` there, so
 * `[**bold** link](url)` was saved as `**[bold](url)** [link](url)`: the emphasis
 * was hoisted outside the link and the link itself was duplicated.
 */

async function save(input: string): Promise<string> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const ed = createEditor(el)
  try {
    await ed.open(input)
    return await ed.save()
  } finally {
    ed.destroy()
    el.remove()
  }
}

describe('link marks wrap the text marks', () => {
  const cases: Array<[string, string]> = [
    ['strong', '[**bold** link](https://x.test)\n'],
    ['emphasis', '[*em* link](https://x.test)\n'],
    ['strikethrough', '[~~gone~~ link](https://x.test)\n'],
    ['highlight', '[==hi== link](https://x.test)\n'],
    ['inline code', '[`code` link](https://x.test)\n'],
    ['strong and emphasis', '[**bold** and *em* in one link](https://x.test)\n'],
    ['formatting only', '[**all bold**](https://x.test)\n'],
    ['link at the start of a line', '[**bold** link](https://x.test) and text\n'],
    ['two formatted links', '[**a** x](https://x.test) [*b* y](https://y.test)\n'],
  ]

  for (const [label, input] of cases) {
    it(label, async () => {
      expect(await save(input)).toBe(input)
    })
  }

  it('keeps the link outside the emphasis when re-saving', async () => {
    const once = await save('[**bold** link](https://x.test)\n')
    expect(await save(once)).toBe(once)
  })
})
