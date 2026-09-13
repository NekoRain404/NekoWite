import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import OutlinePanel from './OutlinePanel.vue'
import { useTabsStore } from '../stores/tabs'

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
