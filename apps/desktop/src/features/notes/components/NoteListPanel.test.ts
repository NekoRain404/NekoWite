import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import NoteListPanel from './NoteListPanel.vue'
import { FileTree } from '../../vault'
import { useFileTreeStore } from '../../../stores/file-tree'
import { useDocumentListStore } from '../../../stores/document-list'
import type { PanelMode } from '../../../stores/document-list'
import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { t } from '../../../i18n'

const fsMocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  stat: vi.fn(),
  list: vi.fn(),
  watch: vi.fn(),
  deleteFile: vi.fn(),
  renameEntry: vi.fn(),
  createDir: vi.fn(),
  openFolderDialog: vi.fn(),
  saveFileDialog: vi.fn(),
  onFsChange: vi.fn(),
  listTrash: vi.fn(),
  restoreFromTrash: vi.fn(),
  clearTrash: vi.fn(),
  listHistory: vi.fn(),
  readHistory: vi.fn(),
  restoreHistory: vi.fn(),
  saveAttachment: vi.fn(),
  resolveMediaPath: vi.fn(),
}))

vi.mock('../../../platform/gateways/fs', () => ({ fsService: fsMocks }))

let pinia: Pinia
let host: HTMLElement | null = null
let mounted: VueApp[] = []

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function mountPanel(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(NoteListPanel)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
}

describe('NoteListPanel truncation notice', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  afterEach(() => {
    for (const app of mounted) app.unmount()
    mounted = []
    host?.remove()
    host = null
  })

  it('does not show the notice when the vault is not truncated', async () => {
    useFileTreeStore().vaultTruncated = false
    mountPanel()
    await flush()
    expect(host!.textContent).not.toContain('截断')
    expect(host!.textContent).not.toContain('listing truncated')
  })

  it('surfaces the truncation signal to the user when the vault walk was capped', async () => {
    useFileTreeStore().vaultTruncated = true
    useDocumentListStore().indexing = false
    mountPanel()
    await flush()
    // The default test locale is zh, so the notice resolves to the zh string.
    expect(host!.textContent).toContain('笔记库过大')
  })
})

describe('NoteListPanel outline rows', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    host?.remove()
    host = null
  })

  /**
   * The note from the bug report: a frontmatter block of four lines and its
   * only heading on the fifth, so a body-relative index (0) and the heading's
   * own line cannot be mistaken for one another.
   */
  const NOTE = '---\ntitle: x\ntags: [a]\n---\n# Beta\n'
  const BETA_LINE = 5

  it('names the heading’s own line and jumps to it, not into the YAML', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    tabs.tabs.push({
      id: 't1',
      path: '/vault/beta.md',
      content: NOTE,
      savedContent: NOTE,
      dirty: false,
      pendingAssetPaths: [],
    })
    tabs.setActive('t1')
    useDocumentListStore().setPanelMode('outline')
    mountPanel()
    await flush()

    const row = host!.querySelector<HTMLButtonElement>('.outline-item')
    expect(row).not.toBeNull()
    expect(row!.querySelector('.outline-text')?.textContent?.trim()).toBe('Beta')
    // The tooltip the user reads, against the line the heading is really on. It
    // read "跳转到第 1 行" — the opening `---`, which is also the line the jump
    // handed the pane, and a keystroke is inserted where the caret is.
    expect(row!.title).toBe(t('notelist.jumpLine', { n: BETA_LINE }))

    // And that is the line the jump asks the editor for: the consumer adds one,
    // so the outline's own numbering is 0-based.
    row!.click()
    await flush()
    expect(useViewStore().pendingOutlineTarget).toEqual({ line: BETA_LINE - 1, index: 0 })
  })
})

