import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { NodeSelection } from '@milkdown/prose/state'
import { createEditor, basicPlugins } from '@nekowite/editor-core'
import type { NekoEditor } from '@nekowite/editor-core'
import ImagePanel from './ImagePanel.vue'

/**
 * Where the panel opens, which is the report this file exists for: it used to
 * be `absolute; top: 0` in the editing column's own stylesheet — the top of the
 * DOCUMENT, which on any note longer than a screen is nowhere near the image
 * being edited.
 *
 * happy-dom lays nothing out, so every rect is zero and a panel placed from
 * rects would land somewhere invisible for a reason that has nothing to do with
 * the component. The rects below are the shape these assertions are written
 * against, and only the six box fields are read on this path.
 */
type RectFixture = Pick<DOMRect, 'top' | 'left' | 'right' | 'bottom' | 'width' | 'height'>

const PANE: RectFixture = { top: 100, left: 500, right: 1280, bottom: 720, width: 780, height: 620 }
const IMAGE: RectFixture = { top: 300, left: 520, right: 820, bottom: 500, width: 300, height: 200 }
/** The panel's own box, which it is placed from (a column of fields). */
const SELF: RectFixture = { top: 0, left: 0, right: 240, bottom: 330, width: 240, height: 330 }

let paneRect: RectFixture = { ...PANE }
let imageRect: RectFixture = { ...IMAGE }

function installRects(): void {
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const cls = typeof this.className === 'string' ? this.className : ''
    const r = cls.includes('neko-image-panel')
      ? SELF
      : cls.includes('neko-image')
        ? imageRect
        : cls.includes('rendered-pane')
          ? paneRect
          : null
    const zero: RectFixture = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
    return (r ?? zero) as DOMRect
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
/** A frame for the rAF-coalesced re-place, which does not run on microtasks. */
const frame = (): Promise<void> => new Promise((r) => setTimeout(r, 40))

let mounted: VueApp[] = []
let editors: NekoEditor[] = []

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  editors.forEach((ed) => ed.destroy())
  editors = []
  document.body.innerHTML = ''
  paneRect = { ...PANE }
  imageRect = { ...IMAGE }
})

type Mounted = { editor: NekoEditor; pane: HTMLElement; positions: number[] }

async function mountPanelInPane(markdown: string): Promise<Mounted> {
  installRects()
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createEditor(el, { plugins: basicPlugins })
  await editor.open(markdown)
  editors.push(editor)

  // The pane is what the panel is clamped to and what its scroll events come
  // from; the editor's DOM has to be inside it for the composable to find it.
  const pane = document.createElement('div')
  pane.className = 'rendered-pane pane rendered'
  const mountPoint = document.createElement('div')
  pane.appendChild(mountPoint)
  document.body.appendChild(pane)
  pane.appendChild(editor.getView().dom)

  const app = createApp(ImagePanel, { editor })
  app.mount(mountPoint)
  mounted.push(app)

  const positions: number[] = []
  editor.getView().state.doc.descendants((n, p) => {
    if (n.type.name === 'image') positions.push(p)
    return true
  })
  return { editor, pane, positions }
}

function select(editor: NekoEditor, pos: number): void {
  editor.getView().dispatch(
    editor.getView().state.tr.setSelection(NodeSelection.create(editor.getView().state.doc, pos)),
  )
}

function panelEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.neko-image-panel')
}

describe('the image panel is anchored to the image it edits', () => {
  it('opens beside the selected image rather than at the top of the document', async () => {
    const { editor, positions } = await mountPanelInPane('text\n\n![img](attachments/a.png)\n')
    select(editor, positions[0])
    await flush()

    const panel = panelEl()!
    expect(panel).toBeTruthy()
    // Beside the image, tops level: 820 + 8 = 828 across, the image's own top
    // down. (The old panel was at the column's top-right corner, which on a long
    // note is a screen away — and off-screen entirely once scrolled.)
    expect(panel.style.top).toBe('300px')
    expect(panel.style.left).toBe('828px')
  })

  it('follows the image when the pane scrolls, and only its coordinates move', async () => {
    const { editor, pane, positions } = await mountPanelInPane('text\n\n![img](attachments/a.png)\n')
    select(editor, positions[0])
    await flush()
    const before = editor.getView().state.doc

    // The pane scrolls: the image moves up and the pane's own box does not.
    imageRect = { top: 180, left: 520, right: 820, bottom: 380, width: 300, height: 200 }
    pane.dispatchEvent(new Event('scroll'))
    await frame()

    expect(panelEl()!.style.top).toBe('180px')
    // No re-parse, no rebuild: the same document object, unchanged.
    expect(editor.getView().state.doc).toBe(before)
  })

  it('moves to the other image when the selection moves to it', async () => {
    const floor = PANE.bottom
    const { editor, positions } = await mountPanelInPane(
      '![one](attachments/a.png)\n\n![two](attachments/b.png)\n',
    )
    select(editor, positions[0])
    await flush()
    expect(panelEl()!.style.top).toBe('300px')

    imageRect = { top: 600, left: 520, right: 820, bottom: 700, width: 300, height: 100 }
    select(editor, positions[1])
    await flush()

    // The panel's subject is the selection: it follows the new image rather
    // than closing (closing would cost a second gesture for one intent), and it
    // is clamped inside the pane, whose floor is 720.
    expect(panelEl()!.style.top).toBe(`${floor - 8 - SELF.height}px`)
    expect(panelEl()!.style.left).toBe('828px')
  })

  it('clamps into the pane when the image is scrolled out of it, rather than closing', async () => {
    const { editor, pane, positions } = await mountPanelInPane('text\n\n![img](attachments/a.png)\n')
    select(editor, positions[0])
    await flush()

    // The scroll that takes the image past the pane's top edge.
    imageRect = { top: -300, left: 520, right: 820, bottom: -100, width: 300, height: 200 }
    pane.dispatchEvent(new Event('scroll'))
    await frame()

    // Still on screen, against the pane's top edge: the panel belongs to a
    // SELECTION, which survives scrolling, and a panel that vanished and came
    // back would re-run its focus trap on every pass.
    expect(panelEl()).toBeTruthy()
    expect(panelEl()!.style.top).toBe(`${PANE.top + 8}px`)
  })
})
