import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import StatusBar from './StatusBar.vue'
import { useTabsStore, type OpenTab } from '../stores/tabs'
import { useAppearanceStore } from '../stores/appearance'
import { t } from '../i18n'
import { READ_ONLY_PREFIX } from '../stores/write-refusal'

vi.mock('../platform/app-version', () => ({
  readAppVersion: vi.fn().mockResolvedValue('1.0.0'),
  BUILD_VERSION: '1.0.0',
}))

// One refused save, driven through the real store: the status line is the only
// surface left once the toast that reported it has gone.
const readMock = vi.hoisted(() => vi.fn())
const writeMock = vi.hoisted(() => vi.fn())
const saveFileDialogMock = vi.hoisted(() => vi.fn())
vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    write: writeMock,
    list: vi.fn(async () => []),
    watch: vi.fn(async () => () => {}),
    deleteFile: vi.fn(async () => ''),
    stat: vi.fn(async () => ({ size: 0, mtime: 0 })),
    listHistory: vi.fn(async () => []),
    readHistory: vi.fn(async () => ''),
    restoreHistory: vi.fn(async () => ''),
    createDir: vi.fn(async () => ''),
    renameEntry: vi.fn(async () => ''),
    saveFileDialog: saveFileDialogMock,
  },
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
    readMock.mockReset()
    writeMock.mockReset()
    saveFileDialogMock.mockReset()
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

  it('says a save did not land, not merely that nothing is saved yet', async () => {
    // Read-only file, Ctrl+S, and the copy dialog closed: the refusal is
    // complete and the message that explains it lasts three seconds. What is on
    // screen for as long as the tab is open is this bar, and "unsaved" is a
    // different claim from "the save you just made did not get there".
    readMock.mockResolvedValue('on disk')
    writeMock.mockImplementation((_vault: string, path: string) =>
      Promise.reject(new Error(
        `${READ_ONLY_PREFIX}could not replace ${path}: the file is read-only (mode 0444), ` +
        'so it was left untouched; clear the read-only permission to save over it, or ' +
        'save it under a different name',
      )))
    saveFileDialogMock.mockResolvedValue(null)

    const s = useTabsStore()
    s.setVault('/vault')
    await s.openTab('/vault/ro.md')
    const tab = s.tabs[0]
    tab.content = 'typed into a protected file'
    s.markDirty(tab.id)

    const host = mountBar()
    expect(host.textContent).toContain(t('status.dirty'))

    await s.saveActive()
    await nextTick()

    expect(host.textContent).toContain(t('status.failed'))
    expect(host.textContent).not.toContain(t('status.saved'))
    expect(host.querySelector('.status-save')?.getAttribute('data-state')).toBe('failed')
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
