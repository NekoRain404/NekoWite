import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import SourcePane from './SourcePane.vue'
import { useAppearanceStore } from '../stores/appearance'
import { useTabsStore } from '../stores/tabs'

// The pane's job here is only to publish a direction; CodeMirror itself is
// exercised elsewhere, and its real host cannot run in happy-dom.
vi.mock('../services/codeMirrorHost', () => ({
  createCodeMirrorHost: () => ({
    mount: vi.fn(),
    getView: () => null,
    setText: vi.fn(),
    flush: vi.fn(),
    reconfigure: vi.fn(),
    destroy: vi.fn(),
  }),
}))

const readMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    write: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    watch: vi.fn(),
    stat: vi.fn(),
    onFsChange: vi.fn().mockResolvedValue(() => undefined),
    listHistory: vi.fn().mockResolvedValue([]),
    listTrash: vi.fn().mockResolvedValue([]),
  },
}))

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let pinia: Pinia
let mounted: VueApp[] = []

function mountPane(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(SourcePane)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  return host
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  readMock.mockReset()
  readMock.mockResolvedValue('# hello')
  document.body.innerHTML = ''
  mounted = []
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

async function openDoc(content: string): Promise<void> {
  const tabs = useTabsStore()
  tabs.setVault('/vault')
  readMock.mockResolvedValue(content)
  await tabs.openTab('/vault/a.md')
}

describe('SourcePane content direction', () => {
  it('follows the document when the setting is auto', async () => {
    // The rendered pane already honoured the "content direction" setting; the
    // source pane did not, so split mode showed the same Arabic/Hebrew note
    // LTR on the left and RTL on the right.
    await openDoc('# عنوان عربي')
    const host = mountPane()
    await flush()
    await nextTick()

    expect(host.querySelector('[data-testid="source-pane"]')!.getAttribute('dir')).toBe('rtl')
  })

  it('reacts to the setting changing while the pane is open', async () => {
    await openDoc('# plain latin text')
    const host = mountPane()
    await flush()
    await nextTick()
    const pane = host.querySelector('[data-testid="source-pane"]')!
    expect(pane.getAttribute('dir')).toBe('ltr')

    // The setting is reactive; the pane has to follow it without a reload,
    // exactly like the rendered pane does.
    useAppearanceStore().setContentDirection('rtl')
    await nextTick()
    expect(pane.getAttribute('dir')).toBe('rtl')

    useAppearanceStore().setContentDirection('auto')
    await nextTick()
    expect(pane.getAttribute('dir')).toBe('ltr')
  })
})
