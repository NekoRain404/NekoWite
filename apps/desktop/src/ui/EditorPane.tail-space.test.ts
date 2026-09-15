import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { useAppearanceStore } from '../stores/appearance'
import { useTabsStore } from '../stores/tabs'
import { useViewStore } from '../stores/view'

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

// ---------------------------------------------------------------------------
// Layout, which happy-dom does not perform.
//
// Every element is the panel's height except the source pane's own scroller,
// which is SHORTER by a scrollbar: with soft wrap off — the setting this pane
// exists for — a long line puts a horizontal scrollbar inside `.cm-scroller`
// and takes that many pixels off its content box. The rendered pane wraps its
// text, so its scroller (the pane itself) keeps the whole panel height.
//
// That difference is the point of the fake: it is the one panel height the two
// panes really disagree about, and a tail measured per pane inherits it.
// ---------------------------------------------------------------------------

const PANEL_HEIGHT = 400
/** The document, laid out: what the scrollers travel over. */
const CONTENT_HEIGHT = 1600
/** A horizontal scrollbar on the source pane's scroller. */
const SCROLLBAR = 10

const PANEL_SELECTOR = '.panes'
const SOURCE_SCROLLER = '.cm-scroller'

function hasClass(el: Element, name: string): boolean {
  return el.classList?.contains(name) ?? false
}

/** A hidden element has no box: no height, and nothing to scroll. */
function isRendered(el: Element): boolean {
  let node: Element | null = el
  while (node) {
    if ((node as HTMLElement).style?.display === 'none') return false
    node = node.parentElement
  }
  return true
}

function clientHeightOf(el: Element): number {
  if (!isRendered(el)) return 0
  if (hasClass(el, PANEL_SELECTOR.slice(1))) return PANEL_HEIGHT
  if (hasClass(el, SOURCE_SCROLLER.slice(1))) return PANEL_HEIGHT - SCROLLBAR
  return PANEL_HEIGHT
}

/**
 * The trailing space applied to this scroller's content, read the way the
 * browser reads it: an inline custom property on the padded box — the source
 * pane's root, or the rendered pane's content container — which is INSIDE the
 * scroller either way, so the space is part of what the scroller travels over.
 * That is what the space is for, and it is why a range that subtracts it back
 * out stops short of where the pane can be scrolled.
 */
function readPad(el: Element | null): number | null {
  const raw = (el as HTMLElement | null)?.style?.getPropertyValue('--nkw-tail-space') ?? ''
  if (raw === '') return null
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function appliedTailOf(el: Element): number {
  let node: Element | null = el
  while (node) {
    const pad = readPad(node)
    if (pad !== null) return pad
    node = node.parentElement
  }
  // The rendered pane's pad is on a box INSIDE its own scroller (the content
  // container it wraps), so the space is in the content the scroller travels
  // over either way — which is what the space is for, and why a range that
  // subtracts it back out stops short of where the pane can be scrolled.
  return readPad((el as HTMLElement).querySelector('[style*="nkw-tail-space"]')) ?? 0
}

function scrollHeightOf(el: Element): number {
  if (!isRendered(el)) return 0
  return clientHeightOf(el) + CONTENT_HEIGHT + appliedTailOf(el)
}

function installLayout(): void {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return clientHeightOf(this)
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return scrollHeightOf(this)
    },
  })
}

/**
 * A ResizeObserver that behaves like the real one where it matters here: it
 * delivers when an observed element's box changes, including the moment a
 * `display: none` element gains one. happy-dom's own is a no-op stub, so
 * without this a pane measured while hidden would never be corrected — and the
 * tail would look right in every test for the wrong reason.
 */
class FakeResizeObserver {
  static live: FakeResizeObserver[] = []
  private targets = new Set<Element>()
  private reported = new WeakMap<Element, number>()

  constructor(private callback: () => void) {
    FakeResizeObserver.live.push(this)
  }

  observe(el: Element): void {
    this.targets.add(el)
    this.reported.set(el, clientHeightOf(el))
  }

  unobserve(el: Element): void {
    this.targets.delete(el)
  }

  disconnect(): void {
    this.targets.clear()
  }

  /** Deliver to every observer whose box moved since the last delivery. */
  static deliver(): void {
    for (const observer of FakeResizeObserver.live) {
      let moved = false
      for (const el of observer.targets) {
        if (observer.reported.get(el) !== clientHeightOf(el)) moved = true
        observer.reported.set(el, clientHeightOf(el))
      }
      if (moved) observer.callback()
    }
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    FakeResizeObserver.deliver()
    await flush()
    await nextTick()
  }
}

