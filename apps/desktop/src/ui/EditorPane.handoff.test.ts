import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, watch, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { EditorView } from '@codemirror/view'
import { useAppearanceStore } from '../stores/appearance'
import { useTabsStore } from '../stores/tabs'
import { useViewStore } from '../stores/view'

// `vi.mock` is hoisted above every top-level binding, so the note the mocked fs
// hands back has to be reachable from inside the factory.
const note = vi.hoisted(() => ({ content: '' }))

vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: vi.fn(() => Promise.resolve(note.content)),
    write: vi.fn(),
    list: vi.fn(),
    watch: vi.fn(),
    deleteFile: vi.fn(),
    stat: vi.fn(),
    listHistory: vi.fn().mockResolvedValue([]),
    readHistory: vi.fn(),
    restoreHistory: vi.fn(),
    openFolderDialog: vi.fn(),
    saveFileDialog: vi.fn(),
    onFsChange: vi.fn(),
    listTrash: vi.fn(),
    restoreFromTrash: vi.fn(),
    saveAttachment: vi.fn(),
    importAttachment: vi.fn(),
    resolveMediaPath: vi.fn(),
  },
}))

import EditorPane from './EditorPane.vue'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** 63 lines with headings at 1, 22 and 43 (same shape as the split-scroll
 *  tests): the two panes lay it out at very different heights, so "where you
 *  were" cannot be carried across by proportion. */
const HEADED =
  ['# One', '', ...body(), '', '## Two', '', ...body(), '', '## Three', '', ...body()].join('\n') +
  '\n'
function body(): string[] {
  return Array.from({ length: 18 }, (_, i) => `body ${i + 1}`)
}
/** Source line of each heading, 1-based. */
const HEADING_LINES = [1, 22, 43]

// CodeMirror measures text lines at a fixed 14px when the DOM around it has no
// layout (happy-dom performs none), so the source pane's geometry is exactly
// (line - 1) * 14 — the same convention the split-scroll tests use.
const LINE_PX = 14
/** Content-space tops the rendered headings would have. */
const HEADING_TOPS = [100, 700, 1300]
const SOURCE_RANGE = 954 // 63 lines * 14px, in a 400px viewport
const RENDERED_RANGE = 1600
const METRICS = {
  source: { scrollHeight: SOURCE_RANGE + 400, clientHeight: 400 },
  rendered: { scrollHeight: RENDERED_RANGE + 400, clientHeight: 400 },
}

const sourceTopOfLine = (line: number): number => (line - 1) * LINE_PX

let pinia: Pinia
let mounted: VueApp[] = []

function fakeScrollMetrics(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
}

/**
 * happy-dom performs no layout, so every scroll container reports a zero range
 * — and a restore would be clamped to 0 for a reason that has nothing to do
 * with the handoff. The rendered pane's element can be patched per test, but
 * the source pane's scroller is created by CodeMirror inside an async component
 * at a moment no test can hook, so the range is supplied by class for the whole
 * file. Same numbers the split-scroll tests use.
 */
function installScrollerMetrics(): void {
  const proto = HTMLElement.prototype
  for (const [name, value] of [
    ['scrollHeight', SOURCE_RANGE + 400],
    ['clientHeight', 400],
  ] as const) {
    Object.defineProperty(proto, name, {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList?.contains('cm-scroller') ? value : 0
      },
    })
  }
}

function restoreScrollerMetrics(): void {
  for (const name of ['scrollHeight', 'clientHeight'] as const) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
}

/** The rendered headings get the content-space offsets the browser would give
 *  them, reported the way getBoundingClientRect does — relative to the viewport,
 *  so they travel with the pane's scroll. */
