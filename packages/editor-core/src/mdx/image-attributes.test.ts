import { describe, expect, it } from 'vitest'
import { createEditor } from '../editor'

/**
 * NekoWite's own image attribute block must not cost the document its MDX parse.
 *
 * `{width=640 align=center}` is an MDX expression that is not JavaScript, so
 * micromark throws on it — and the throw was per DOCUMENT, not per construct: a
 * `.mdx` file holding one sized image fell back to the Markdown pipeline whole,
 * and every expression, ESM statement and component in it stopped being MDX.
 * Three of the five demo files are in that state (`docs/mdx-demo/`).
 *
 * The syntax itself is a fact about the product and does not change. The failure
 * granularity does: a construct the MDX parser cannot read costs that construct.
 *
 * The bytes alone cannot tell the two pipelines apart — the Markdown path keeps
 * them too, and even builds component nodes for JSX (`mdxJsxMdast` merges what
 * micromark read as HTML). What it cannot do is put `{a * b}` in the tree as an
 * MDX expression, so that is what these cases assert.
 */

/** An image with attributes, a component, and a flow expression after both. */
const IMAGE_COMPONENT_AND_EXPRESSION =
  '![banner](x.png){width=640 align=center}\n\n' +
  '<Card foo={1} bar="hello">body</Card>\n\n' +
  '{a * b}\n'

async function openMdx(source: string) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const ed = createEditor(el)
  await ed.open(source, '/vault/note.mdx')
  return { el, ed }
}

describe('an image attribute block does not disable MDX for the document', () => {
  it('parses the JSX in the same document as an MDX node', async () => {
    const { el, ed } = await openMdx(IMAGE_COMPONENT_AND_EXPRESSION)
    try {
      // A flow `{ … }` read by CommonMark is a paragraph of prose; read by the
      // MDX parser it is an expression, which is a source node of its own.
      const sources = el.querySelectorAll('.mdx-component-source')
      expect([...sources].map((s) => s.textContent)).toContain('{a * b}')
    } finally {
      ed.destroy()
      el.remove()
    }
  })

  it('still keeps the JSX component as an element', async () => {
    const { el, ed } = await openMdx(IMAGE_COMPONENT_AND_EXPRESSION)
    try {
      const sources = [...el.querySelectorAll('.mdx-component-source')].map(
        (s) => s.textContent,
      )
      expect(sources).toContain('<Card foo={1} bar="hello">body</Card>')
    } finally {
      ed.destroy()
      el.remove()
    }
  })

  it('round-trips the whole document byte for byte', async () => {
    const { ed } = await openMdx(IMAGE_COMPONENT_AND_EXPRESSION)
    try {
      expect(await ed.save()).toBe(IMAGE_COMPONENT_AND_EXPRESSION)
    } finally {
      ed.destroy()
    }
  })

  it('reads the attributes as the image it belongs to', async () => {
    const { el, ed } = await openMdx(IMAGE_COMPONENT_AND_EXPRESSION)
    try {
      // The masking must be invisible to the image-dimension pass, which reads
      // the text next to the image: a placeholder left there would take the
      // size and the alignment off every picture in the document.
      const img = el.querySelector('img')
      expect(img?.getAttribute('style')).toContain('width: 640px')
      expect(img?.getAttribute('style')).toContain('margin-left: auto')
    } finally {
      ed.destroy()
      el.remove()
    }
  })
})

/**
 * The two ways masking could overreach, both of which would be worse than the
 * defect it repairs.
 *
 * Code is not MDX to either parser, so a `{ … }` in a fence is text — and a
 * placeholder written there would be a code node's value, which the tokenizer
 * produced and the source offsets cannot put back. An expression MDX CAN read
 * must go on being one: the mask is for the shapes the parser refuses, and that
 * is decided by asking it, not by recognising `width=`.
 */
