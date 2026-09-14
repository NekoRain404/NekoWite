import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App as VueApp } from 'vue'
import type { NekoEditor } from '@nekowite/editor-core'
import { useClipboardFidelity } from './use-clipboard-fidelity'

/**
 * Delivery and scoping for the clipboard payload — the part that is NOT about
 * the text (that is `model/selection-text.test.ts`, and it is engine-free).
 *
 * This file is the one that fails without the fix: before it, the app had no
 * copy handler at all, so nothing wrote `text/plain` and every node view's text
 * was lost. It also pins the two traps: the SOURCE pane must be untouched
 * (CodeMirror writes a byte-exact payload of its own), and the default action
 * must still run, because that is what carries the `text/html` half.
 */

const PAYLOAD = 'Inline maths E = mc^2 sits here.'

let mounted: VueApp[] = []

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

/** A `copy`/`cut` event carrying a stub clipboardData, as the engine's does. */
function clipboardEvent(type: 'copy' | 'cut'): { event: Event; written: string[]; prevented: () => boolean } {
  const written: string[] = []
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { setData: (format: string, data: string) => written.push(`${format}:${data}`) },
  })
  return { event, written, prevented: () => event.defaultPrevented }
}

/** Select the contents of `element` the way a drag would. */
function selectAll(element: Element): void {
  const range = document.createRange()
  range.selectNodeContents(element)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/**
 * Mount a component that installs the handler over `panes`, with an editor stub
 * whose view is `renderedDom` and whose document answers with the payload.
 */
function mountWith(panes: HTMLElement, renderedDom: HTMLElement, action: 'copy' | 'cut') {
  const doc = {
    textBetween: vi.fn(() => PAYLOAD),
  }
  const view = {
    dom: renderedDom,
    state: { selection: { from: 1, to: 9, empty: false }, doc },
  }
  const editor = { getView: () => view } as unknown as NekoEditor
  const app = createApp(
    defineComponent({
      setup() {
        useClipboardFidelity({
          getPanesEl: () => panes,
          getEditor: () => editor,
        })
        return () => h('div')
      },
    }),
  )
  app.mount(document.createElement('div'))
  mounted.push(app)
  return { doc, action }
}

describe('useClipboardFidelity', () => {
  it('writes the document payload for a selection in the rendered pane (copy)', () => {
    const panes = document.createElement('div')
    const rendered = document.createElement('div')
    rendered.textContent = 'Inline maths E = mc^2 sits here.'
    panes.appendChild(rendered)
    document.body.appendChild(panes)
    mountWith(panes, rendered, 'copy')
    selectAll(rendered)

    const { event, written, prevented } = clipboardEvent('copy')
    rendered.dispatchEvent(event)

    expect(written).toEqual([`text/plain:${PAYLOAD}`])
    // The engine still gets to add its own `text/html`: suppressing the default
    // is what would break the half that already works.
    expect(prevented()).toBe(false)
  })

  it('writes the same payload for Cut — one road, and the deletion stays the editor’s', () => {
    const panes = document.createElement('div')
    const rendered = document.createElement('div')
    rendered.textContent = 'text'
    panes.appendChild(rendered)
    document.body.appendChild(panes)
    mountWith(panes, rendered, 'cut')
    selectAll(rendered)

    const { event, written, prevented } = clipboardEvent('cut')
    rendered.dispatchEvent(event)

    expect(written).toEqual([`text/plain:${PAYLOAD}`])
    expect(prevented()).toBe(false)
  })

  it('never touches a selection outside the rendered pane (the source pane writes its own)', () => {
    const panes = document.createElement('div')
    const rendered = document.createElement('div')
    const codeMirror = document.createElement('div')
    codeMirror.className = 'cm-editor'
    codeMirror.textContent = '$E = mc^2$'
    panes.append(rendered, codeMirror)
    document.body.appendChild(panes)
    mountWith(panes, rendered, 'copy')
    // The selection is in the SOURCE pane: CodeMirror's payload is byte-exact
    // and a handler that wrote here would replace it with the rendered model's.
    selectAll(codeMirror)

    const { event, written } = clipboardEvent('copy')
    codeMirror.dispatchEvent(event)

    expect(written).toEqual([])
  })
})
