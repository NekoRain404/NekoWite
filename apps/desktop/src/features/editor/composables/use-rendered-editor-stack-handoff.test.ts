/**
 * Switching documents hands the model's pending text to the document it belongs
 * to, before the model is given another one.
 *
 * The rendered pane publishes `tab.content` through a 120 ms debounce, so for
 * that window after a keystroke the tab holds the PREVIOUS text and the model
 * holds the new one. Switching tabs used to leave the serialization to fire
 * afterwards, by which time the watcher had re-opened the model on the next
 * note and the publish was discarded as stale (it was: the text was no longer
 * the open document's). The tail was then in neither the tab nor the file, and
 * coming back to the note showed the text from before it.
 *
 * L04's fix direction is a hand-off boundary — not a longer debounce: the 120 ms
 * window was argued on its own merits (a full markdown round trip per keystroke
 * burst), and moving it would only shorten the window this happens in. So the
 * switch publishes the leaving document's model into the tab it belongs to, by
 * that tab's identity, before `open()` replaces the model.
 *
 * The switch here is the real one: the real tabs store, the real rendered
 * editor (Milkdown/ProseMirror), the real persistence layer and the real
 * debounce. `setActive` is the call the tab bar's click, its keyboard
 * navigation, and every "open another note" path funnel through.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, ref, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { useTabsStore } from '../../../stores/tabs'

const readMock = vi.hoisted(() => vi.fn())
vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
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
    resolveMediaPath: vi.fn(),
  },
}))

import { useRenderedEditorStack } from './use-rendered-editor-stack'

/** Let the Vue scheduler (and every promise chain behind it) run out. Microtask
 *  only, so it works with the fake timers the switch tests use. */
async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
  await nextTick()
}

/** A real macrotask — the editor's own mount needs one. Only valid before the
 *  fake clock goes on. */
const realFlush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let pinia: Pinia
let mounted: VueApp[] = []

function mountStack() {
  const scrollEl = ref<HTMLElement | null>(null)
  const editorEl = ref<HTMLElement | null>(null)
  let api: ReturnType<typeof useRenderedEditorStack> | null = null
  const host = defineComponent({
    setup() {
      api = useRenderedEditorStack({
        getScrollEl: () => scrollEl.value,
        getEditorEl: () => editorEl.value,
        handlers: { onEditorClick: () => {}, onKeydown: () => {} },
      })
      return () => h('div', { ref: scrollEl }, [h('div', { ref: editorEl })])
    },
  })
  const app = createApp(host)
  app.use(pinia)
  app.mount(document.createElement('div'))
  mounted.push(app)
  return api as unknown as ReturnType<typeof useRenderedEditorStack>
}

/** The two open notes, with `a.md` active and its model mounted — mounted under
 *  REAL timers, because the editor stack's own mount awaits timers of its own
 *  and the fake clock below is only for the 120 ms publish window. */
async function twoNotesOpen() {
  const tabs = useTabsStore()
  tabs.setVault('/vault')
  readMock.mockImplementation(async (_vault: string, path: string) =>
    path.endsWith('a.md') ? 'alpha\n' : 'beta\n',
  )
  await tabs.openTab('notes/b.md')
  await tabs.openTab('notes/a.md')
  const stack = mountStack()
  await realFlush()
  await realFlush()
  await settle(16)
  const a = tabs.tabs.find((t) => t.path === 'notes/a.md')!
  const b = tabs.tabs.find((t) => t.path === 'notes/b.md')!
  expect(tabs.activeId).toBe(a.id)
  expect(await stack.editorForPanel.value?.save()).toContain('alpha')
  return { tabs, stack, a, b }
}

/** One keystroke in the rendered model — the doc change ProseMirror dispatches,
 *  which is what marks the tab dirty at the keystroke. */
function typeIntoTheModel(stack: ReturnType<typeof useRenderedEditorStack>, text: string): void {
  const view = stack.editorForPanel.value!.getView()
  view.dispatch(view.state.tr.insertText(text, 1))
}

