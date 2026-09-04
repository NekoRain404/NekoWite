import { beforeEach, describe, expect, it, afterEach } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import DocStatsPanel from './DocStatsPanel.vue'
import { useTabsStore, type OpenTab } from '../stores/tabs'

let pinia: Pinia
let mounted: VueApp[] = []

function mountPanel(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(DocStatsPanel)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  return host
}

function seedDoc(content: string): void {
  const s = useTabsStore()
  const tab: OpenTab = {
    id: 't1',
    path: '/vault/a.md',
    content,
    savedContent: content,
    dirty: false,
    pendingAssetPaths: [],
  }
  s.tabs.push(tab)
  s.activeId = tab.id
}

function findStat(host: HTMLElement, value: string): Element | null {
  return (
    Array.from(host.querySelectorAll('.stat-value')).find(
      (el) => el.textContent?.trim() === value,
    ) ?? null
  )
}

describe('DocStatsPanel', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  it('shows zeroed stats when no document is open', () => {
    const host = mountPanel()
    expect(findStat(host, '0')).not.toBeNull()
    expect(host.textContent).toContain('No tasks in this document.')
  })

  it('renders live stats for the active document content', () => {
    seedDoc('Hello world 你好 世界\n\nSecond paragraph')
    const host = mountPanel()
    expect(findStat(host, '8')).not.toBeNull()
    expect(findStat(host, String('Hello world 你好 世界\n\nSecond paragraph'.length))).not.toBeNull()
    expect(findStat(host, '2')).not.toBeNull()
  })

  it('renders the task progress bar with done/total', () => {
    seedDoc('- [ ] todo\n- [x] done\n')
    const host = mountPanel()
    expect(host.textContent).toContain('1/2')
    const fill = host.querySelector<HTMLElement>('.task-bar-fill')
    expect(fill).not.toBeNull()
    expect(fill?.style.width).toBe('50%')
  })
})
