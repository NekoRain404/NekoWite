import { describe, expect, it } from 'vitest'
import { createEditor } from '../editor'

/**
 * MDX syntax is registered for `.mdx` documents only, and it comes from the MDX
 * parser rather than from this module's own scanners.
 *
 * `open()` is handed the path now, so a document can say what it is. A `.mdx`
 * file is parsed with `remark-mdx`: `mdxjsEsm`, `mdxFlowExpression` and
 * `mdxTextExpression` are real mdast nodes, so `export const meta = { … }` and a
 * `{ … }` expression written across lines are one construct each instead of
 * text that happens to contain braces. A `.md` file keeps the plain Markdown
 * pipeline — `5 <> 6` and NekoWite's own `{width=640 align=center}` image syntax
 * are not MDX, and reading them as MDX would reject the document.
 *
 * The bytes are the contract: an unedited document comes back as it was opened.
 */

/** Documents whose bytes must not change across open → save. */
const MDX_BYTE_IDENTICAL: Array<[string, string]> = [
  // A flow expression is a construct of its own, and it may be written across
  // lines: the indentation inside it is the author's, and Markdown has no rules
  // for it.
  ['flow expression', '{a * b}\n'],
  ['multi-line flow expression', '{\n  a * b\n}\n'],
  ['flow expression among blocks', '# T\n\n{a * b}\n\ntext\n'],
  ['jsx comment as a block', '{/* a comment */}\n'],

  // ESM statements survive today only because they look like ordinary
  // paragraphs. They are statements, and a `{ … }` inside one is not text.
  ['export with an object literal', "export const meta = {\n  title: 'x'\n}\n\nBody\n"],
  ['import and export together', "import A from './a'\nexport const b = 1\n\n# T\n"],
  ['import, expression and body', "import X from './x'\n\n{a * b}\n\nBody\n"],

  // Inline MDX keeps the shape it has in a Markdown file: an inline component
  // is a source atom, and an inline `{ … }` stays text (the serializer writes
  // both back verbatim).
  ['inline expression in prose', 'Value {a * b} here.\n'],
  ['inline expression after an image', '![a](x.png){width=480}\n'],
  ['inline component in prose', 'x <Callout {...props} /> y\n'],
  ['inline component in a heading', '# Head <Callout {...props} />\n'],

  // A component body is MDX content, so an expression or a comment inside it is
  // part of the element's own source.
  ['expression inside a component body', '<Callout>\n\n{a * b}\n\n</Callout>\n'],
  ['component with a multi-line body', '<Callout\n  title="x"\n>\n\n- a\n- b\n\n</Callout>\n'],
]

const MD_BYTE_IDENTICAL: Array<[string, string]> = [
  // Not MDX: a fragment in prose, and the image-dimension syntax NekoWite adds
  // to Markdown. Both are rejected by an MDX reader, and both are ordinary text
  // to a Markdown one.
  ['stray fragment in prose', '5 <> 6\n'],
  ['image dimensions, two attributes', '![a](x.png){width=640 align=center}\n'],
  ['image dimensions, one attribute', '![a](x.png){width=480}\n'],
  ['braces in prose', 'Text {braces} and 5 < 6 > 4.\n'],
  ['an import-looking line', "import X from './x'\n\nBody\n"],
]

async function openAndSave(input: string, path?: string): Promise<string> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const ed = createEditor(el)
  try {
    await ed.open(input, path)
    return await ed.save()
  } finally {
    ed.destroy()
    el.remove()
  }
}

describe('an MDX document is parsed with the MDX parser', () => {
  for (const [label, input] of MDX_BYTE_IDENTICAL) {
    it(label, async () => {
      expect(await openAndSave(input, '/vault/note.mdx')).toBe(input)
    })
  }
})

describe('a Markdown document keeps parsing as Markdown', () => {
  for (const [label, input] of MD_BYTE_IDENTICAL) {
    it(label, async () => {
      expect(await openAndSave(input, '/vault/note.md')).toBe(input)
      // No path is a Markdown document too: an editor with no file behind it
      // must not start reading MDX syntax.
      expect(await openAndSave(input)).toBe(input)
    })
  }

  it('does not turn a stray fragment into an MDX node', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const ed = createEditor(el)
    try {
      await ed.open('5 <> 6\n', '/vault/note.md')
      expect(el.querySelector('.mdx-component')).toBeNull()
    } finally {
      ed.destroy()
      el.remove()
    }
  })
})

describe('an MDX document whose MDX does not parse', () => {
  // micromark rejects malformed MDX outright (an unterminated tag, a `{ … }`
  // that is not JavaScript, a raw HTML comment). The document still has to open:
  // it falls back to the Markdown pipeline, which is the path it had before MDX
  // parsing existed and which keeps its bytes.
  const FALLBACK: Array<[string, string, string]> = [
    ['unterminated attribute', '<Callout foo=', '\\<Callout foo=\n'],
    ['unclosed component', '<Callout>\n\nunclosed\n', '<Callout>\n\nunclosed\n'],
    ['unterminated attribute quote', '<Callout foo="x>hi</Callout>', '\\<Callout foo="x>hi</Callout>\n'],
    ['import that is not JavaScript', 'import {\n', 'import {\n'],
  ]

  for (const [label, input, expected] of FALLBACK) {
    it(label, async () => {
      await expect(openAndSave(input, '/vault/note.mdx')).resolves.toBe(expected)
    })
  }
})

describe('what the MDX parser produces reaches the model', () => {
  it('a flow expression becomes a source atom, not prose', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const ed = createEditor(el)
    try {
      await ed.open('{a * b}\n', '/vault/note.mdx')
      const source = el.querySelector('.mdx-component-source')
      expect(source).not.toBeNull()
      expect(source!.textContent).toBe('{a * b}')
    } finally {
      ed.destroy()
      el.remove()
    }
  })

  it('an ESM statement becomes a source atom, not prose', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const ed = createEditor(el)
    try {
      await ed.open("export const meta = {\n  title: 'x'\n}\n", '/vault/note.mdx')
      const source = el.querySelector('.mdx-component-source')
      expect(source).not.toBeNull()
      expect(source!.textContent).toContain('title')
    } finally {
      ed.destroy()
      el.remove()
    }
  })

  it('the same document opened as Markdown keeps its braces as text', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const ed = createEditor(el)
    try {
      await ed.open('{a * b}\n', '/vault/note.md')
      expect(el.querySelector('.mdx-component')).toBeNull()
    } finally {
      ed.destroy()
      el.remove()
    }
  })
})
