/**
 * The copy route that answers a refused save must ask "did the user type?" with
 * the same evidence the write path asks it with — the tab's edit revision — and
 * not with `tab.content`.
 *
 * `tab.content` is the field the RENDERED pane publishes 120 ms late
 * (`editor-persistence.ts`): a keystroke marks the tab dirty and moves the
 * revision at the keystroke, while the text the tab holds still belongs to the
 * one before it. The save transaction learned this (`tab-save.ts`'s
 * `editedDuringWrite`); the copy route — reached by any save a read-only file
 * refuses, a plain Ctrl+S included — was still comparing text, so a keystroke
 * typed across its awaited writes was invisible to it and it cleared `dirty`
 * while holding text that was on no disk. `dirty` is the only record that the
 * text exists: the autosave timer, the bulk flush, `hasUnsavedWork()` and the
 * close-tab save all read it, so the text sat in the editor looking saved until
 * the tab or the app went away.
 *
 * These cases drive the real store over a recording fs port and a real
 * rendered-pane persistence layer, so the keystroke travels the app's own path
 * — dirty and revision at the keystroke, `tab.content` 120 ms later. A test
 * that assigned `tab.content` by hand would pass against the broken code: that
 * is not a state the default pane produces.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { registerLifecycleHook } from '@nekowite/plugin-host'
import type { PluginContext } from '@nekowite/plugin-host'
import { setSourceViewHandle } from '../services/source-view'
import { setRenderedFlush } from '../services/editor-ownership'
import { pruneSuppressReapply, shouldSuppressReapply } from '../services/suppress-reapply'
import { documentKey } from '../features/editor/model/document-session'
import { t } from '../i18n'
import { useTabsStore } from './tabs'
import { READ_ONLY_PREFIX } from './write-refusal'

const readMock = vi.hoisted(() =>
  vi.fn<(vault: string, path: string) => Promise<string>>(),
)
const writeMock = vi.hoisted(() =>
  vi.fn<
    (vault: string, path: string, content: string, maxHistory?: number) => Promise<string | null>
  >(),
)
const saveFileDialogMock = vi.hoisted(() =>
  vi.fn<(defaultName: string, startDir?: string) => Promise<string | null>>(),
)
const notifyErrorMock = vi.hoisted(() => vi.fn<(message: string) => void>())
const announceMock = vi.hoisted(() => vi.fn<(message: string) => void>())

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
vi.mock('../services/errors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/errors')>()),
  notifyError: notifyErrorMock,
}))
vi.mock('../services/announcer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/announcer')>()),
  announce: announceMock,
}))

const ctx = { id: 'test', name: 'Test', insertComponent: () => {} } as PluginContext

/** The refusal `write_file` returns for `path`, token and all. */
const refusalFor = (path: string): string =>
  `${READ_ONLY_PREFIX}could not replace ${path}: the file is read-only (mode 0444), ` +
  'so it was left untouched; clear the read-only permission to save over it, or ' +
  'save it under a different name'

const RO = '/vault/ro.md'
const COPY = '/vault/ro (copy).md'

/** The editor, as far as the persistence layer is concerned: a document, a
 *  change listener, and a serializer. `type()` is one keystroke — it changes
 *  the document and fires the change handlers synchronously, which is what a
 *  doc-changing ProseMirror transaction does. */
function fakeEditor(initial: string) {
  const handlers = new Set<() => void>()
  let doc = initial
  return {
    get doc() {
      return doc
    },
    type(text: string) {
      doc += text
      handlers.forEach((h) => h())
    },
    async save() {
      return doc
    },
    onContentChange(cb: () => void) {
      handlers.add(cb)
      return () => handlers.delete(cb)
    },
  }
}

/** The rendered pane's persistence layer, wired to `editor` and a session that
 *  already holds the note. */
async function attachPane(
  editor: ReturnType<typeof fakeEditor>,
  content: string,
  vault: string,
  tabId: string,
) {
  const { createEditorPersistence } = await import(
    '../features/editor/controller/editor-persistence'
  )
  const persistence = createEditorPersistence({
    session: {
      editor: editor as never,
      gen: 0,
      appliedContent: content,
      appliedKey: documentKey(vault, tabId),
      lastLocalMarkdown: content,
      lastDoc: content,
      docChangeTimer: null,
      applyingExternal: false,
      pendingExternal: null,
      parseFailed: false,
      calloutViewSet: true,
    },
  })
  persistence.attachChangeListener()
  return persistence
}

