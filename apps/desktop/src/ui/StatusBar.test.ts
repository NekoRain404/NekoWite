import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import StatusBar from './StatusBar.vue'
import { useTabsStore, type OpenTab } from '../stores/tabs'
import { useAppearanceStore } from '../stores/appearance'
import { t } from '../i18n'

vi.mock('../platform/app-version', () => ({
  readAppVersion: vi.fn().mockResolvedValue('1.0.0'),
  BUILD_VERSION: '1.0.0',
}))

let pinia: Pinia
let mounted: VueApp[] = []

function mountBar(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(StatusBar)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  return host
}

function seedDoc(content: string): OpenTab {
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
  return tab
}

describe('StatusBar readings', () => {
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

  it('shows the word, character and reading-time readings of the active note', () => {
    // '# Title' + 'hello world' + '你好' = 6 words by the CJK/latin rule.
    const content = '# Title\n\nhello world 你好\n'
    seedDoc(content)
    const host = mountBar()

    expect(host.textContent).toContain(t('status.words', { n: 6 }))
    expect(host.textContent).toContain(t('status.chars', { n: content.length }))
    expect(host.textContent).toContain(t('status.readMinutes', { n: 1 }))
  })

  it('updates every reading when the document changes', async () => {
    // What a memo keyed wrongly would break: the bar must never show the
    // previous note's numbers after an edit.
    seedDoc('one two three\n')
    const host = mountBar()
    expect(host.textContent).toContain(t('status.words', { n: 3 }))

    const tab = useTabsStore().activeTab!
    tab.content = 'one two three four five\n'
    await nextTick()

    expect(host.textContent).toContain(t('status.words', { n: 5 }))
    expect(host.textContent).toContain(t('status.readMinutes', { n: 1 }))
  })

  it('shows the task counter, marking it done when every task is checked', async () => {
    seedDoc('- [ ] one\n- [x] two\n')
    const host = mountBar()
    expect(host.textContent).toContain(t('status.tasks', { done: 1, total: 2 }))
    expect(host.querySelector('.status-task')?.classList.contains('is-done')).toBe(false)

    useTabsStore().activeTab!.content = '- [x] one\n- [x] two\n'
    await nextTick()

    expect(host.textContent).toContain(t('status.tasks', { done: 2, total: 2 }))
    expect(host.querySelector('.status-task')?.classList.contains('is-done')).toBe(true)
  })

  it('hides the word group when the preference is off, keeping the task counter', () => {
    seedDoc('- [ ] one\n')
    useAppearanceStore().setStatusBarWords(false)
    const host = mountBar()

    // '- [ ] one' counts as 4 whitespace-separated runs; whatever the number,
    // the word group is off and must not be rendered at all.
    expect(host.textContent).not.toContain(t('status.words', { n: 4 }))
    expect(host.textContent).toContain(t('status.tasks', { done: 0, total: 1 }))
  })
})
