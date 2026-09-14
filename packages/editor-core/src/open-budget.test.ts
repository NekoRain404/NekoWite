import { describe, expect, it } from 'vitest'

import {
  DocumentTooComplexToRenderError,
  MAX_CONTAINER_WEIGHT,
  MAX_RENDERABLE_CHARACTERS,
  assertRenderable,
  containerWeight,
} from './open-budget'
import { NoDocumentLoadedError, basicPlugins, createEditor } from './editor'

/** A document of exactly `characters` UTF-16 units, in ordinary paragraphs. */
function sized(characters: number): string {
  const line = 'a line of ordinary markdown prose\n\n'
  const whole = Math.floor(characters / line.length)
  const rest = characters - whole * line.length
  return line.repeat(whole) + 'x'.repeat(Math.max(rest - 1, 0)) + (rest > 0 ? '\n' : '')
}

const mount = () => {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return { el, editor: createEditor(el, { plugins: basicPlugins }) }
}

describe('containerWeight', () => {
  it('is zero for prose and for anything a line merely contains', () => {
    expect(containerWeight('')).toBe(0)
    expect(containerWeight('plain prose, > a quote later in the line\n')).toBe(0)
    expect(containerWeight('- item\n- item\n')).toBe(0)
  })

  it('counts leading indentation in columns, a tab as four', () => {
    expect(containerWeight('    indented code\n')).toBe(4)
    expect(containerWeight('\tindented code\n')).toBe(4)
    // A deeper line further down is what counts, not the first one.
    expect(containerWeight('top\n   three\n        eight\n')).toBe(8)
  })

  it('counts each blockquote marker, including the ones with no space after them', () => {
    expect(containerWeight('> one level\n')).toBe(2)
    expect(containerWeight('> > > three levels\n')).toBeGreaterThanOrEqual(6)
    expect(containerWeight('>>>>>>>> four with no spaces\n')).toBeGreaterThanOrEqual(8)
  })

  it('reads CRLF and LF documents the same way', () => {
    expect(containerWeight('> > deep\r\nplain\r\n')).toBe(containerWeight('> > deep\nplain\n'))
  })

  it('sees the report’s 2 KB trigger as deep and a 1000-level one as within budget', () => {
    // task-37 M4: 2000 nested blockquotes, 2 KB, overflowed the stack. The
    // parser cannot be asked to prove that in a test any more — the guard is
    // what stops it — so the metric it decides on is pinned here.
    expect(containerWeight('>'.repeat(2000) + ' deep\n')).toBeGreaterThan(MAX_CONTAINER_WEIGHT)
    expect(containerWeight('>'.repeat(1000) + ' deep\n')).toBeLessThanOrEqual(MAX_CONTAINER_WEIGHT)
  })
})

describe('assertRenderable', () => {
  it('passes an ordinary document of any size the corpus uses', () => {
    expect(() => assertRenderable('# Title\n\nA note.\n')).not.toThrow()
    expect(() => assertRenderable(sized(64 * 1024))).not.toThrow()
  })

  it('passes a document just inside both limits', () => {
    expect(() => assertRenderable(sized(MAX_RENDERABLE_CHARACTERS))).not.toThrow()
    expect(() => assertRenderable(' '.repeat(MAX_CONTAINER_WEIGHT) + 'x\n')).not.toThrow()
  })

  it('refuses a document over the size limit, naming the size', () => {
    const content = sized(MAX_RENDERABLE_CHARACTERS + 1)
    expect(() => assertRenderable(content)).toThrow(DocumentTooComplexToRenderError)
    expect(() => assertRenderable(content)).toThrow(/too large \(\d+ characters/)
    expect(() => assertRenderable(content)).toThrow(/switch to source/)
  })

  it('refuses a small document that nests past the limit, naming the nesting', () => {
    // 2 KB, and it is not the size that is wrong with it.
    const content = '>'.repeat(2_000) + ' deep\n'
    expect(() => assertRenderable(content)).toThrow(DocumentTooComplexToRenderError)
    expect(() => assertRenderable(content)).toThrow(/nested too deeply/)
    expect(() => assertRenderable(content)).toThrow(/switch to source/)
  })
})

describe('open() with a document the rendered view cannot open', () => {
  it('refuses an oversized note without parsing it', async () => {
    const { el, editor } = mount()
    try {
      const content = 'x'.repeat(MAX_RENDERABLE_CHARACTERS + 1)
      const started = Date.now()
      await expect(editor.open(content)).rejects.toThrow(DocumentTooComplexToRenderError)
      const elapsed = Date.now() - started
      // Parsing this would take minutes (task-37 M4: 1 MB measured 88 s, and
      // this is a quarter of a megabyte more). The bound is two orders of
      // magnitude above the check itself — a size comparison — so it fails only
      // if the refusal started doing the work it exists to avoid.
      expect(elapsed).toBeLessThan(500)
    } finally {
      editor.destroy()
      el.remove()
    }
  })

  it('refuses the deep shape the parser used to overflow on', async () => {
    const { el, editor } = mount()
    try {
      await expect(editor.open('>'.repeat(2_000) + ' deep\n')).rejects.toThrow(
        DocumentTooComplexToRenderError,
      )
    } finally {
      editor.destroy()
      el.remove()
    }
  })

  it('leaves the editor holding no document, like any other failed load', async () => {
    const { el, editor } = mount()
    const note = '---\ntitle: a\n---\n\n# Note A\n'
    try {
      await editor.open(note)
      expect(await editor.save()).toBe(note)
      await expect(editor.open('x'.repeat(MAX_RENDERABLE_CHARACTERS + 1))).rejects.toThrow()
      // The model still holds note A's document, but the editor does not claim
      // it is the file that failed — the refusal is a failed load (C1).
      await expect(editor.save()).rejects.toThrow(NoDocumentLoadedError)
    } finally {
      editor.destroy()
      el.remove()
    }
  })

  it('opens a document that is large but within budget', async () => {
    const { el, editor } = mount()
    try {
      const content = '# Big\n\n' + sized(48 * 1024).slice(2)
      await editor.open(content)
      expect(await editor.save()).toBe(content)
    } finally {
      editor.destroy()
      el.remove()
    }
  })
})
