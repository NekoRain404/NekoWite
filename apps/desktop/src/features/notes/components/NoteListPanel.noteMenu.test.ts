/**
 * Note card context menu suite, split out of `NoteListPanel.test.ts` when that
 * file crossed the 800-line budget (AGENTS.md: split tests by behaviour
 * domain). The test bodies below are unchanged by the move.
 *
 * The harness at the top (the gateway + export stubs, the mounted-app
 * bookkeeping and `mountPanel`) is a deliberate copy of the one in
 * `NoteListPanel.test.ts`: keeping each file independently mountable is worth
 * more in a test than sharing the preamble, and the two are small.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import NoteListPanel from './NoteListPanel.vue'
import { useAppearanceStore } from '../../../stores/appearance'
import { useDocumentListStore } from '../../../stores/document-list'
import { useRefsStore } from '../../../stores/refs'
import { useTabsStore } from '../../../stores/tabs'
import { useVaultSessionStore } from '../../../stores/vault-session'
import { setRenderedFlush } from '../../../services/editor-ownership'
import { onNotify } from '../../../services/errors'
import type { NoteSummary } from '../services/note-summary'

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

/**
 * The export service, stubbed.
 *
 * What the card menu owes the export pipeline is exactly its arguments — the
 * TARGET's text, its path, its title — so the assertions here are on those
 * instead of on rendered HTML. The pipeline's own half of the contract (a
 * `notePath` steering attachment resolution, the PDF frame's life cycle) is
 * covered by `services/export.test.ts`.
 */
const exportMocks = vi.hoisted(() => ({ exportHtml: vi.fn(), exportToPdf: vi.fn() }))
vi.mock('../../../services/export', () => ({
  exportHtml: exportMocks.exportHtml,
  exportToPdf: exportMocks.exportToPdf,
}))

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

