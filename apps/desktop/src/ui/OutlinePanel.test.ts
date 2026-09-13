import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, vShow, withDirectives, type App as VueApp, type Ref } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import OutlinePanel from './OutlinePanel.vue'
import InfoRail from './InfoRail.vue'
import { useTabsStore } from '../stores/tabs'

// The rail's other sections are not under test here, and mounting them would
// drag in their stores (chat sessions, references, the note list).
vi.mock('../features/chat', () => ({
  ChatPanel: { render: () => null },
}))
vi.mock('./ReferencesPanel.vue', () => ({
  default: { render: () => null },
}))
vi.mock('./FrontmatterPanel.vue', () => ({
  default: { render: () => null },
}))

/** Counts the document scans, so "the hidden section did not parse" is observed
 *  rather than inferred. */
const parseCalls = { count: 0 }
vi.mock('../services/outline', async (orig) => {
  const mod = await orig<typeof import('../services/outline')>()
  return {
    ...mod,
    parseOutline: (md: string) => {
      parseCalls.count += 1
      return mod.parseOutline(md)
    },
  }
})

const readMock = vi.hoisted(() => vi.fn())
const statMock = vi.hoisted(() => vi.fn())
const listHistoryMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    write: vi.fn(),
    list: vi.fn(),
    watch: vi.fn(),
    deleteFile: vi.fn(),
    stat: statMock,
    listHistory: listHistoryMock,
    readHistory: vi.fn(),
    restoreHistory: vi.fn(),
    onFsChange: vi.fn(),
    listTrash: vi.fn(),
    restoreFromTrash: vi.fn(),
  },
}))

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let pinia: Pinia
let mounted: VueApp[] = []

function mountPanel(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(OutlinePanel)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  return host
}

async function openDoc(content: string): Promise<void> {
  const s = useTabsStore()
  s.setVault('/vault')
  readMock.mockResolvedValue(content)
  statMock.mockResolvedValue({ size: content.length, mtime: 100 })
  listHistoryMock.mockResolvedValue([])
  await s.openTab('/vault/a.md')
}

/**
 * Mounts the panel the way InfoRail does: the section stays mounted and is
 * hidden with `v-show` while another section has the tab.
 */
function mountSection(shown: Ref<boolean>): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(
    defineComponent({
      render: () => withDirectives(h(OutlinePanel), [[vShow, shown.value]]),
    }),
  )
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  return host
}

describe('OutlinePanel empty state', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    readMock.mockReset()
    statMock.mockReset()
    listHistoryMock.mockReset()
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  it('shows the "no headings" hint only when the document has no headings', async () => {
    // The hint used to sit outside the list's v-if, so it was appended under
    // every populated outline and read as a broken panel.
    await openDoc('Just prose, no headings at all.')
    const host = mountPanel()
    await flush()

    expect(host.querySelector('.outline-list')).toBeNull()
    expect(host.querySelector('.rail-empty')?.textContent).toContain('没有标题')
  })

  it('does not show the hint next to a populated outline', async () => {
    await openDoc('# One\n\n## Two\n\n### Three')
    const host = mountPanel()
    await flush()

    expect(host.querySelectorAll('.outline-item')).toHaveLength(3)
    const emptyHints = Array.from(host.querySelectorAll('.rail-empty')).map((el) => el.textContent?.trim())
    expect(emptyHints.filter((t) => t?.includes('没有标题'))).toEqual([])
  })
})

describe('OutlinePanel only parses while its rail section is shown', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    readMock.mockReset()
    statMock.mockReset()
    listHistoryMock.mockReset()
    document.body.innerHTML = ''
    mounted = []
    readMock.mockResolvedValue('# One\n\n## Two')
    statMock.mockResolvedValue({ size: 10, mtime: 1 })
    listHistoryMock.mockResolvedValue([])
    parseCalls.count = 0
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  it('stops re-parsing the document while another rail section is on screen', async () => {
    // The rail keeps every section mounted and switches them with v-show, so a
    // hidden outline used to re-parse the whole note on every typing pause.
    await openDoc('# One\n\n## Two')
    const shown = ref(false)
    mountSection(shown)
    await flush()

    const afterMount = parseCalls.count
    const tabs = useTabsStore()
    tabs.activeTab!.content = '# Renamed\n\n## Added'
    await nextTick()
    await nextTick()

    expect(parseCalls.count).toBe(afterMount)
  })

  it('is gated by the real info rail, which hides sections with v-show', async () => {
    // The gate reads the section's own inline display, so the rail's way of
    // hiding a section is load-bearing: this pins it to the real rail markup.
    await openDoc('# One\n\n## Two')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(InfoRail)
    app.use(pinia)
    app.mount(host)
    mounted.push(app)
    await flush()

    const section = host.querySelector<HTMLElement>('.outline-panel')
    expect(section).not.toBeNull()
    // The rail opens on its AI tab: the outline section is mounted but hidden.
    expect(section!.style.display).toBe('none')

    const afterMount = parseCalls.count
    useTabsStore().activeTab!.content = '# Renamed\n\n## Added'
    await nextTick()
    await nextTick()
    expect(parseCalls.count).toBe(afterMount)

    const outlineTab = host.querySelectorAll<HTMLButtonElement>('.rail-tab')[1]
    outlineTab.click()
    await flush()
    await nextTick()

    const texts = Array.from(host.querySelectorAll('.outline-text')).map((el) => el.textContent?.trim())
    expect(texts).toEqual(['Renamed', 'Added'])
  })

  it('shows the current headings when it comes back on screen', async () => {
    // The gate must not leave a stale outline behind: showing the section again
    // re-parses and renders what the document says NOW.
    await openDoc('# One\n\n## Two')
    const shown = ref(false)
    const host = mountSection(shown)
    await flush()

    const tabs = useTabsStore()
    tabs.activeTab!.content = '# Renamed\n\n## Added'
    await nextTick()
    await nextTick()

    shown.value = true
    await flush()
    await nextTick()

    const texts = Array.from(host.querySelectorAll('.outline-text')).map((el) => el.textContent?.trim())
    expect(texts).toEqual(['Renamed', 'Added'])
  })
})