/**
 * A disk that holds what has been written to it, with every write PARKED until
 * the test releases it.
 *
 * The parking is the point: the keystroke under test has to land while a write
 * is in flight, and holding that write open makes the interleaving an order of
 * events rather than a race against the clock. Time does not pass while a write
 * is held, so the 120 ms publish debounce is exactly as far away as the test
 * says it is.
 *
 * A write to a protected path is refused when it is released (a refusal is
 * about that file, so the copy is not refused with it).
 */
function parkedDisk(seeded: Record<string, string>, protectedPaths: string[] = [RO]) {
  const held = new Map<string, string>(Object.entries(seeded))
  const writes: Array<{ path: string; content: string }> = []
  let parked: Array<() => void> = []
  let autoLand = false

  readMock.mockImplementation(async (_vault: string, path: string): Promise<string> => {
    const content = held.get(path)
    if (content === undefined) throw new Error(`no such file: ${path}`)
    return content
  })
  writeMock.mockImplementation(
    (_vault: string, path: string, content: string): Promise<string | null> => {
      writes.push({ path, content })
      if (autoLand) return Promise.resolve(null)
      return new Promise<string | null>((resolve, reject) => {
        parked.push(() => {
          if (protectedPaths.includes(path)) {
            reject(new Error(refusalFor(path)))
            return
          }
          held.set(path, content)
          resolve(null)
        })
      })
    },
  )

  return {
    writes,
    /** What the disk holds now — what a later read would see. */
    read(path: string): string | undefined {
      return held.get(path)
    },
    /** Let every write made so far land (or be refused), in the order it was
     *  made. Reads then see what a landed write put there, as they would. */
    release() {
      const waiting = parked
      parked = []
      waiting.forEach((go) => go())
    },
    /** For the follow-up saves whose interleaving is not what a test here is
     *  controlling (the autosave the raced keystroke armed). */
    landFromNowOn() {
      autoLand = true
    },
  }
}