describe('only the constructs the parser refuses are masked', () => {
  const CODE_DOCUMENTS: Array<[string, string]> = [
    ['a fenced code block', '```js\nconst a = {width=640 align=center}\n```\n'],
    ['an inline code span', 'Use `{width=640 align=center}` after an image.\n'],
    [
      'a fence beside a real image attribute',
      '![a](x.png){width=640 align=center}\n\n```js\n{width=999 align=left}\n```\n',
    ],
    // A formula is braces to a scanner and nothing at all to MDX, so the group
    // that encloses a failing offset must not be allowed to reach one.
    [
      'a formula beside a real image attribute',
      '公式 $e^{i\\pi}+1=0$ 与 $\\frac{a}{b}$。\n\n![a](x.png){width=640 align=center}\n',
    ],
    ['a formula holding the attribute text', '$x^{width=640 align=center}$\n'],
    ['a formula with escaped braces', '$\\left\\{ x \\right\\}$\n'],
  ]

  for (const [label, source] of CODE_DOCUMENTS) {
    it(`leaves ${label} as text`, async () => {
      const { el, ed } = await openMdx(source)
      try {
        expect(await ed.save()).toBe(source)
        // The code is code, so the attributes in it never became an image's.
        expect(el.querySelector('img')?.getAttribute('style') ?? '').not.toContain('999')
      } finally {
        ed.destroy()
        el.remove()
      }
    })
  }

  it('leaves an indented code block as text', async () => {
    // The BYTES here are the serializer's business, not this file's: remark
    // re-writes an indented code block as a fenced one on ANY document, `.md`
    // included, and did before any of this existed. What matters is that the
    // braces stayed literal text instead of becoming one.
    const source = '    ![a](x.png){width=640 align=center}\n'
    const { el, ed } = await openMdx(source)
    try {
      expect(await ed.save()).toContain('{width=640 align=center}')
      expect(el.querySelector('img')).toBeNull()
    } finally {
      ed.destroy()
      el.remove()
    }
  })

  it('leaves a block formula beside a sized image alone', async () => {
    // Block math is written back as inline math by the math serializer on every
    // document, so the assertion is on the formula and the image, not on the
    // delimiters — what must not happen is the formula coming back masked, or
    // the image losing the attributes it was written with.
    const source = '$$\\left\\{ x \\right\\}$$\n\n![a](x.png){width=640 align=center}\n'
    const { el, ed } = await openMdx(source)
    try {
      const saved = await ed.save()
      expect(saved).toContain('\\left\\{ x \\right\\}')
      expect(saved).toContain('{width=640 align=center}')
      expect(el.querySelector('img')?.getAttribute('style')).toContain('width: 640px')
    } finally {
      ed.destroy()
      el.remove()
    }
  })

  it('does not turn a code block into an image attribute', async () => {
    const { el, ed } = await openMdx('```js\n{width=640 align=center}\n```\n')
    try {
      expect(el.querySelector('img')).toBeNull()
    } finally {
      ed.destroy()
      el.remove()
    }
  })

  it('leaves a valid MDX expression an expression', async () => {
    const { el, ed } = await openMdx(
      '![a](x.png){width=640 align=center}\n\n{width=480}\n\n{a * b}\n',
    )
    try {
      const sources = [...el.querySelectorAll('.mdx-component-source')].map(
        (s) => s.textContent,
      )
      // `{width=480}` is an assignment inside a block and `{a * b}` a product —
      // both are JavaScript, so micromark reads them and neither may be masked.
      expect(sources).toEqual(['{width=480}', '{a * b}'])
    } finally {
      ed.destroy()
      el.remove()
    }
  })
})

describe('a Markdown document is untouched by any of this', () => {
  const MD_DOCUMENTS = [
    '![a](x.png){width=640 align=center}\n',
    'Text {braces} and 5 < 6 > 4.\n',
    '![a](x.png){width=640 align=center}\n\n{a * b}\n',
  ]

  for (const source of MD_DOCUMENTS) {
    it(`keeps ${JSON.stringify(source.slice(0, 24))} byte for byte`, async () => {
      const el = document.createElement('div')
      document.body.appendChild(el)
      const ed = createEditor(el)
      try {
        await ed.open(source, '/vault/note.md')
        expect(await ed.save()).toBe(source)
      } finally {
        ed.destroy()
        el.remove()
      }
    })
  }
})
