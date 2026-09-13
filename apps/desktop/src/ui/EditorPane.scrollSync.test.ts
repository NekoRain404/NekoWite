import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { EditorView } from '@codemirror/view'
import { useAppearanceStore } from '../stores/appearance'
import { useTabsStore } from '../stores/tabs'
import { useViewStore } from '../stores/view'

// `vi.mock` is hoisted above every top-level binding, so the note the mocked fs
// hands back has to be reachable from inside the factory. `vi.hoisted` gives
// the factory a binding that exists by the time it runs, and lets each test
// choose the document it mounts: the ratio path needs a heading-less note, the
// anchor paths need headings.
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

/** 60 flat lines: no headings, so both directions fall back to the ratio. */
const FLAT = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'

/** 63 lines with headings at 1, 22 and 43, and long bodies between them: the two
 *  panes lay this out at very different heights, which is the document shape the
 *  ratio alone gets wrong. */
const HEADED =
  ['# One', '', ...body(), '', '## Two', '', ...body(), '', '## Three', '', ...body()].join('\n') +
  '\n'

function body(): string[] {
  return Array.from({ length: 18 }, (_, i) => `body ${i + 1}`)
}

/** Text before the first heading: that block has no heading above it to anchor
 *  on, so it has to be measured from the document's own top. 23 lines, with the
 *  only heading on line 4. */
const PREAMBLE = ['intro one', 'intro two', '', '# Only heading', '', ...body()].join('\n') + '\n'

// CodeMirror measures text lines at a fixed 14px when the DOM around it has no
// layout (happy-dom performs none), so the source pane's geometry is exactly
// (line - 1) * 14. See `topLineOf` for reading the line back out of it.
const LINE_PX = 14
/** Content-space tops the rendered headings would have. Both panes have the
 *  same document, but the rendered one is much taller — that mismatch is what
 *  makes the ratio drift and the anchors meaningful. */
const HEADING_TOPS = [100, 700, 1300]
const SOURCE_RANGE = 954 // 63 lines * 14px, in a 400px viewport
const RENDERED_RANGE = 1600

const HEADED_METRICS = {
  source: { scrollHeight: SOURCE_RANGE + 400, clientHeight: 400 },
  rendered: { scrollHeight: RENDERED_RANGE + 400, clientHeight: 400 },
}
const FLAT_METRICS = {
  source: { scrollHeight: 1000, clientHeight: 100 },
  rendered: { scrollHeight: 1000, clientHeight: 100 },
}

const sourceTopOfLine = (line: number): number => (line - 1) * LINE_PX

// The split sync runs on frames: the coordinator asks the frame clock for its
// next tick and the source pane's own throttle uses the same one. Stubbing it
// makes every scroll step hand-cranked — nothing moves until a frame is run, and
// a leg that never settles turns into a runaway loop the helper catches rather
// than a timeout somewhere else.
let frameHandle = 0
let frameClock = 0
const pendingFrames = new Map<number, (time: number) => void>()

function installFrameClock(): void {
  vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void): number => {
    frameHandle += 1
    pendingFrames.set(frameHandle, callback)
    return frameHandle
  })
  vi.stubGlobal('cancelAnimationFrame', (handle: number): void => {
    pendingFrames.delete(handle)
  })
}

/** Run one frame's worth of queued callbacks. */
function runFrame(): void {
  const due = [...pendingFrames.values()]
  pendingFrames.clear()
  frameClock += 20
  for (const callback of due) callback(frameClock)
}

/** Run frames until the scroll loop stops asking for more: a leg of the ease
 *  starts on its first frame (which only pins its clock) and ends when it has
 *  arrived, so "no frames left" is "the panes have stopped moving". */
function settle(maxFrames = 40): void {
  for (let i = 0; i < maxFrames; i += 1) {
    if (pendingFrames.size === 0) return
    runFrame()
  }
  throw new Error('the scroll loop never settled')
}

/** Frames plus the Vue turns that run between them. */
async function driveToRest(): Promise<void> {
  await flush()
  settle()
  await flush()
  settle()
  await flush()
}

let pinia: Pinia
let mounted: VueApp[] = []

/** happy-dom performs no layout, so every scroll container reports a range of
 *  zero and both panes would treat every scroll as a no-op. Giving the two
 *  containers a real range is what makes the mapping observable. */
function fakeScrollMetrics(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
}