function fakeHeadingTops(rendered: HTMLElement, tops: number[]): void {
  const headings = rendered.querySelectorAll('h1, h2, h3, h4, h5, h6')
  expect(headings.length).toBe(tops.length)
  headings.forEach((heading, index) => {
    heading.getBoundingClientRect = () =>
      ({
        x: 0,
        y: tops[index] - rendered.scrollTop,
        width: 0,
        height: 0,
        top: tops[index] - rendered.scrollTop,
        right: 0,
        bottom: 0,
        left: 0,
        toJSON: () => ({}),
      }) as DOMRect
  })
}

/** A scroll the user made: the element moves, then reports it. */
function userScroll(el: HTMLElement, top: number): void {
  el.scrollTop = top
  el.dispatchEvent(new Event('scroll'))
}

function sourceViewOf(host: HTMLElement): EditorView {
  const scroller = host.querySelector<HTMLElement>('.pane.source .cm-scroller')
  if (!scroller) throw new Error('the source pane is not mounted')
  const cm = EditorView.findFromDOM(scroller)
  if (!cm) throw new Error('the source pane has no CodeMirror view')
  return cm
}

/** The 1-based line the CodeMirror caret sits on. */
function caretLineOf(cm: EditorView): number {
  return cm.state.doc.lineAt(cm.state.selection.main.head).number
}

const focusIn = (selector: string): boolean => {
  const active = document.activeElement
  return active !== null && active.closest(selector) !== null
}