describe('a document switch while the rendered pane is mid-debounce', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    document.body.innerHTML = ''
    mounted = []
    readMock.mockReset()
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it.each([0, 50, 119])(
    'a switch %i ms after the keystroke carries the tail to the note it was typed in',
    async (delay) => {
      const { tabs, stack, a, b } = await twoNotesOpen()
      expect(a.content).toBe('alpha\n')

      // Fake timers only around the window being tested: the keystroke arms
      // the 120 ms publish debounce, which is the thing the switch races.
      vi.useFakeTimers()
      typeIntoTheModel(stack, 'X')
      expect(a.dirty).toBe(true)
      // The tail is in the model, not yet in the tab — the debounce window.
      expect(a.content).toBe('alpha\n')

      tabs.setActive(b.id)
      await vi.advanceTimersByTimeAsync(delay)
      await settle()

      // The claim: the text the user typed before switching is in the tab they
      // typed it in, not gone with the model.
      expect(tabs.tabs.find((t) => t.id === a.id)?.content).toContain('Xalpha')

      // ...and coming back gives the model that text, tail included.
      tabs.setActive(a.id)
      await vi.advanceTimersByTimeAsync(400)
      await settle(16)
      expect(await stack.editorForPanel.value?.save()).toContain('Xalpha')
    },
  )

  it('carries the tail when another note is opened instead of switched to', async () => {
    const { tabs, stack, a } = await twoNotesOpen()
    vi.useFakeTimers()
    typeIntoTheModel(stack, 'X')
    expect(a.content).toBe('alpha\n')

    readMock.mockResolvedValue('gamma\n')
    await tabs.openTab('notes/c.md')
    await vi.advanceTimersByTimeAsync(400)
    await settle()

    expect(tabs.tabs.find((t) => t.id === a.id)?.content).toContain('Xalpha')
  })

  it('carries the tail when a new document is opened instead of switched to', async () => {
    const { tabs, stack, a } = await twoNotesOpen()
    vi.useFakeTimers()
    typeIntoTheModel(stack, 'X')

    await tabs.openTab(null)
    await vi.advanceTimersByTimeAsync(400)
    await settle()

    expect(tabs.tabs.find((t) => t.id === a.id)?.content).toContain('Xalpha')
  })

  it('does not write the leaving note’s text into the one being opened', async () => {
    const { tabs, stack, a, b } = await twoNotesOpen()
    vi.useFakeTimers()
    typeIntoTheModel(stack, 'X')
    tabs.setActive(b.id)
    await vi.advanceTimersByTimeAsync(400)
    await settle()

    // The other direction of the same boundary: the tail belongs to a.md, so
    // b.md must still hold exactly what the file holds.
    expect(b.content).toBe('beta\n')
    expect(tabs.tabs.find((t) => t.id === a.id)?.content).toContain('Xalpha')
  })

  it('a switch that interrupts another switch still opens the note asked for last', async () => {
    const { tabs, stack, a, b } = await twoNotesOpen()
    vi.useFakeTimers()
    readMock.mockImplementation(async (_vault: string, path: string) => {
      if (path.endsWith('a.md')) return 'alpha\n'
      if (path.endsWith('b.md')) return 'beta\n'
      return 'gamma\n'
    })
    await tabs.openTab('notes/c.md')
    // Back to a.md, then two switches with the hand-off still running: the
    // hand-off is an await (a whole-document serialization), so a second
    // switch can arrive while the first is mid-switch.
    tabs.setActive(a.id)
    await vi.advanceTimersByTimeAsync(400)
    await settle()
    expect(await stack.editorForPanel.value?.save()).toContain('alpha')

    tabs.setActive(b.id)
    await nextTick()
    tabs.setActive(tabs.tabs.find((t) => t.path === 'notes/c.md')!.id)
    await vi.advanceTimersByTimeAsync(400)
    await settle(16)

    // The model holds the note the user asked for last, not the one the
    // interrupted switch was still opening.
    expect(await stack.editorForPanel.value?.save()).toContain('gamma')
    expect(tabs.tabs.find((t) => t.path === 'notes/b.md')?.content).toBe('beta\n')
  })
})
