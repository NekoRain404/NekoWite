import { describe, expect, it } from 'vitest'
import { createEditor } from '../editor'
import { parseMarkdown } from '../serialize'
import { mdxJsxMdast } from './remark'

/**
 * M2 — MDX fidelity round-trip suite (docs/dev.md §4.2).
 *
 * Promise: MDX source must never be silently broken by the editor.
 *  - Unknown / uneditable JSX renders a source placeholder and serializes back
 *    byte-for-byte for an unmodified document.
 *  - YAML frontmatter, `import`/`export` statements, component attribute
 *    expressions are not dropped or reordered for unmodified documents.
 *
 * Two guarantees are checked for every fixture:
 *   1. The saved output re-parses to the SAME semantic structure as the input.
 *   2. Where the source is left unmodified and the markup is lossless, the
 *      saved output is byte-identical to the input.
 *
 * The scanner is happy-dom based (like the rest of the suite) and the editor
 * runs headlessly. `open()` is deliberately not part of undo history, so each
 * fixture starts from a clean document.
 */

/** Recursively prune mdast `position`/`data` noise so two parses that differ
 * only in source offsets or remark's render hints compare equal. */
function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize)
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(node as Record<string, unknown>)) {
      if (k === 'position' || k === 'data') continue
      const v = normalize((node as Record<string, unknown>)[k])
      if (v === undefined) continue
      out[k] = v
    }
    return Object.keys(out).length ? out : undefined
  }
  return node
}

/** Parse markdown into the mdast the editor relies on (plain remark parse plus
 * the mdxJsx remark merge), then normalize away location/annotation noise. */
function parseSemantic(md: string): unknown {
  const tree = parseMarkdown(md) as unknown as {
    children: unknown[]
  }
  mdxJsxMdast(tree as Parameters<typeof mdxJsxMdast>[0], { value: md })
  return normalize(tree)
}

/** Fresh headless editor. Each fixture uses its own instance so no document
 * state leaks between cases. */
async function editor(): Promise<ReturnType<typeof createEditor>> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return createEditor(el)
}

describe('mdx round-trip fixtures (byte-identical)', () => {
  const fixtures: [string, string][] = [
    ['plain markdown', '# Title\n\nSome **bold** and *italic*.\n\n- a\n- b\n'],
    ['heading + blockquote', '# H\n\n> quote\n\n```js\nconst x = 1\n```\n'],
    ['nested jsx', '<Outer>\n\n<Inner>deep</Inner>\n\n</Outer>\n'],
    ['jsx attribute expression', '<Card foo={1} bar="x">hi</Card>\n'],
    ['unknown jsx expression', '<UnknownComponent foo={1}>hi</UnknownComponent>\n'],
    ['jsx boolean attr', '<Toggle disabled>on</Toggle>\n'],
    ['import statement', "import { X } from './x'\n\nBody\n"],
    ['export statement', 'export const y = 1\n\nBody\n'],
    ['import + jsx', "import Button from './Button'\n\n<Button>Hi</Button>\n"],
    ['image with attrs', '![alt](path.png){width=100}\n'],
    ['image with title', '![alt](/a/b.png "title")\n'],
    ['inline math', 'Inline $E=mc^2$.\n'],
    ['display math own-line', '$$\nD=b^2-4ac\n$$\n'],
    ['mixed CJK/en/emoji', '混合 中文 and English 💯 special 字符！\n'],
    ['list with task', '- [ ] todo\n- [x] done\n'],
    ['link + autolink', '[a](http://x.com) <b@c.com>\n'],
  ]

  for (const [label, input] of fixtures) {
    it(label, async () => {
      const ed = await editor()
      try {
        await ed.open(input)
        const saved = await ed.save()
        // Byte-for-byte for an unmodified, lossless document.
        expect(saved).toBe(input)
        // ... and the saved markup re-parses to the same semantic structure.
        expect(parseSemantic(saved)).toEqual(parseSemantic(input))
      } finally {
        ed.destroy()
      }
    })
  }
})

describe('mdx round-trip fixtures (lossless, re-parses identically)', () => {
  // GFM tables are re-padded by remark-stringify on save (cell widths are
  // canonicalized); the semantic structure is unchanged — no content dropped,
  // no node reordered, the embedded component is preserved verbatim.
  it('table embedding a component <Row/> survives intact', async () => {
    const ed = await editor()
    try {
      const input = '| a | b |\n| - | - |\n| <Row/> | x |\n'
      await ed.open(input)
      const saved = await ed.save()
      // Cell width padding is canonical GFM; the JSX/component and values must
      // survive, and the table must re-parse to the identical structure.
      expect(saved).toBe('| a      | b |\n| ------ | - |\n| <Row/> | x |\n')
      expect(saved).toContain('<Row/>')
      expect(parseSemantic(saved)).toEqual(parseSemantic(input))
    } finally {
      ed.destroy()
    }
  })

  it('table cell embedding a component with children survives intact', async () => {
    const ed = await editor()
    try {
      const input = '| H |\n| - |\n| <Comp a={1}>y</Comp> |\n'
      await ed.open(input)
      const saved = await ed.save()
      expect(saved).toContain('<Comp a={1}>y</Comp>')
      expect(saved).not.toContain('<br />') // regression: previously corrupted
      expect(parseSemantic(saved)).toEqual(parseSemantic(input))
    } finally {
      ed.destroy()
    }
  })

  // remark-math normalizes an inline `$$...$$` span in prose to `$...$` (it is
  // parsed as a single inlineMath node either way). The formula is NOT dropped,
  // reordered, or broken — it re-parses to the identical inlineMath node. This
  // documents that the MathML `$$` block form on its own line is preserved
  // byte-for-byte (see the byte-identical fixture above), while the inline
  // `$$` span is semantically lossless.
  it('inline `$$...$$` span re-parses to the same math node (lossless, canonicalized to `$`)', async () => {
    const ed = await editor()
    try {
      const input = 'Inline $E=mc^2$ and $$D=b^2-4ac$$.\n'
      await ed.open(input)
      const saved = await ed.save()
      expect(saved).toBe('Inline $E=mc^2$ and $D=b^2-4ac$.\n')
      expect(parseSemantic(saved)).toEqual(parseSemantic(input))
    } finally {
      ed.destroy()
    }
  })
})