/** The rendered headings get the content-space offsets the browser would give
 *  them, reported the way getBoundingClientRect does — relative to the viewport,
 *  so they travel with the pane's scroll. Without this every heading sits at 0
 *  and both directions would map onto the first heading. */
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

/** The 1-based line shown at the top of the source pane. CodeMirror resolves a
 *  height that lands exactly on a line's top to the line above it, so the read
 *  is taken one pixel into the viewport — the line occupying its first pixel. */
function topLineOf(scroller: HTMLElement): number {
  const cm = EditorView.findFromDOM(scroller)
  if (!cm) throw new Error('the source pane has no CodeMirror view')
  const block = cm.lineBlockAtHeight(Math.max(0, cm.scrollDOM.scrollTop + 1))
  return cm.state.doc.lineAt(block.from).number
}

describe('EditorPane split scroll sync', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    useAppearanceStore().setAutoSyncScroll(true)
    document.body.innerHTML = ''
    mounted = []
    pendingFrames.clear()
    frameHandle = 0
    frameClock = 0
    installFrameClock()
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    vi.unstubAllGlobals()
    useAppearanceStore().setAutoSyncScroll(true)
    document.body.innerHTML = ''
  })

  async function mountSplit(
    content: string,
    metrics: typeof FLAT_METRICS,
  ): Promise<{ rendered: HTMLElement; sourceScroller: HTMLElement }> {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    note.content = content
    await tabs.openTab('notes/a.md')
    const host = document.createElement('div')
    document.body.appendChild(host)
    // Pre-warm the lazily-imported source pane. vitest's module runner does not
    // settle a dynamic import that is FIRST triggered from inside a component
    // render: the promise stays pending for the rest of the test, so the async
    // SourcePane never mounts and `.pane.source` is missing. Importing it here
    // (where a dynamic import does settle) leaves it in the module cache, and
    // the component's own import() then resolves immediately. The real browser
    // path is covered end-to-end by e2e/app.spec.ts, which mounts the same
    // async component through the split view.
    await import('../view/SourcePane.vue')
    const app = createApp(EditorPane)
    app.use(pinia)
    app.mount(host)
    mounted.push(app)
    await flush()

    useViewStore().setMode('split')
    // The source pane is an async component (CodeMirror is loaded on demand).
    for (let i = 0; i < 40; i += 1) {
      await flush()
      if (host.querySelector('.pane.source .cm-scroller')) break
    }

    const rendered = host.querySelector<HTMLElement>('.pane.rendered')
    const sourceScroller = host.querySelector<HTMLElement>('.pane.source .cm-scroller')
    expect(rendered).not.toBeNull()
    expect(sourceScroller).not.toBeNull()
    fakeScrollMetrics(rendered!, metrics.rendered.scrollHeight, metrics.rendered.clientHeight)
    fakeScrollMetrics(sourceScroller!, metrics.source.scrollHeight, metrics.source.clientHeight)
    await nextTick()
    return { rendered: rendered!, sourceScroller: sourceScroller! }
  }

  async function mountHeaded(): Promise<{ rendered: HTMLElement; sourceScroller: HTMLElement }> {
    const panes = await mountSplit(HEADED, HEADED_METRICS)
    fakeHeadingTops(panes.rendered, HEADING_TOPS)
    return panes
  }

  it('keeps the panes in step while the setting is on (default)', async () => {
    const { rendered, sourceScroller } = await mountSplit(FLAT, FLAT_METRICS)

    // Scroll the rendered pane to half of its range; the source pane must land
    // on the same ratio.
    userScroll(rendered, 450)
    await driveToRest()

    expect(sourceScroller.scrollTop).toBeCloseTo(450, 3)
  })

  it('leaves the other pane where it is once the setting is off', async () => {
    const { rendered, sourceScroller } = await mountSplit(FLAT, FLAT_METRICS)
    useAppearanceStore().setAutoSyncScroll(false)

    userScroll(rendered, 810)
    await driveToRest()

    expect(sourceScroller.scrollTop).toBe(0)
  })

  it('starts syncing again when the setting is turned back on', async () => {
    const { rendered, sourceScroller } = await mountSplit(FLAT, FLAT_METRICS)
    useAppearanceStore().setAutoSyncScroll(false)
    userScroll(rendered, 810)
    await driveToRest()
    expect(sourceScroller.scrollTop).toBe(0)

    useAppearanceStore().setAutoSyncScroll(true)
    userScroll(rendered, 900)
    await driveToRest()

    expect(sourceScroller.scrollTop).toBeCloseTo(900, 3)
  })

  it('maps a rendered position back to the source line that carries it', async () => {
    const { rendered, sourceScroller } = await mountHeaded()

    // The user puts heading two at the top of the rendered pane. The line that
    // heading sits on is line 22 in the source, which starts at 294px there.
    userScroll(rendered, HEADING_TOPS[1])
    await driveToRest()

    // Ratio-only sync would land on 700/1600 of the source's range — line 30 —
    // so the two panes would be showing a section's worth of different text.
    expect(topLineOf(sourceScroller)).toBe(22)
    expect(sourceScroller.scrollTop).toBeCloseTo(sourceTopOfLine(22), 3)
  })

  it('keeps the body of a section in step instead of pulling back to its heading', async () => {
    const { rendered, sourceScroller } = await mountHeaded()

    // Line 15 sits 14 lines into the first section: heading one is at line 1
    // (rendered offset 100) and heading two at line 22 (rendered offset 700).
    userScroll(sourceScroller, sourceTopOfLine(15))
    await driveToRest()

    // 100 + (14 / 21) * (700 - 100)
    expect(rendered.scrollTop).toBeCloseTo(500, 3)
  })

  it('measures the text above a document’s first heading from the document’s top', async () => {
    const { rendered, sourceScroller } = await mountSplit(PREAMBLE, HEADED_METRICS)
    fakeHeadingTops(rendered, [200])

    // Scrolled just under its own top, the rendered pane is still above the
    // heading: the source belongs at its top too, not on the heading's line.
    userScroll(rendered, 60)
    await driveToRest()
    expect(topLineOf(sourceScroller)).toBe(1)
    // 0.3 of the way from line 1 to line 4, carried onto the lines themselves.
    expect(sourceScroller.scrollTop).toBeCloseTo(12.6, 3)

    // And from the other side: line 2 is still above the heading, so the
    // rendered pane stays in its own preamble — a third of the way to it.
    userScroll(sourceScroller, LINE_PX)
    await driveToRest()
    expect(rendered.scrollTop).toBeCloseTo(200 / 3, 3)
  })

  it('brings both panes back to scrollTop 0 from the bottom', async () => {
    const { rendered, sourceScroller } = await mountHeaded()

    // Start at the ends: the source pane is the one the user drags. Which pane
    // is the origin decides the direction, so both are exercised below.
    userScroll(sourceScroller, SOURCE_RANGE)
    await driveToRest()
    expect(rendered.scrollTop).toBe(RENDERED_RANGE)

    // One drag back to the top: the rendered pane has to come all the way with
    // it rather than stopping on the nearest heading.
    userScroll(sourceScroller, 0)
    await driveToRest()
    expect(rendered.scrollTop).toBe(0)

    // The same trip with the panes' roles swapped.
    userScroll(rendered, RENDERED_RANGE)
    await driveToRest()
    expect(sourceScroller.scrollTop).toBeCloseTo(SOURCE_RANGE, 3)

    userScroll(rendered, 0)
    await driveToRest()
    expect(sourceScroller.scrollTop).toBe(0)
  })

  it('does not feed its own writes back as user scrolls', async () => {
    const { rendered, sourceScroller } = await mountHeaded()

    // Twenty wheel events land before a single frame runs: they collapse into
    // one leg aimed at the last position, and the program never writes into the
    // pane the user is holding.
    for (let step = 1; step <= 20; step += 1) userScroll(sourceScroller, step * 10)
    await driveToRest()

    expect(sourceScroller.scrollTop).toBe(200)
    expect(topLineOf(sourceScroller)).toBe(15)
    expect(rendered.scrollTop).toBeCloseTo(500, 3)

    // The browser's echo of the program's own write arrives after the fact. It
    // reports a position the program wrote, so it is not a user scroll and must
    // not send the sync back the other way.
    rendered.dispatchEvent(new Event('scroll'))
    await driveToRest()
    expect(rendered.scrollTop).toBeCloseTo(500, 3)
    expect(sourceScroller.scrollTop).toBe(200)

    // Now the other direction, which is where a stuck pane shows up: the
    // rendered pane drives the source, and the user then takes the source back.
    // A write that left a pending suppression behind would swallow that scroll.
    userScroll(rendered, HEADING_TOPS[1])
    await driveToRest()
    expect(sourceScroller.scrollTop).toBeCloseTo(sourceTopOfLine(22), 3)

    userScroll(sourceScroller, 0)
    await driveToRest()
    expect(rendered.scrollTop).toBe(0)
  })
})
