import { afterEach, describe, expect, it, vi } from 'vitest'
import { basicPlugins, createEditor } from '../editor'

/**
 * A stand-in for MathLive's `<math-field>`.
 *
 * It renders into a SHADOW ROOT, as the installed `mathlive@0.103.0` does
 * (`attachShadow({mode:"open",delegatesFocus:!0})` in `dist/mathlive.min.js`).
 * That is the property this defect turns on: the host element the dialog gave
 * the editor holds the formula in `value` while its `textContent` stays empty,
 * so anything reading the host's text after the swap reads `''`.
 */
const { MFE } = vi.hoisted(() => {
  class MockMathfield extends HTMLElement {
    value = ''
    constructor() {
      super()
      this.attachShadow({ mode: 'open' })
    }
  }
  customElements.define('math-field-window', MockMathfield)
  return { MFE: MockMathfield }
})

type MathLiveMock = {
  MathfieldElement: typeof MFE
  convertLatexToMarkup: undefined
}

/**
 * Hold MathLive's lazy import open until the test releases it.
 *
 * The window is a race against the ~1 MB import, so it is reproduced by OWNING
 * the import rather than by waiting for it to be slow: the mocked module does
 * not resolve until `release()` is called. That puts the test on both sides of
 * the window on purpose — no wall-clock waiting decides anything here.
 */
function holdMathLiveImport(): { release: () => void } {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  // A fresh `atoms` module per test: its `mathlivePromise` is cached, so a
  // second dialog in this file would otherwise find MathLive already loaded and
  // never take the degraded path at all.
  vi.resetModules()
  vi.doMock('mathlive', async (): Promise<MathLiveMock> => {
    await gate
    return { MathfieldElement: MFE, convertLatexToMarkup: undefined }
  })
  return { release }
}

const FIELD_TAG = 'math-field-window'

const mathFieldIn = (host: Element): (HTMLElement & { value: string }) | null =>
  host.querySelector(FIELD_TAG) as (HTMLElement & { value: string }) | null

/**
 * Open the dialog on a cold start, type a formula into the degraded editor
 * while MathLive is still in flight, then let the import land — and hand back
 * the elements so a test can ask what the upgrade did to the typed formula.
 */
async function typeBeforeMathLiveArrives(latex: string): Promise<{
  overlay: HTMLElement
  host: HTMLElement
  editor: ReturnType<typeof createEditor>
}> {
  const { release } = holdMathLiveImport()
  const { openMathDialog } = await import('./dialog')

  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createEditor(el, { plugins: basicPlugins })
  await editor.open('')
  const view = editor.getView()

  openMathDialog(view, { mode: 'inline' })
  const overlay = document.querySelector('.math-overlay') as HTMLElement
  const host = overlay.querySelector('.math-field-host') as HTMLElement

  // The window, stated rather than hoped for: MathLive has not arrived, so the
  // dialog is on its degraded editor and the formula below is typed into THAT.
  expect(host.getAttribute('contenteditable'), 'the degraded editor opens at once').toBe('true')
  expect(mathFieldIn(host), 'MathLive must still be in flight here').toBeNull()

  host.textContent = latex

  release() // MathLive arrives — here, and not before.
  await vi.waitFor(() => expect(mathFieldIn(host)).not.toBeNull())

  return { overlay, host, editor }
}

describe('openMathDialog: a formula typed while MathLive is still loading', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.doUnmock('mathlive')
    vi.resetModules()
  })

  it('keeps the typed formula in the field the upgrade built', async () => {
    const { host, editor } = await typeBeforeMathLiveArrives('a^2+b^2')

    const field = mathFieldIn(host)
    expect(field, 'the upgrade must leave a MathLive field behind').not.toBeNull()
    // Pre-fix this read `''`: the upgrade DID carry `a^2+b^2` onto the new
    // field, and then the dialog read the fallback handle — whose getValue is
    // the host's textContent, emptied by the swap — and wrote that `''` back
    // over the top.
    expect(field?.value, 'the formula must survive the upgrade').toBe('a^2+b^2')

    editor.destroy()
  })

  it('inserts the typed formula on confirm', async () => {
    const { overlay, editor } = await typeBeforeMathLiveArrives('a^2+b^2')

    const confirm = Array.from(overlay.querySelectorAll('button')).find(
      (b) => b.textContent === '确定',
    )
    confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    // Pre-fix the confirm handler saw `''`, took the empty-field exit, cleaned
    // up and inserted nothing — the dialog closed over a lost formula.
    expect(document.querySelector('.math-overlay')).toBeNull()
    expect(await editor.save()).toContain('$a^2+b^2$')

    editor.destroy()
  })
})
