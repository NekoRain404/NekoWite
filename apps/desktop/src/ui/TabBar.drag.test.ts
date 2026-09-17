/**
 * A tab begins a drag, and the payload is the app's own.
 *
 * This is the *producer* half of the gesture the agent panel's composer accepts
 * (`AgentComposer.attachments.test.ts` is the consumer half, and `e2e/agent-panel.spec.ts` drives
 * the two together in a real browser). Before it, the strip had no drag handler of any kind: the
 * only thing in the window that produced a document drag was the vault tree, and nothing consumed
 * it.
 *
 * The case worth stating is the second one. An untitled tab has no path, and a drag of one that
 * carried nothing would be a gesture that ends in the composer refusing a file nobody named — so it
 * is not draggable at all, and a `dragstart` that arrived anyway starts nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import TabBar from './TabBar.vue'
import { useTabsStore, type OpenTab } from '../stores/tabs'
import { DRAGGED_PATH_TYPE } from '../services/drag-payload'

const PATH = '/home/user/vault/note.md'

/**
 * A tab as the store holds one. Only the fields this strip reads are meaningful: `id` names it,
 * `path` is what a drag carries, and everything else is the state a freshly opened document has.
 */
function tab(id: string, path: string | null): OpenTab {
  return {
    id,
    path,
    content: '',
    savedContent: '',
    dirty: false,
    pendingAssetPaths: [],
  }
}

let mounted: VueApp[] = []
let host: HTMLElement
let pinia: Pinia

/** The strip over the store the tabs were put in — one pinia for both, or the component would be
 *  drawing an empty one. */
function mount(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(TabBar)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
}

/** The tab whose `data-tab-id` names it, which is how the strip itself addresses a row. */
const tabElement = (id: string): HTMLElement => {
  const el = host.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)
  if (el === null) throw new Error(`the strip has no ${id} tab`)
  return el
}

/** A `dragstart` over that tab, with a transfer the producer can write into. */
function dragStart(el: HTMLElement): { event: DragEvent; written: Map<string, string> } {
  const written = new Map<string, string>()
  const event = Object.assign(new Event('dragstart', { bubbles: true, cancelable: true }), {
    dataTransfer: {
      effectAllowed: 'none',
      setData: (type: string, value: string) => written.set(type, value),
    },
  }) as unknown as DragEvent
  el.dispatchEvent(event)
  return { event, written }
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  const store = useTabsStore()
  store.tabs.push(tab('t1', PATH), tab('t2', null))
  store.setActive('t1')
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  host?.remove()
})

describe('a tab begins a drag', () => {
  it('carries its document’s path under the app’s own type', () => {
    mount()
    const el = tabElement('t1')
    expect(el.getAttribute('draggable')).toBe('true')

    const { written } = dragStart(el)

    expect(written.get(DRAGGED_PATH_TYPE)).toBe(PATH)
    // ...and the same path as plain text, which is what a drop target outside the app reads.
    expect(written.get('text/plain')).toBe(PATH)
  })

  it('is not offered at all for a tab with no path', async () => {
    mount()
    const el = tabElement('t2')
    expect(el.getAttribute('draggable')).toBe('false')

    const { event, written } = dragStart(el)
    await nextTick()

    expect(written.size).toBe(0)
    expect(event.defaultPrevented).toBe(true)
  })
})