describe('Note card context menu', () => {
  const NOTES: NoteSummary[] = [
    { path: '/vault/alpha.md', name: 'alpha.md', title: 'Alpha', tags: [], summary: '', mtime: 3, size: 1, dir: '', links: [] },
    { path: '/vault/beta.md', name: 'beta.md', title: 'Beta', tags: [], summary: '', mtime: 2, size: 1, dir: '', links: [] },
    { path: '/vault/gamma.md', name: 'gamma.md', title: 'Gamma', tags: [], summary: '', mtime: 1, size: 1, dir: '', links: [] },
  ]

  /** The zh labels the user sees (the test locale is zh). */
  const MENU_LABELS = ['打开', '收藏', '重命名', '导出 HTML', '导出 PDF', '删除']

  beforeEach(async () => {
    pinia = createPinia()
    setActivePinia(pinia)
    document.body.innerHTML = ''
    mounted = []
    fsMocks.read.mockReset()
    fsMocks.read.mockResolvedValue('# body')
    fsMocks.listHistory.mockReset()
    fsMocks.listHistory.mockResolvedValue([])
    fsMocks.stat.mockReset()
    fsMocks.stat.mockResolvedValue({ size: 1, mtime: 1 })
    // The move/delete flows reach the gateway for real: a note move lists the
    // note's folder (its `_assets` sibling) and renames through `renameEntry`,
    // a note delete trashes the note and then its images folder.
    fsMocks.list.mockReset()
    fsMocks.list.mockResolvedValue([])
    fsMocks.renameEntry.mockReset()
    fsMocks.renameEntry.mockResolvedValue('ok')
    fsMocks.write.mockReset()
    fsMocks.write.mockResolvedValue(undefined)
    fsMocks.deleteFile.mockReset()
    fsMocks.deleteFile.mockResolvedValue('trash-key')

    useDocumentListStore().setNotes(NOTES)
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    // Alpha is the OPEN, ACTIVE note. Every test below right-clicks a
    // different, non-active card, so an action wired to `tabs.activeTab`
    // instead of the recorded path fails.
    await tabs.openTab('/vault/alpha.md')
    mountPanel()
    await flush()
  })

  afterEach(() => {
    for (const app of mounted) app.unmount()
    mounted = []
    host?.remove()
    host = null
    document.body.innerHTML = ''
    // `flushEdits` asks whatever pane registered itself; a flusher left behind
    // by one test would be called by the next one's rename.
    setRenderedFlush(null)
  })

  function cardFor(title: string): HTMLElement {
    const card = [...host!.querySelectorAll<HTMLElement>('.note-card')].find(
      (c) => c.querySelector('.card-title')?.textContent?.trim() === title,
    )
    expect(card, `note card ${title}`).toBeDefined()
    return card!
  }

  /** Right-click a card the way the browser does, wait for the menu to render,
   *  and hand back the event so the caller can check the browser menu was
   *  suppressed. */
  async function rightClick(card: HTMLElement): Promise<MouseEvent> {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 60,
    })
    card.dispatchEvent(event)
    await flush()
    return event
  }

  function menuItems(): HTMLButtonElement[] {
    return [...document.body.querySelectorAll<HTMLButtonElement>('.ctx-menu-item')]
  }

  function menuLabels(): string[] {
    return menuItems().map((b) => b.querySelector('.ctx-menu-label')?.textContent?.trim() ?? '')
  }

  function clickMenuLabel(label: string): void {
    const item = menuItems().find(
      (b) => b.querySelector('.ctx-menu-label')?.textContent?.trim() === label,
    )
    expect(item, `context menu item ${label}`).toBeDefined()
    item!.click()
  }

  it('right-clicking a non-active card opens the note actions there', async () => {
    expect(cardFor('Beta').classList.contains('active')).toBe(false)
    const event = await rightClick(cardFor('Beta'))
    // `.prevent` keeps the browser's own menu from appearing over ours.
    expect(event.defaultPrevented).toBe(true)
    expect(menuLabels()).toEqual(MENU_LABELS)
  })

  it('open acts on the right-clicked note, not the active tab', async () => {
    const tabs = useTabsStore()
    const openSpy = vi.spyOn(tabs, 'openTab')
    expect(tabs.activeTab?.path).toBe('/vault/alpha.md')

    await rightClick(cardFor('Beta'))
    clickMenuLabel('打开')
    await flush()

    expect(openSpy).toHaveBeenCalledWith('/vault/beta.md')
    expect(tabs.activeTab?.path).toBe('/vault/beta.md')
    // Selecting an item closes the menu.
    expect(menuItems()).toHaveLength(0)
    openSpy.mockRestore()
  })

  it('favourite toggles only the right-clicked note, and the label follows it', async () => {
    const documentList = useDocumentListStore()

    await rightClick(cardFor('Beta'))
    clickMenuLabel('收藏')
    await flush()
    expect(documentList.favorites).toEqual(['/vault/beta.md'])

    // Re-open on the same card: the label is computed from the store, not cached.
    await rightClick(cardFor('Beta'))
    expect(menuLabels()).toContain('取消收藏')
    clickMenuLabel('取消收藏')
    await flush()
    expect(documentList.favorites).toEqual([])
  })

  it('closing the menu and re-opening it on another card retargets the action', async () => {
    const documentList = useDocumentListStore()

    await rightClick(cardFor('Beta'))
    expect(menuLabels()).toEqual(MENU_LABELS)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flush()
    expect(menuItems()).toHaveLength(0)

    await rightClick(cardFor('Gamma'))
    clickMenuLabel('收藏')
    await flush()
    // A target cached at the first open would have toggled Beta instead.
    expect(documentList.favorites).toEqual(['/vault/gamma.md'])
  })

  it('keeps left-click open and the star button untouched', async () => {
    const tabs = useTabsStore()
    const documentList = useDocumentListStore()
    const openSpy = vi.spyOn(tabs, 'openTab')

    ;(cardFor('Beta').querySelector('.card-main') as HTMLButtonElement).click()
    await flush()
    expect(openSpy).toHaveBeenCalledWith('/vault/beta.md')
    expect(menuItems()).toHaveLength(0)

    ;(cardFor('Gamma').querySelector('.card-star') as HTMLButtonElement).click()
    await flush()
    expect(documentList.favorites).toEqual(['/vault/gamma.md'])
    expect(menuItems()).toHaveLength(0)
    openSpy.mockRestore()
  })

  /** Right-click `title`'s card and pick 重命名, which opens the inline editor. */
  async function openRename(title: string): Promise<void> {
    await rightClick(cardFor(title))
    clickMenuLabel('重命名')
    await flush()
    expect(host!.querySelector('.nl-rename-input')).not.toBeNull()
  }

  /** Type `name` into the open rename editor and press Enter. */
  async function submitRename(name: string): Promise<void> {
    const input = host!.querySelector<HTMLInputElement>('.nl-rename-input')
    expect(input).not.toBeNull()
    input!.value = name
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush()
    await flush()
  }

  function renameError(): string {
    return host!.querySelector('.nl-rename-error')?.textContent?.trim() ?? ''
  }

  describe('rename', () => {
    it('flushes pending edits first, moves the right-clicked note, and retargets its open tab', async () => {
      const tabs = useTabsStore()
      // Beta is OPEN but NOT active: the note the user right-clicked is the one
      // that must move, and the active note's tab must not be touched.
      await tabs.openTab('/vault/beta.md')
      tabs.setActive(tabs.tabs.find((t) => t.path === '/vault/alpha.md')!.id)
      expect(tabs.activeTab?.path).toBe('/vault/alpha.md')

      // The real `flushEdits` mechanism: the pane registers its flusher, which
      // is what publishes keystrokes still inside the editor's debounce.
      const order: string[] = []
      setRenderedFlush(async () => {
        order.push('flush')
      })
      fsMocks.read.mockImplementation(async () => {
        order.push('read')
        return '# beta'
      })
      fsMocks.renameEntry.mockImplementation(async () => {
        order.push('rename')
        return 'ok'
      })
      fsMocks.stat.mockRejectedValue(new Error('not found'))

      await openRename('Beta')
      expect(host!.querySelector<HTMLInputElement>('.nl-rename-input')!.value).toBe('beta.md')
      await submitRename('beta-renamed.md')

      // Without the flush the move is a read-modify-write of a file the editor
      // is still ahead of, and the debounced keystrokes overwrite the move.
      expect(order[0]).toBe('flush')
      expect(order.indexOf('flush')).toBeLessThan(order.indexOf('rename'))
      expect(fsMocks.renameEntry).toHaveBeenCalledWith('/vault', '/vault/beta.md', '/vault/beta-renamed.md')
      expect(tabs.tabs.map((t) => t.path)).toEqual(['/vault/alpha.md', '/vault/beta-renamed.md'])
      expect(tabs.activeTab?.path).toBe('/vault/alpha.md')
      expect(host!.querySelector('.nl-rename-input')).toBeNull()
    })

    it('refuses a blank name, a path separator and a taken name without moving anything', async () => {
      fsMocks.stat.mockResolvedValue({ size: 1, mtime: 1 })
      await openRename('Beta')

      await submitRename('   ')
      expect(renameError()).toContain('名称不能为空')

      await submitRename('a/b.md')
      expect(renameError()).toContain('名称不能包含 /')

      await submitRename('gamma.md')
      expect(renameError()).toContain('目标位置已存在')

      expect(fsMocks.renameEntry).not.toHaveBeenCalled()
      // The editor stays open on the note it is renaming, so the user can fix
      // the name instead of re-opening the menu.
      expect(host!.querySelector('.nl-rename-input')).not.toBeNull()
    })

    it('allows a rename that only changes the case, though the target "exists"', async () => {
      // On Windows the target of a case-only rename IS the source file; the
      // backend runs it through a temporary name. A naive existence check would
      // refuse the very rename the user asked for.
      fsMocks.stat.mockResolvedValue({ size: 1, mtime: 1 })
      await openRename('Beta')
      await submitRename('Beta.md')

      expect(fsMocks.renameEntry).toHaveBeenCalledWith('/vault', '/vault/beta.md', '/vault/Beta.md')
      expect(renameError()).toBe('')
    })

    it('reports a backend failure with the existing message and keeps the editor open', async () => {
      fsMocks.stat.mockRejectedValue(new Error('not found'))
      fsMocks.renameEntry.mockRejectedValue(new Error('disk full'))
      const seen: string[] = []
      const off = onNotify((msg) => seen.push(msg))
      try {
        await openRename('Beta')
        await submitRename('beta-renamed.md')
      } finally {
        off()
      }

      expect(seen).toContain('重命名失败，请重试')
      expect(host!.querySelector('.nl-rename-input')).not.toBeNull()
    })
  })

  describe('delete', () => {
    /** Right-click `title`'s card, pick 删除 and press the confirm button. */
    async function deleteWithConfirm(title: string): Promise<void> {
      await rightClick(cardFor(title))
      clickMenuLabel('删除')
      await flush()
      const yes = host!.querySelector<HTMLButtonElement>('.nl-del-confirm .nl-del-yes')
      expect(yes).not.toBeNull()
      yes!.click()
      await flush()
      await flush()
    }

    it('asks first, then deletes the note together with its images folder', async () => {
      const rebuild = vi.spyOn(useVaultSessionStore(), 'rebuildIndex')
      // gamma.md has a sibling images folder (the existence probe answers).
      fsMocks.stat.mockResolvedValue({ size: 1, mtime: 1 })

      await rightClick(cardFor('Gamma'))
      clickMenuLabel('删除')
      await flush()

      // "Confirm before deleting" defaults to on: the menu selection only asks.
      expect(fsMocks.deleteFile).not.toHaveBeenCalled()
      const strip = host!.querySelector<HTMLElement>('.nl-del-confirm')
      expect(strip).not.toBeNull()
      expect(strip!.textContent).toContain('gamma.md')

      ;(strip!.querySelector('.nl-del-yes') as HTMLButtonElement).click()
      await flush()
      await flush()

      expect(fsMocks.deleteFile).toHaveBeenCalledWith('/vault', '/vault/gamma.md')
      // The images folder goes with it: leaving it behind kept the images on
      // disk while nothing in the app could list or reclaim them.
      expect(fsMocks.deleteFile).toHaveBeenCalledWith('/vault', '/vault/gamma_assets')
      expect(rebuild).toHaveBeenCalled()
      expect(host!.querySelector('.nl-del-confirm')).toBeNull()
    })

    it('deletes straight away when "confirm before deleting" is off', async () => {
      useAppearanceStore().setConfirmBeforeDelete(false)
      fsMocks.stat.mockRejectedValue(new Error('no images folder'))

      await rightClick(cardFor('Gamma'))
      clickMenuLabel('删除')
      await flush()
      await flush()

      expect(fsMocks.deleteFile).toHaveBeenCalledWith('/vault', '/vault/gamma.md')
      expect(host!.querySelector('.nl-del-confirm')).toBeNull()
    })

    it('sends an open note through the tabs store, which closes its tab and takes the images', async () => {
      const tabs = useTabsStore()
      fsMocks.stat.mockResolvedValue({ size: 1, mtime: 1 })
      await tabs.openTab('/vault/beta.md')
      const tabId = tabs.tabs.find((t) => t.path === '/vault/beta.md')!.id
      const del = vi.spyOn(tabs, 'deleteTabFile')

      await deleteWithConfirm('Beta')

      expect(del).toHaveBeenCalledWith(tabId)
      expect(tabs.tabs.some((t) => t.path === '/vault/beta.md')).toBe(false)
      expect(fsMocks.deleteFile).toHaveBeenCalledWith('/vault', '/vault/beta.md')
      expect(fsMocks.deleteFile).toHaveBeenCalledWith('/vault', '/vault/beta_assets')
    })

    it('a second activation while the first delete is still running does not delete twice', async () => {
      useAppearanceStore().setConfirmBeforeDelete(false)
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      // Park the first delete inside the gateway, then ask again: the guard is
      // per path, so the second activation must not start a second trash entry.
      fsMocks.stat.mockImplementation(async () => {
        await gate
        throw new Error('no images folder')
      })
      fsMocks.deleteFile.mockImplementation(async () => {
        await gate
        return 'trash-key'
      })

      await rightClick(cardFor('Gamma'))
      clickMenuLabel('删除')
      await flush()
      await rightClick(cardFor('Gamma'))
      clickMenuLabel('删除')
      await flush()
      release()
      await flush()
      await flush()

      const gammaDeletes = fsMocks.deleteFile.mock.calls.filter((c) => c[1] === '/vault/gamma.md')
      expect(gammaDeletes).toHaveLength(1)
    })

    it('a repeat click on the confirm button deletes once', async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      fsMocks.stat.mockImplementation(async () => {
        await gate
        throw new Error('no images folder')
      })
      fsMocks.deleteFile.mockImplementation(async () => {
        await gate
        return 'trash-key'
      })

      await rightClick(cardFor('Gamma'))
      clickMenuLabel('删除')
      await flush()
      const yes = host!.querySelector<HTMLButtonElement>('.nl-del-confirm .nl-del-yes')!
      yes.click()
      await flush()
      yes.click()
      await flush()
      release()
      await flush()
      await flush()

      const gammaDeletes = fsMocks.deleteFile.mock.calls.filter((c) => c[1] === '/vault/gamma.md')
      expect(gammaDeletes).toHaveLength(1)
    })
  })

  describe('export', () => {
    /** A note in a folder of its own. The active note (`alpha`) sits at the
     *  vault root, so an attachment resolved against the TARGET and one
     *  resolved against the ACTIVE TAB are different strings — which is what
     *  makes the wrong note's context visible instead of plausible. */
    const NESTED: NoteSummary = {
      path: '/vault/deep/delta.md',
      name: 'delta.md',
      title: 'Delta',
      tags: [],
      summary: '',
      mtime: 4,
      size: 1,
      dir: 'deep',
      links: [],
    }

    beforeEach(async () => {
      exportMocks.exportHtml.mockReset()
      exportMocks.exportToPdf.mockReset()
      fsMocks.saveFileDialog.mockReset()
      // The native dialog hands back an absolute path; echoing the default
      // name under the vault keeps every other assertion about the export
      // itself instead of about the dialog.
      fsMocks.saveFileDialog.mockImplementation(async (name: string) => `/vault/${name}`)
      useDocumentListStore().setNotes([...NOTES, NESTED])
      // Let the list render the new card before a test right-clicks it.
      await flush()
    })

    it('exports the right-clicked note, read from its file and named after it', async () => {
      fsMocks.read.mockImplementation(async (_vault, path) =>
        path === '/vault/deep/delta.md' ? '# Delta body\n' : '# Alpha body\n',
      )
      // A citation key the vault library knows: a note exported from the menu
      // has to render it exactly as an export from the settings dialog does.
      useRefsStore().refs.set('smith2020', {
        key: 'smith2020',
        title: 'A paper',
        authors: ['Smith'],
        year: '2020',
        type: 'article',
      })

      await rightClick(cardFor('Delta'))
      clickMenuLabel('导出 HTML')
      await flush()

      expect(fsMocks.read).toHaveBeenCalledWith('/vault', '/vault/deep/delta.md')
      expect(fsMocks.saveFileDialog).toHaveBeenCalledWith('delta.html', '/vault')
      const [source, vault, savePath, opts] = exportMocks.exportHtml.mock.calls[0]
      // Delta's text, never the active note's.
      expect(source).toBe('# Delta body\n')
      expect(vault).toBe('/vault')
      expect(savePath).toBe('/vault/delta.html')
      expect(opts.title).toBe('delta')
      // Attachments and citations are resolved against THIS note; without
      // `notePath` both would be resolved against the active one.
      expect(opts.notePath).toBe('/vault/deep/delta.md')
      expect(opts.refs.get('smith2020')?.title).toBe('A paper')
    })

    it('exports the live text when the target IS the active tab, flushing first', async () => {
      const tabs = useTabsStore()
      const order: string[] = []
      // The real flush mechanism: the pane publishes the keystrokes still
      // inside its debounce window into the tab.
      setRenderedFlush(async () => {
        order.push('flush')
        tabs.tabs.find((t) => t.path === '/vault/alpha.md')!.content = '# just typed\n'
      })
      fsMocks.read.mockImplementation(async () => {
        order.push('read')
        return '# stale on disk\n'
      })

      await rightClick(cardFor('Alpha'))
      clickMenuLabel('导出 HTML')
      await flush()

      // Flushed, and the file was never read: it is a debounce window behind
      // the pane the user is typing in.
      expect(order).toEqual(['flush'])
      expect(exportMocks.exportHtml).toHaveBeenCalledWith(
        '# just typed\n',
        '/vault',
        '/vault/alpha.html',
        expect.objectContaining({ title: 'alpha', notePath: '/vault/alpha.md' }),
      )
    })

    it('cancelling the save dialog exports nothing and says nothing', async () => {
      fsMocks.saveFileDialog.mockResolvedValue(null)
      const seen: string[] = []
      const off = onNotify((m) => seen.push(m))
      try {
        await rightClick(cardFor('Beta'))
        clickMenuLabel('导出 HTML')
        await flush()
      } finally {
        off()
      }

      // The dialog was opened for THIS note, under its own default name...
      expect(fsMocks.saveFileDialog).toHaveBeenCalledWith('beta.html', '/vault')
      // ...and cancelling it is a decision, not a failure: no write, no toast,
      // and no read of a note the user just chose not to export.
      expect(exportMocks.exportHtml).not.toHaveBeenCalled()
      expect(fsMocks.read).not.toHaveBeenCalledWith('/vault', '/vault/beta.md')
      expect(seen).toEqual([])
    })

    it('refuses a destination outside the vault with the existing message', async () => {
      // The dialog can aim anywhere, but the backend's write is vault-confined:
      // letting this through would fail silently behind a closed dialog.
      fsMocks.saveFileDialog.mockResolvedValue('/tmp/beta.html')
      const seen: string[] = []
      const off = onNotify((m) => seen.push(m))
      try {
        await rightClick(cardFor('Beta'))
        clickMenuLabel('导出 HTML')
        await flush()
      } finally {
        off()
      }

      expect(seen).toEqual(['请选择 vault 内的路径导出'])
      expect(exportMocks.exportHtml).not.toHaveBeenCalled()
      expect(fsMocks.read).not.toHaveBeenCalledWith('/vault', '/vault/beta.md')
    })

    it('prints the right-clicked note to PDF, with its title and path', async () => {
      fsMocks.read.mockImplementation(async (_vault, path) =>
        path === '/vault/deep/delta.md' ? '# Delta body\n' : '# Alpha body\n',
      )

      await rightClick(cardFor('Delta'))
      clickMenuLabel('导出 PDF')
      await flush()

      expect(fsMocks.read).toHaveBeenCalledWith('/vault', '/vault/deep/delta.md')
      // Print goes through the app's own frame; there is no destination to pick.
      expect(fsMocks.saveFileDialog).not.toHaveBeenCalled()
      expect(exportMocks.exportToPdf).toHaveBeenCalledWith(
        '# Delta body\n',
        expect.objectContaining({ title: 'delta', notePath: '/vault/deep/delta.md' }),
      )
      expect(exportMocks.exportHtml).not.toHaveBeenCalled()
    })

    it('reports a target it could not read instead of exporting an empty document', async () => {
      fsMocks.read.mockRejectedValue(new Error('read_file: No such file'))
      const seen: string[] = []
      const off = onNotify((m) => seen.push(m))
      try {
        await rightClick(cardFor('Gamma'))
        clickMenuLabel('导出 HTML')
        await flush()
      } finally {
        off()
      }

      expect(seen).toHaveLength(1)
      expect(seen[0]).toContain('导出失败')
      expect(seen[0]).toContain('/vault/gamma.md')
      expect(exportMocks.exportHtml).not.toHaveBeenCalled()
    })

    it('reports a failed export instead of losing the rejection', async () => {
      // Awaited and caught: an unhandled rejection here would look exactly
      // like the menu item doing nothing.
      exportMocks.exportToPdf.mockRejectedValue(new Error('render exploded'))
      const seen: string[] = []
      const off = onNotify((m) => seen.push(m))
      try {
        await rightClick(cardFor('Beta'))
        clickMenuLabel('导出 PDF')
        await flush()
      } finally {
        off()
      }

      expect(seen).toHaveLength(1)
      expect(seen[0]).toContain('导出失败')
      expect(seen[0]).toContain('render exploded')
    })
  })
})