describe('EditorPane mode handoff', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    // The split-scroll tests' defaults: scrolling the source pane in split mode
    // syncs the rendered pane, which would mask what the handoff itself does.
    useAppearanceStore().setAutoSyncScroll(true)
    installScrollerMetrics()
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    restoreScrollerMetrics()
    document.body.innerHTML = ''
  })

  async function mountPane(mode: 'rendered' | 'source' | 'split'): Promise<HTMLElement> {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    note.content = HEADED
    await tabs.openTab('notes/a.md')
    const host = document.createElement('div')
    document.body.appendChild(host)
    await import('../view/SourcePane.vue')
    const app = createApp(EditorPane)
    app.use(pinia)
    app.mount(host)
    mounted.push(app)
    await flush()

    const view = useViewStore()
    if (mode !== 'rendered') view.setMode(mode)
    if (mode !== 'rendered') {
      for (let i = 0; i < 40; i += 1) {
        await flush()
        if (host.querySelector('.pane.source .cm-scroller')) break
      }
    }
    await nextTick()

    const rendered = host.querySelector<HTMLElement>('.pane.rendered')
    expect(rendered).not.toBeNull()
    fakeScrollMetrics(rendered!, METRICS.rendered.scrollHeight, METRICS.rendered.clientHeight)
    fakeHeadingTops(rendered!, HEADING_TOPS)
    if (mode !== 'rendered') {
      const scroller = host.querySelector<HTMLElement>('.pane.source .cm-scroller')
      expect(scroller).not.toBeNull()
      fakeScrollMetrics(scroller!, METRICS.source.scrollHeight, METRICS.source.clientHeight)
    }
    await nextTick()
    return host
  }

  it('渲染 → 源码 lands on the line the rendered pane was showing, with the caret there', async () => {
    const host = await mountPane('rendered')
    const rendered = host.querySelector<HTMLElement>('.pane.rendered')!
    // The user scrolls to the top of the second heading (rendered offset 700).
    userScroll(rendered, HEADING_TOPS[1])
    await nextTick()

    // …and clicks 源码.
    const view = useViewStore()
    view.setMode('source')
    for (let i = 0; i < 40; i += 1) {
      await flush()
      if (host.querySelector('.pane.source .cm-scroller')) break
    }
    await nextTick()

    const cm = sourceViewOf(host)
    expect(caretLineOf(cm)).toBe(HEADING_LINES[1])
    expect(cm.scrollDOM.scrollTop).toBeCloseTo(sourceTopOfLine(HEADING_LINES[1]), 3)
  })

  it('源码 → 渲染 lands on the rendered block of the source line', async () => {
    const host = await mountPane('source')
    const cm = sourceViewOf(host)
    // The user scrolls the source pane to the top of the second heading.
    userScroll(cm.scrollDOM, sourceTopOfLine(HEADING_LINES[1]))
    await nextTick()

    useViewStore().setMode('rendered')
    await nextTick()
    await flush()

    const rendered = host.querySelector<HTMLElement>('.pane.rendered')!
    // Within a few pixels rather than exact: the source pane reports the line
    // its viewport starts on one pixel in (see `getVisibleLine`), and that
    // fraction of a source line is a couple of rendered pixels.
    expect(Math.abs(rendered.scrollTop - HEADING_TOPS[1])).toBeLessThan(5)
  })

  it('hands the keyboard to the pane the switch opened', async () => {
    const host = await mountPane('rendered')
    // A real click focuses the switch button first — that is the state the
    // defect leaves the app in (measured in a browser: `activeElement` is the
    // `.switch-option` button after the click).
    const button = document.createElement('button')
    button.className = 'switch-option'
    const switchEl = document.createElement('div')
    switchEl.className = 'view-switch'
    switchEl.setAttribute('data-view-switch', '')
    switchEl.appendChild(button)
    document.body.appendChild(switchEl)
    button.focus()
    expect(document.activeElement).toBe(button)

    useViewStore().setMode('source')
    for (let i = 0; i < 40; i += 1) {
      await flush()
      if (host.querySelector('.pane.source .cm-scroller')) break
    }
    await nextTick()

    expect(focusIn('[data-testid="source-pane"]')).toBe(true)

    // …and back to the rendered pane.
    useViewStore().setMode('rendered')
    await nextTick()
    await flush()
    expect(focusIn('.pane.rendered')).toBe(true)
  })

  it('leaves the keyboard alone when the mode changes from somewhere else', async () => {
    const host = await mountPane('rendered')
    const elsewhere = document.createElement('input')
    document.body.appendChild(elsewhere)
    elsewhere.focus()

    useViewStore().setMode('source')
    for (let i = 0; i < 40; i += 1) {
      await flush()
      if (host.querySelector('.pane.source .cm-scroller')) break
    }
    await nextTick()

    // Focus was in the sidebar search box, the palette, a dialog: the editor
    // must not take it.
    expect(document.activeElement).toBe(elsewhere)
  })

  it('does not re-place the source pane when the split view is left for it', async () => {
    const host = await mountPane('split')
    const cm = sourceViewOf(host)
    userScroll(cm.scrollDOM, sourceTopOfLine(HEADING_LINES[2]))
    await nextTick()
    const before = cm.scrollDOM.scrollTop
    expect(before).toBeGreaterThan(0)

    useViewStore().setMode('source')
    await nextTick()
    await flush()

    // The pane was already on screen and is the place the user was working:
    // nothing about it may move.
    expect(sourceViewOf(host).scrollDOM.scrollTop).toBeCloseTo(before, 3)
  })

  it('does not carry a position into a document that just opened', async () => {
    useAppearanceStore().setAutoSyncScroll(true)
    const host = await mountPane('source')
    const cm = sourceViewOf(host)
    userScroll(cm.scrollDOM, sourceTopOfLine(HEADING_LINES[2]))
    await nextTick()

    // Another note is opened. App.vue puts the live mode back to its default
    // from a watcher on the active tab, i.e. in the same flush as the switch —
    // a mode change too, but not a pane switch.
    const tabs = useTabsStore()
    note.content = '# Another note\n\nshort\n'
    const host2 = document.createElement('div')
    document.body.appendChild(host2)
    const app = createApp(
      defineComponent({
        setup() {
          watch(() => useTabsStore().activeId, () => useViewStore().resetToDefault())
          return () => h('div')
        },
      }),
    )
    app.use(pinia)
    app.mount(host2)
    mounted.push(app)
    await tabs.openTab('notes/b.md')
    await nextTick()
    await flush()

    const rendered = host.querySelector<HTMLElement>('.pane.rendered')!
    expect(rendered.scrollTop).toBe(0)
  })
})
