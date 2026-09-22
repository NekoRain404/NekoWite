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
 * again (`apps/desktop/e2e/webkit/probe-egress.mjs`).
 *
 * Every case builds its **own** module graph (`vi.resetModules()` + `vi.doMock`, the pattern
 * `dialog-upgrade-window.test.ts` uses) and imports the editor afterwards. The first version of this file
 * used one file-wide latch instead, and its "the library is already there" case then passed only because
 * an earlier case had released that latch: run alone, it failed with the very message the late-arrival
 * case is supposed to produce. A control that depends on the order of the cases above it is not a control.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

type EditorModule = typeof import('../editor')
type MathLiveMock = { MathfieldElement?: unknown; convertLatexToMarkup?: (latex: string) => string }

/** What MathLive's own markup contains, and the fallback never does. */
const RENDERED = 'ML__latex'
const markup = (latex: string): string => `<span class="${RENDERED}">${latex}</span>`

vi.mock('mathlive/static.css', () => ({}))

/**
 * An editor whose MathLive import is **held open** until `release()`.
 *
 * Owning the import rather than waiting for it to be slow puts the case on both sides of the window.
 */
async function editorWithLateMathLive(): Promise<{ release: () => void; mod: EditorModule }> {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.resetModules()
  vi.doMock(
    'mathlive',
    async (): Promise<MathLiveMock> => {
      await gate
      return { MathfieldElement: undefined, convertLatexToMarkup: markup }
    },
  )
  return { release, mod: await import('../editor') }
}

/** An editor whose MathLive import succeeds immediately — the control's starting state. */
async function editorWithMathLive(): Promise<EditorModule> {
  vi.resetModules()
  vi.doMock('mathlive', (): MathLiveMock => ({ MathfieldElement: undefined, convertLatexToMarkup: markup }))
  return import('../editor')
}

/**
 * An editor whose **first** import attempt fails, and whose next one succeeds.
 *
 * The loader clears its cache when an import fails, so a retry is a second attempt; a view that bound
 * itself to the first attempt's promise would never hear about the second one's success.
 */
async function editorWithAFailedFirstImport(): Promise<{
  failFirst: () => void
  attempts: () => number
  mod: EditorModule
}> {
  let attempts = 0
  let releaseAttempt: () => void = () => undefined
  const firstAttempt = new Promise<void>((resolve) => {
    releaseAttempt = resolve
  })
  vi.resetModules()
  vi.doMock('mathlive', async (): Promise<MathLiveMock> => {
    attempts += 1
    if (attempts === 1) {
      await firstAttempt
      throw new Error('views.test: the first import failed')
    }
    return { MathfieldElement: undefined, convertLatexToMarkup: markup }
  })
  return { failFirst: () => releaseAttempt(), attempts: () => attempts, mod: await import('../editor') }
}

const editors: { destroy: () => void }[] = []

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  document.body.innerHTML = ''
})

/** A note with one inline formula in it, opened in `mod`'s editor. */
async function openMathNote(mod: EditorModule): Promise<() => Element | null> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = mod.createEditor(el, { plugins: mod.basicPlugins })
  editors.push(editor)
  await editor.open('Energy is $E=mc^2$.\n')
  return () => el.querySelector('.math-node')
}

describe('the math node view and a late library', () => {
  it('re-renders the formula once MathLive arrives, instead of leaving the source text', async () => {
    const { release, mod } = await editorWithLateMathLive()
    const node = await openMathNote(mod)
    // The symptom, before the fix: the LaTeX source as visible text.
    expect(node()?.textContent).toContain('E=mc^2')
    expect(node()?.innerHTML).not.toContain(RENDERED)

    release()
    await vi.waitFor(() => expect(node()?.innerHTML).toContain(RENDERED))
    expect(node()?.textContent).not.toContain('$')
  })

  it('renders on the first paint once the library has arrived, without waiting again', async () => {
    // The control, and it stands on its own: its own module graph, its own editor. "Already there" is not
    // a state a fresh graph starts in — it is what the first math node's import produces — so this case
    // earns it (first note, awaited) and then asserts the property that matters: the **next** node renders
    // synchronously, because `mathLiveReady()` is true and nothing is deferred for it.
    const mod = await editorWithMathLive()
    const first = await openMathNote(mod)
    await vi.waitFor(() => expect(first()?.innerHTML).toContain(RENDERED))

    const second = await openMathNote(mod)
    expect(second()?.innerHTML).toContain(RENDERED)
  })

  it('re-renders an open node when a later import attempt succeeds', async () => {
    // The loader retries after a failure, and a view bound to the failed attempt's promise would keep the
    // source text even though the library arrived. The second note is what starts the retry.
    const { failFirst, attempts, mod } = await editorWithAFailedFirstImport()
    const first = await openMathNote(mod)
    expect(first()?.innerHTML).not.toContain(RENDERED)

    failFirst()
    await vi.waitFor(() => expect(attempts()).toBe(1))

    const second = await openMathNote(mod)
    await vi.waitFor(() => expect(second()?.innerHTML).toContain(RENDERED))
    // The node opened before the retry is told as well — that is the whole point.
    await vi.waitFor(() => expect(first()?.innerHTML).toContain(RENDERED))
  })
})
