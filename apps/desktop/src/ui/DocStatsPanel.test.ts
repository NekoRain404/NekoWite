import { beforeEach, describe, expect, it, afterEach, vi } from 'vitest'
import {
  createApp,
  defineComponent,
  h,
  nextTick,
  ref,
  vShow,
  withDirectives,
  type App as VueApp,
  type Ref,
} from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import DocStatsPanel from './DocStatsPanel.vue'
import { useTabsStore, type OpenTab } from '../stores/tabs'
import { t } from '../i18n'

/** Counts the document scans, so "the hidden section did not scan" is observed
 *  rather than inferred. */
const statCalls = { count: 0 }
vi.mock('../services/doc-stats', async (orig) => {
  const mod = await orig<typeof import('../services/doc-stats')>()
  return {
    ...mod,
    computeDocStats: (md: string) => {
      statCalls.count += 1
      return mod.computeDocStats(md)
    },
  }
})

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
    // Assert through the active locale rather than the English copy: the panel
    // is localized, so a hardcoded string would pin the test to one language.
    expect(host.textContent).toContain(t('docstats.noTasks'))
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

  it('updates every reading when the document changes', async () => {
    // The memo-invalidation test at the panel's level: the shared reading is
    // keyed on the document, so an edit must move every number.
    seedDoc('Hello world 你好 世界\n\nSecond paragraph')
    const host = mountPanel()
    expect(findStat(host, '8')).not.toBeNull()
    expect(findStat(host, '2')).not.toBeNull()

    useTabsStore().activeTab!.content = 'Hello world 你好 世界\n\nSecond paragraph\n\nThird one here'
    await nextTick()

    expect(findStat(host, '8')).toBeNull()
    expect(findStat(host, '11')).not.toBeNull()
    expect(findStat(host, '3')).not.toBeNull()
  })
})

describe('DocStatsPanel only scans while its rail section is shown', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    document.body.innerHTML = ''
    mounted = []
    statCalls.count = 0
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  function mountSection(shown: Ref<boolean>): HTMLElement {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(
      defineComponent({
        render: () => withDirectives(h(DocStatsPanel), [[vShow, shown.value]]),
      }),
    )
    app.use(pinia)
    app.mount(host)
    mounted.push(app)
    return host
  }

  it('stops scanning the document while another rail section is on screen', async () => {
    seedDoc('# Note\n\nsome text\n')
    const shown = ref(false)
    mountSection(shown)
    await nextTick()

    const afterMount = statCalls.count
    const tabs = useTabsStore()
    tabs.activeTab!.content = '# Note\n\ndifferent text entirely\n'
    await nextTick()
    await nextTick()

    expect(statCalls.count).toBe(afterMount)
  })

  it('shows the current reading when it comes back on screen', async () => {
    seedDoc('# Note\n\nsome text\n')
    const shown = ref(false)
    const host = mountSection(shown)
    await nextTick()

    const tabs = useTabsStore()
    tabs.activeTab!.content = 'five words in this text\n'
    await nextTick()
    await nextTick()

    shown.value = true
    await nextTick()
    await nextTick()

    expect(findStat(host, '5')).not.toBeNull()
  })
})