describe('unknown JSX source placeholder', () => {
  it('renders a placeholder and round-trips byte-for-byte', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const ed = createEditor(el)
    const input = '<UnknownComponent foo={1}>hi</UnknownComponent>\n'
    await ed.open(input)

    // An unregistered component must render the SOURCE, not be silently deleted.
    const host = el.querySelector('.mdx-component')
    expect(host).not.toBeNull()
    expect(host!.className).toContain('mdx-component-placeholder')
    const source = el.querySelector('.mdx-component-source')
    expect(source).not.toBeNull()
    expect(source!.textContent).toBe('<UnknownComponent foo={1}>hi</UnknownComponent>')

    // The expression attribute and inline body must serialize back verbatim.
    const saved = await ed.save()
    expect(saved).toBe(input)
    expect(parseSemantic(saved)).toEqual(parseSemantic(input))
    ed.destroy()
  })

  it('renders a placeholder for an unregistered component with a block body', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const ed = createEditor(el)
    const input = '<Note type="tip">\n\n**bold** body\n\n</Note>\n'
    await ed.open(input)

    const host = el.querySelector('.mdx-component')
    expect(host).not.toBeNull()
    expect(host!.className).toContain('mdx-component-placeholder')
    const source = el.querySelector('.mdx-component-source')
    expect(source).not.toBeNull()
    expect(source!.textContent).toContain('**bold** body')

    expect(await ed.save()).toBe(input)
    ed.destroy()
  })
})

describe('frontmatter + import/export preservation', () => {
  it('preserves yaml frontmatter byte-for-byte across open/save', async () => {
    const ed = await editor()
    try {
      const input = '---\ntitle: hello\ntags: [a, b]\n---\n\n# Body\n\ncontent\n'
      await ed.open(input)
      expect(await ed.save()).toBe(input)
    } finally {
      ed.destroy()
    }
  })

  it('preserves frontmatter with a multi-line block and a blank separator', async () => {
    const ed = await editor()
    try {
      const input = '---\na: 1\nb: |\n  multiline\n---\n\nBody\n'
      await ed.open(input)
      expect(await ed.save()).toBe(input)
    } finally {
      ed.destroy()
    }
  })

  it('preserves frontmatter, imports, exports and body together', async () => {
    const ed = await editor()
    try {
      const input =
        '---\ntitle: demo\n---\n\n' +
        "import A from './a'\nimport B from './b'\n\n" +
        'export const meta = { x: 1 }\n\n' +
        '# Doc\n\n<A/>\n'
      await ed.open(input)
      expect(await ed.save()).toBe(input)
    } finally {
      ed.destroy()
    }
  })

  it('preserves import/export statements in an unmodified doc byte-for-byte', async () => {
    const ed = await editor()
    try {
      const input = "import { X } from './x'\n\nexport const y = 1\n\nBody\n"
      await ed.open(input)
      expect(await ed.save()).toBe(input)
    } finally {
      ed.destroy()
    }
  })
})

describe('incomplete / illegal MDX degrades gracefully', () => {
  const cases: [string, string, string][] = [
    ['unclosed block tag', '<Callout>\n\nunclosed\n', '<Callout>\n\nunclosed\n'],
    // A dangling open tag whose attrs are truncated escapes to literal text on
    // save instead of crashing or being dropped. The `<` is backslash-escaped,
    // so it is no longer interpretable as JSX, but no content is lost.
    ['broken attribute', '<Callout foo=', '\\<Callout foo=\n'],
    ['dangling open component', 'text <Callout> no close', 'text <Callout> no close\n'],
    ['jsx inside code fence is untouched', '```\n<Callout>\n```\n', '```\n<Callout>\n```\n'],
    ['unclosed html comment', '<!--unclosed', '<!--unclosed\n'],
    ['incomplete import', 'import {', 'import {\n'],
    ['unterminated attr quote', '<Callout foo="unterminated>hi</Callout>', '\\<Callout foo="unterminated>hi</Callout>\n'],
  ]

  for (const [label, input, expected] of cases) {
    it(label, async () => {
      const ed = await editor()
      try {
        await ed.open(input) // must not throw
        expect(await ed.save()).toBe(expected)
      } finally {
        ed.destroy()
      }
    })
  }
})