describe('the document panels the mode switch adds to the column', () => {
  /** Every mode the rail gave up, with the panel it has to show. */
  const PANELS: ReadonlyArray<[PanelMode, string]> = [
    ['references', '.references-panel'],
    ['history', '.history-panel'],
    ['frontmatter', '.frontmatter-panel'],
    ['stats', '.doc-stats-panel'],
  ]

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    document.body.innerHTML = ''
    mounted = []
    fsMocks.listHistory.mockReset()
    fsMocks.listHistory.mockResolvedValue([{ id: 'ver-1', size: 100, mtime: 100 }])
    fsMocks.read.mockReset()
    fsMocks.read.mockResolvedValue('# a')
    // Two notes open, the first active: the host test below switches between
    // them, and `openTab` is deliberately not used to do it (it reads the
    // version list itself, which would be counted as the panel's doing).
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    tabs.tabs.push({
      id: 't1',
      path: '/vault/a.md',
      content: '# a',
      savedContent: '# a',
      dirty: false,
      pendingAssetPaths: [],
    })
    tabs.tabs.push({
      id: 't2',
      path: '/vault/b.md',
      content: '# b',
      savedContent: '# b',
      dirty: false,
      pendingAssetPaths: [],
    })
    tabs.setActive('t1')
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    host?.remove()
    host = null
  })

  it('shows the panel of the mode that was chosen, and unmounts the others', async () => {
    mountPanel()
    await flush()
    // The column opens on the note list: none of the four is mounted.
    for (const [, selector] of PANELS) expect(host!.querySelector(selector)).toBeNull()

    for (const [mode, selector] of PANELS) {
      useDocumentListStore().setPanelMode(mode)
      await flush()
      expect(host!.querySelector(selector), `${mode} shows ${selector}`).not.toBeNull()
      for (const [other, otherSelector] of PANELS) {
        if (other === mode) continue
        expect(
          host!.querySelector(otherSelector),
          `${mode} must not also show ${otherSelector}`,
        ).toBeNull()
      }
    }

    // And back out again: the chain unmounts rather than hides, which is what
    // keeps a hidden panel from reading (see the history test below).
    useDocumentListStore().setPanelMode('notes')
    await flush()
    for (const [, selector] of PANELS) expect(host!.querySelector(selector)).toBeNull()
  })

  it('offers every mode in the switch, each still named for the user', async () => {
    // The switch is icons only — seven labelled buttons measure ~600px and the
    // column can be dragged to 200px — so the label lives in the tooltip and the
    // accessible name, and this switcher is the only way in to any of these
    // panels. A mode that loses its name here has lost its only handle.
    mountPanel()
    await flush()
    const buttons = [...host!.querySelectorAll<HTMLButtonElement>('.nl-mode-btn')]

    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      t('notelist.notes'),
      t('notelist.outline'),
      t('notelist.links'),
      t('references.title'),
      t('history.title'),
      t('frontmatter.title'),
      t('docstats.title'),
    ])
    // The wiki-links entry and the citations entry are different features with
    // names that sound alike, so they must not resolve to the same label.
    expect(t('references.title')).not.toBe(t('notelist.links'))

    // And the last of them reaches its own mode.
    buttons[3].click()
    await flush()
    expect(useDocumentListStore().panelMode).toBe('references')
    expect(host!.querySelector('.references-panel')).not.toBeNull()
  })

  it('keeps the citations panel and the wiki links apart', async () => {
    // `links` is wiki links between notes; `references` is the bibliography of
    // the open note's `@cite` keys. Two different features whose names sound
    // alike — the column must never show one where the other belongs.
    mountPanel()
    await flush()
    useDocumentListStore().setPanelMode('links')
    await flush()
    expect(host!.querySelector('.references-panel')).toBeNull()

    useDocumentListStore().setPanelMode('references')
    await flush()
    expect(host!.querySelector('.references-panel')).not.toBeNull()
    expect(host!.querySelectorAll('.nl-group-label')).toHaveLength(0)
  })

  it('reads the history only while its mode is the one on screen', async () => {
    // The regression this guards was measured, not theoretical: a history panel
    // left mounted behind another section issued a `listHistory` IPC read per
    // typing pause. The column unmounts what is not on screen — that is what
    // replaced `useSectionShown`'s gate — so a mode that is not showing must
    // touch the filesystem not at all, and the panel still looks right either
    // way.
    mountPanel()
    await flush()
    expect(fsMocks.listHistory).not.toHaveBeenCalled()

    useDocumentListStore().setPanelMode('history')
    await flush()
    expect(fsMocks.listHistory).toHaveBeenCalledTimes(1)
    expect(host!.querySelector('.history-panel')).not.toBeNull()

    // Typing is not a reason to read: a version only appears when a save writes
    // one. (`HistoryPanel.test.ts` owns this half of the policy.)
    const tabs = useTabsStore()
    tabs.tabs[0].content = '# typed'
    tabs.markDirty('t1')
    await flush()
    await flush()
    expect(fsMocks.listHistory).toHaveBeenCalledTimes(1)

    // Away from the mode the section is gone, so neither a note switch nor more
    // typing asks for anything.
    useDocumentListStore().setPanelMode('notes')
    await flush()
    expect(host!.querySelector('.history-panel')).toBeNull()
    tabs.setActive('t2')
    await flush()
    await flush()
    tabs.tabs[1].content = '# typed as well'
    tabs.markDirty('t2')
    await flush()
    await flush()
    expect(fsMocks.listHistory).toHaveBeenCalledTimes(1)

    // Coming back shows what is current: mounting is the read.
    useDocumentListStore().setPanelMode('history')
    await flush()
    expect(fsMocks.listHistory).toHaveBeenCalledTimes(2)
    expect(host!.querySelectorAll('.history-item')).toHaveLength(1)
  })
})

