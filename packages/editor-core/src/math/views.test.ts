/**
 * The math node view, and the library it renders with.
 *
 * `renderLatexMarkup` renders real math only when MathLive has loaded; until then it falls back to the
 * escaped LaTeX. The view renders on create and on update, and an update only comes from a document
 * change — so a note opened before the import finished showed `x^2 + y^2 = z^2` as source text for as
 * long as it stayed open.
 *
 * That is measured, not guessed: in the built application the math node held the fallback text at 4 s,
 * 12 s and 24 s, and real markup (`<span class="ML__latex">…`) the moment the note was left and opened
 * again (`apps/desktop/e2e/webkit/probe-egress.mjs`). These cases pin the fix.
 *
 * The import is gated on purpose: `mathlive` resolves only when a case releases it, so "the library
 * arrives late" is a fact in this file rather than a race the test hopes to lose.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

/** The gate: `mathlive` (and its stylesheet) resolve only when a case lets them. */
const gate = vi.hoisted(() => {
  let release: () => void = () => undefined
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  return { opened, release: () => release() }
})

vi.mock('mathlive/static.css', () => ({}))
vi.mock('mathlive', async () => {
  await gate.opened
  return {
    MathfieldElement: undefined,
    convertLatexToMarkup: (latex: string) => `<span class="ML__latex">${latex}</span>`,
  }
})

import { basicPlugins, createEditor } from '../editor'

/** What MathLive's own markup contains, and the fallback never does. */
const RENDERED = 'ML__latex'

const editors: { destroy: () => void }[] = []

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  document.body.innerHTML = ''
})

async function openMathNote(): Promise<{ editor: { destroy: () => void }; node: () => Element | null }> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createEditor(el, { plugins: basicPlugins })
  editors.push(editor)
  await editor.open('Energy is $E=mc^2$.\n')
  return { editor, node: () => el.querySelector('.math-node') }
}

describe('the math node view and a late library', () => {
  it('re-renders the formula once MathLive arrives, instead of leaving the source text', async () => {
    const { node } = await openMathNote()
    // The symptom, before the fix: the LaTeX source as visible text.
    expect(node()?.textContent).toContain('E=mc^2')
    expect(node()?.innerHTML).not.toContain(RENDERED)

    gate.release()
    await vi.waitFor(() => expect(node()?.innerHTML).toContain(RENDERED))
    expect(node()?.textContent).not.toContain('$')
  })

  it('renders on the first paint when the library is already there', async () => {
    // The control for the case above: the same note, the same view, one difference — MathLive is
    // available before the document opens, so nothing about the re-render is doing this work.
    const { node } = await openMathNote()
    expect(node()?.innerHTML).toContain(RENDERED)
  })
})