/** Let every promise that has already resolved reach its `await`.
 *
 *  No timer is advanced past 0 ms, so the publish debounce stays pending: the
 *  whole point is that the route gets to its decision before the pane has
 *  published what the user typed. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0)
}

describe('a refused save that races the editor publish debounce', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    readMock.mockReset()
    writeMock.mockReset()
    saveFileDialogMock.mockReset()
    notifyErrorMock.mockReset()
    announceMock.mockReset()
    setSourceViewHandle(null)
  })

  afterEach(() => {
    setRenderedFlush(null)
    pruneSuppressReapply(null)
    vi.useRealTimers()
  })

  it('does not call the tab clean while the keystroke is still in the pane', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    const disk = parkedDisk({ [RO]: 'v1' })
    await tabs.openTab(RO)
    const tab = tabs.tabs[0]
    expect(tab.content).toBe('v1')

    const editor = fakeEditor('v1')
    const pane = await attachPane(editor, 'v1', '/vault', tab.id)
    setRenderedFlush(() => pane.flush())

    vi.useFakeTimers()
    // A keystroke, published: the save below carries it, and the pane is quiet
    // again by the time it starts.
    editor.type(' NEW TEXT')
    await vi.advanceTimersByTimeAsync(200)
    expect(tab.content).toBe('v1 NEW TEXT')
    expect(tab.dirty).toBe(true)

    // Ctrl+S. The protected file refuses the write, so this reaches the copy
    // route. Every write is held open, because the user types across the copy's
    // — the last await before the route decides, whatever the dialog before it
    // cost.
    const saving = tabs.saveActive()
    await settle()
    expect(disk.writes).toEqual([{ path: RO, content: 'v1 NEW TEXT' }])

    saveFileDialogMock.mockResolvedValue(COPY)
    disk.release()
    await settle()
    expect(disk.writes[1]).toEqual({ path: COPY, content: 'v1 NEW TEXT' })

    // The keystroke, while the copy's write is in flight. The tab is dirty at
    // once...
    editor.type('!')
    expect(editor.doc).toBe('v1 NEW TEXT!')
    expect(tab.dirty).toBe(true)
    // ...and `tab.content` still holds the previous text. This is the state the
    // old comparison could not see: it is exactly `contentAtStart`, so the
    // typing is invisible to it for as long as the publish is pending.
    expect(tab.content).toBe('v1 NEW TEXT')

    // The copy lands, and the route decides on the next tick — with the publish
    // still pending, no wall-clock time having passed.
    disk.release()
    await saving

    // On disk: the protected note untouched and the copy holding the text the
    // save captured. In the editor: 'v1 NEW TEXT!', which no disk holds. The tab
    // therefore may not be called saved — `dirty` is the only record of it, and
    // every protection for unsaved text reads that flag.
    expect(tab.path).toBe(COPY)
    expect(tab.savedContent).toBe('v1 NEW TEXT')
    expect(tab.dirty).toBe(true)
    expect(tabs.hasUnsavedWork()).toBe(true)
    // The two files, read back: the protected note untouched, the copy holding
    // the save's text — and neither of them holding what the editor is showing.
    expect(disk.read(RO)).toBe('v1')
    expect(disk.read(COPY)).toBe('v1 NEW TEXT')

    // Nothing is stranded: the publish lands, and the autosave the keystroke
    // armed writes the newer text to the copy.
    disk.landFromNowOn()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(tab.content).toBe('v1 NEW TEXT!')
    expect(disk.writes).toEqual([
      { path: RO, content: 'v1 NEW TEXT' },
      { path: COPY, content: 'v1 NEW TEXT' },
      { path: COPY, content: 'v1 NEW TEXT!' },
    ])
    expect(tab.dirty).toBe(false)
  })

  it('still calls the tab saved, and follows the copy, when nobody typed', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    const disk = parkedDisk({ [RO]: 'v1' })
    await tabs.openTab(RO)
    const tab = tabs.tabs[0]

    const editor = fakeEditor('v1')
    const pane = await attachPane(editor, 'v1', '/vault', tab.id)
    setRenderedFlush(() => pane.flush())

    vi.useFakeTimers()
    editor.type(' NEW TEXT')
    await vi.advanceTimersByTimeAsync(200)

    saveFileDialogMock.mockResolvedValue(COPY)
    const saving = tabs.saveActive()
    await settle()
    disk.release()
    await settle()
    disk.release()
    await saving

    // The route's whole purpose: the text is on disk under the chosen name, the
    // tab follows it there, and the work stops being unsaved.
    expect(disk.writes).toEqual([
      { path: RO, content: 'v1 NEW TEXT' },
      { path: COPY, content: 'v1 NEW TEXT' },
    ])
    expect(tab.path).toBe(COPY)
    expect(tab.content).toBe('v1 NEW TEXT')
    expect(tab.savedContent).toBe('v1 NEW TEXT')
    expect(tab.dirty).toBe(false)
    expect(tabs.hasUnsavedWork()).toBe(false)
    // And the close gate is open: a tab left dirty here could never be quit.
    await expect(tabs.flushDirty()).resolves.toBe(true)
    expect(disk.writes).toHaveLength(2)
  })

  it('still adopts the plugin rewrite and arms the re-apply guard', async () => {
    const unregister = registerLifecycleHook('test', 'onSave', () => 'v1 rewritten', ctx)
    try {
      const tabs = useTabsStore()
      tabs.setVault('/vault')
      const disk = parkedDisk({ [RO]: 'v1' })
      await tabs.openTab(RO)
      const tab = tabs.tabs[0]

      vi.useFakeTimers()
      saveFileDialogMock.mockResolvedValue(COPY)
      const saving = tabs.saveActive()
      await settle()
      disk.release()
      await settle()
      disk.release()
      await saving

      // The copy took the rewritten text, and the tab adopts it: that content
      // change is what the arm suppresses, so its loss would re-open the
      // document and put the caret somewhere else.
      expect(disk.writes).toEqual([
        { path: RO, content: 'v1 rewritten' },
        { path: COPY, content: 'v1 rewritten' },
      ])
      expect(shouldSuppressReapply(tab.id)).toBe(true)
      expect(tab.content).toBe('v1 rewritten')
      expect(tab.savedContent).toBe('v1 rewritten')
      expect(tab.dirty).toBe(false)
      expect(announceMock).toHaveBeenCalledWith(t('tabs.savedAsCopy', { path: COPY }))
    } finally {
      unregister()
    }
  })

  it('reports a copy that is itself refused, and leaves the tab dirty', async () => {
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    const disk = parkedDisk({ [RO]: 'v1' }, [RO, '/vault/also-read-only.md'])
    await tabs.openTab(RO)
    const tab = tabs.tabs[0]
    tab.content = 'v1 NEW TEXT'
    tabs.markDirty(tab.id)

    vi.useFakeTimers()
    saveFileDialogMock.mockResolvedValue('/vault/also-read-only.md')
    const saving = tabs.saveActive()
    await settle()
    disk.release()
    await settle()
    disk.release()
    await saving

    // Both sentences unchanged: the reason named, and no second dialog.
    expect(notifyErrorMock).toHaveBeenCalledWith(
      t('tabs.saveBlockedReadOnly', { path: '/vault/also-read-only.md' }),
    )
    expect(saveFileDialogMock).toHaveBeenCalledTimes(1)
    expect(tab.dirty).toBe(true)
    expect(tab.content).toBe('v1 NEW TEXT')
  })
})