describe('FileTree create/rename/delete flows (A4)', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    fsMocks.list.mockReset()
    fsMocks.list.mockResolvedValue([])
    fsMocks.write.mockReset()
    fsMocks.read.mockReset()
    fsMocks.read.mockResolvedValue('# hello')
    fsMocks.watch.mockReset()
    fsMocks.watch.mockResolvedValue(undefined)
    fsMocks.onFsChange.mockReset()
    fsMocks.onFsChange.mockResolvedValue(() => {})
    fsMocks.deleteFile.mockReset()
    fsMocks.deleteFile.mockResolvedValue('trash-key')
    fsMocks.createDir.mockReset()
    fsMocks.createDir.mockResolvedValue('x')
    fsMocks.renameEntry.mockReset()
    fsMocks.renameEntry.mockResolvedValue('x')
    fsMocks.listHistory.mockReset()
    fsMocks.listHistory.mockResolvedValue([])
    fsMocks.stat.mockReset()
    fsMocks.stat.mockResolvedValue({ size: 1, mtime: 1 })
    fsMocks.resolveMediaPath.mockReset()
    fsMocks.saveAttachment.mockReset()
    document.body.innerHTML = ''
    mounted = []
  })

  afterEach(() => {
    mounted.forEach((app) => app.unmount())
    mounted = []
    host?.remove()
    host = null
  })

  function mountTree(): HTMLElement {
    host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(FileTree, { vault: '/vault' })
    app.use(pinia)
    app.mount(host)
    mounted.push(app)
    return host
  }

  /** Type `name` into the active inline edit input and press Enter. */
  async function submitInlineEdit(tree: HTMLElement, name: string): Promise<void> {
    const input = tree.querySelector('.tree-inline-input') as HTMLInputElement
    expect(input).not.toBeNull()
    input.value = name
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush()
    await flush()
  }

  function clickMenuLabel(label: string): void {
    const item = [...document.body.querySelectorAll<HTMLButtonElement>('.ctx-menu-item')].find(
      (b) => b.querySelector('.ctx-menu-label')?.textContent === label,
    )
    expect(item, `context menu item ${label}`).toBeDefined()
    item!.click()
  }

  function clickConfirmDelete(tree: HTMLElement): void {
    const btn = [...tree.querySelectorAll<HTMLButtonElement>('.tree-del-confirm button')].find(
      (b) => b.textContent?.trim() === '确认',
    )
    expect(btn).toBeDefined()
    btn!.click()
  }

  it('createDir sends the vault path (root + name) and refreshes the listing', async () => {
    const tree = mountTree()
    await flush()
    // Initial mount listing.
    expect(fsMocks.list.mock.calls.length).toBeGreaterThan(0)

    ;(tree.querySelector('[title="新建文件夹"]') as HTMLButtonElement).click()
    await flush()
    const before = fsMocks.list.mock.calls.length
    await submitInlineEdit(tree, 'notes')

    expect(fsMocks.createDir).toHaveBeenCalledWith('/vault', '/vault/notes')
    // refreshAncestors re-listed the parent after the create.
    expect(fsMocks.list.mock.calls.length).toBeGreaterThan(before)
    // The inline edit row closed on success.
    expect(tree.querySelector('.tree-inline-input')).toBeNull()
  })

  it('createNote writes the file and opens it in a tab', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    const tree = mountTree()
    await flush()

    ;(tree.querySelector('[title="新建文件"]') as HTMLButtonElement).click()
    await flush()
    await submitInlineEdit(tree, 'new.md')

    expect(fsMocks.write).toHaveBeenCalledWith('/vault', '/vault/new.md', '')
    expect(tabs.tabs.some((t) => t.path === '/vault/new.md')).toBe(true)
    // The newly created file opened in the editor, so the listing was refreshed.
    expect(fsMocks.list.mock.calls.length).toBeGreaterThan(1)
  })

  it('rename routes through renameEntry and updates the open tab path', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    fsMocks.list.mockResolvedValue([
      { name: 'a.md', path: '/vault/a.md', is_dir: false, is_mdx: true },
    ])
    const tree = mountTree()
    await flush()
    await tabs.openTab('/vault/a.md')
    expect(tabs.tabs).toHaveLength(1)

    // Right-click the row -> context menu -> rename. (The first tree row is the
    // vault root, whose menu has no rename item; pick the a.md row instead.)
    const row = [...tree.querySelectorAll<HTMLElement>('.tree-row')].find((r) =>
      r.textContent?.includes('a.md'),
    )!
    expect(row).toBeDefined()
    row.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
    )
    await flush()
    clickMenuLabel('重命名')
    await flush()

    await submitInlineEdit(tree, 'b.md')
    expect(fsMocks.renameEntry).toHaveBeenCalledWith('/vault', '/vault/a.md', '/vault/b.md')
    expect(tabs.tabs[0].path).toBe('/vault/b.md')
    expect(tree.querySelector('.tree-inline-input')).toBeNull()
  })

  it('delete with an open tab routes through the gateway and closes the tab', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    fsMocks.list.mockResolvedValue([
      { name: 'a.md', path: '/vault/a.md', is_dir: false, is_mdx: true },
    ])
    const tree = mountTree()
    await flush()
    await tabs.openTab('/vault/a.md')
    expect(tabs.tabs).toHaveLength(1)

    ;(tree.querySelector('.tree-del') as HTMLButtonElement).click()
    await flush()
    clickConfirmDelete(tree)
    await flush()
    await flush()

    expect(fsMocks.deleteFile).toHaveBeenCalledWith('/vault', '/vault/a.md')
    expect(tabs.tabs).toHaveLength(0)
    expect(tabs.activeId).toBeNull()
    // The parent listing was refreshed after the delete.
    expect(fsMocks.list.mock.calls.length).toBeGreaterThan(1)
  })

  it('deleting a directory closes an open tab under that subtree', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    fsMocks.list.mockResolvedValue([
      { name: 'fld', path: '/vault/fld', is_dir: true, is_mdx: false },
    ])
    const tree = mountTree()
    await flush()
    await tabs.openTab('/vault/fld/child.md')
    expect(tabs.tabs).toHaveLength(1)

    ;(tree.querySelector('.tree-del') as HTMLButtonElement).click()
    await flush()
    clickConfirmDelete(tree)
    await flush()

    // No tab exactly on /vault/fld -> the tree's delete path runs directly.
    expect(fsMocks.deleteFile).toHaveBeenCalledWith('/vault', '/vault/fld')
    expect(tabs.tabs).toHaveLength(0)
  })
})