let pinia: Pinia
let mounted: VueApp[] = []

interface Panes {
  source: HTMLElement
  sourceScroller: HTMLElement
  rendered: HTMLElement
  renderedBox: HTMLElement
}

/** Both panes' half of the trailing space, read where each pane writes it: the
 *  source pane on its root, the rendered pane on the content box it pads. */
function tailsOf(panes: Panes): { source: number; rendered: number } {
  return {
    source: parseFloat(panes.source.style.getPropertyValue('--nkw-tail-space')) || 0,
    rendered: parseFloat(panes.renderedBox.style.getPropertyValue('--nkw-tail-space')) || 0,
  }
}

function bottomOf(el: HTMLElement): number {
  return el.scrollHeight - el.clientHeight
}

async function mountSplit(): Promise<Panes> {
  const tabs = useTabsStore()
  tabs.setVault('/vault')
  note.content =
    '# Title\n\n' + Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n\n') + '\n'
  await tabs.openTab('notes/a.md')
  useViewStore().setMode('split')
  const host = document.createElement('div')
  document.body.appendChild(host)
  // Vitest does not settle a dynamic import first triggered inside a component
  // render; importing the async pane here leaves it in the module cache (see
  // EditorPane.scrollSync.test.ts).
  await import('../view/SourcePane.vue')
  const app = createApp(EditorPane)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  for (let i = 0; i < 40; i += 1) {
    await flush()
    if (host.querySelector('.pane.source .cm-scroller')) break
  }
  await settle()
  const panes = {
    source: host.querySelector('.pane.source') as HTMLElement,
    sourceScroller: host.querySelector('.pane.source .cm-scroller') as HTMLElement,
    rendered: host.querySelector('.pane.rendered') as HTMLElement,
    renderedBox: host.querySelector('.pane.rendered .editor-container') as HTMLElement,
  }
  expect(panes.source).not.toBeNull()
  expect(panes.sourceScroller).not.toBeNull()
  expect(panes.rendered).not.toBeNull()
  expect(panes.renderedBox).not.toBeNull()
  return panes
}

/** A scroll the user made: the element moves, then reports it. */
function userScroll(el: HTMLElement, top: number): void {
  el.scrollTop = top
  el.dispatchEvent(new Event('scroll'))
}

describe('the split panes’ trailing space', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    document.body.innerHTML = ''
    mounted = []
    FakeResizeObserver.live = []
    installLayout()
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    useAppearanceStore().setAutoSyncScroll(true)
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('gives both panes the same tail, one panel’s height', async () => {
    const panes = await mountSplit()

    // Not "each pane has a tail": the two have to be the SAME number. A pane
    // that measures its own scroller measures its own scrollbar too, and this
    // one's is shorter than the rendered pane's by exactly that.
    expect(tailsOf(panes)).toEqual({ source: 320, rendered: 320 })
  })

  it('lands the pane the sync moves where the pane the user held is', async () => {
    const panes = await mountSplit()

    // The user drags the source pane to its own end — what a wheel does, and
    // what the sync's own writes cannot do if the range it works in stops one
    // tail short of it.
    userScroll(panes.sourceScroller, bottomOf(panes.sourceScroller))
    await settle()

    // Both panes are then showing the end of the document, each with its own
    // trailing space below the last line: the rendered pane has to be at the
    // bottom its own scrollbar can reach, not one tail above it.
    expect(panes.rendered.scrollTop).toBe(bottomOf(panes.rendered))

    // And the same trip with the panes' roles swapped, which is the direction
    // the user sees flip: whichever pane is driven from the other one is the
    // one that used to stop short.
    userScroll(panes.rendered, bottomOf(panes.rendered))
    await settle()

    expect(panes.sourceScroller.scrollTop).toBe(bottomOf(panes.sourceScroller))
  })

  it('reports a range whose end is the end the pane can be scrolled to', async () => {
    const panes = await mountSplit()

    // The panes' own end, both of them: the number the split sync positions
    // them in is the number their scrollbars travel over.
    expect(bottomOf(panes.sourceScroller)).toBeGreaterThan(0)
    expect(bottomOf(panes.rendered)).toBeGreaterThan(0)

    // A programmatic write to the very end lands there rather than a tail
    // short of it — the same place the user's wheel leaves the pane.
    userScroll(panes.rendered, 0)
    await settle()
    userScroll(panes.rendered, bottomOf(panes.rendered))
    await settle()

    expect(panes.sourceScroller.scrollTop).toBe(bottomOf(panes.sourceScroller))
  })
})
