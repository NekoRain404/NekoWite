import { beforeEach, describe, expect, it, vi } from 'vitest'
const readMock = vi.hoisted(() => vi.fn())
vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    write: vi.fn(),
    list: vi.fn(),
    watch: vi.fn(),
    deleteFile: vi.fn(),
    stat: vi.fn(),
    listHistory: vi.fn(),
    readHistory: vi.fn(),
    restoreHistory: vi.fn(),
    createDir: vi.fn(),
    renameEntry: vi.fn(),
    saveFileDialog: vi.fn(),
  },
}))
import { createPinia, setActivePinia } from 'pinia'
import type { NekoEditor } from '@nekowite/editor-core'
import { setCalloutView } from '../../../plugins/callout'
import { notifyError } from '../../../services/errors'
import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { armSuppressReapply, shouldSuppressReapply } from '../../../services/suppressReapply'
import { createDocumentSession, type DocumentSession } from '../model/documentSession'
import { createExternalDocSync } from '../../../services/externalDocSync'
import type { FsChangeEvent } from '../../../platform/gateways/contracts'
import { createEditorExternalSync, type EditorExternalSyncDeps } from './editorExternalSync'

vi.mock('../../../plugins/callout', () => ({ setCalloutView: vi.fn() }))
// Partially mocked: the C6 tests below drive the real external-doc sync, which
// needs the real `decideConflict`.
vi.mock('../../../services/errors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/errors')>()),
  notifyError: vi.fn(),
  notifyRecovery: vi.fn(),
}))
// The tab store (imported inside editorExternalSync for active content) reads
// files on openTab. Most tests open a null-path tab (no read); the C6 tests below
// open a REAL path so the tab carries the bytes it read from disk.

/** A minimal editor whose open/save are controllable per test. */
function makeEditor(opts: {
  save?: string
  open?: (content: string) => Promise<void>
} = {}): NekoEditor {
  return {
    open: vi.fn(opts.open ?? (async () => undefined)),
    save: vi.fn().mockResolvedValue(opts.save ?? '# Canonical\n'),
    getView: vi.fn(() => ({})),
    onContentChange: vi.fn(() => () => {}),
    insertMarkdownAtCursor: vi.fn(),
    setSuggestion: vi.fn(),
    acceptSuggestion: vi.fn(),
    rejectSuggestion: vi.fn(),
    hasSuggestion: vi.fn(),
    onSuggestionChange: vi.fn(() => () => {}),
    destroy: vi.fn(),
  } as unknown as NekoEditor
}

function makeSync(session: DocumentSession, scheduler = vi.fn()) {
  const deps: EditorExternalSyncDeps = {
    session,
    getEditor: () => session.editor,
    scheduleOverlayRefresh: scheduler,
  }
  return { sync: createEditorExternalSync(deps), scheduler }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Flush the resolved-promise chain of a void-fired applyContent. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('editorExternalSync', () => {
  let session: DocumentSession
  let tabs: ReturnType<typeof useTabsStore>
  let view: ReturnType<typeof useViewStore>

  beforeEach(async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    tabs = useTabsStore()
    view = useViewStore()
    session = createDocumentSession()
    await tabs.openTab(null, '# Initial\n')
    vi.resetAllMocks()
  })

  it('adopts an external content change while the editor is idle', async () => {
    const editor = makeEditor({ save: '# Canonical\n' })
    session.editor = editor
    const { sync, scheduler } = makeSync(session)
    tabs.activeTab!.content = '# External\n'

    sync.onContentChanged('# External\n')
    await flush()

    // The watcher's content is opened into the editor...
    expect(editor.open).toHaveBeenCalledTimes(1)
    expect(editor.open).toHaveBeenCalledWith('# External\n')
    expect(session.applyingExternal).toBe(false)
    // ...the editor's canonical serialization is captured and adopted into the
    // tab (a clean tab also refreshes savedContent).
    expect(session.lastLocalMarkdown).toBe('# Canonical\n')
    expect(tabs.activeTab?.content).toBe('# Canonical\n')
    expect(tabs.activeTab?.savedContent).toBe('# Canonical\n')
    // The content was an external write: the generation guard was bumped and
    // the callout view was installed.
    expect(session.gen).toBe(1)
    expect(setCalloutView).toHaveBeenCalled()
    expect(scheduler).toHaveBeenCalled()
  })

  it('re-applies a version the editor was OPENED with, once the user has typed since', async () => {
    // `appliedContent` is the text the editor was last opened with, and any
    // typing since then replaced the live document. Restoring a version that
    // happens to equal it - the common case, "undo my last edit by restoring
    // the previous version" - was skipped as already-applied: the file went
    // back, the SCREEN did not, so the user saw no change and their next
    // keystroke published the discarded text and saved it over the restore.
    const editor = makeEditor({ save: '# One\n' })
    session.editor = editor
    const { sync } = makeSync(session)

    // 1. the editor opens version one.
    sync.onContentChanged('# One\n')
    await flush()
    expect(editor.open).toHaveBeenCalledTimes(1)
    expect(session.appliedContent).toBe('# One\n')

    // 2. the user types: the editor's own serialization becomes version two
    //    (this is what editorPersistence records on every edit).
    session.lastLocalMarkdown = '# One two\n'

    // 3. they restore version one from the history panel.
    sync.onContentChanged('# One\n')
    await flush()

    // The editor must really be re-opened with the restored text, not left
    // showing the discarded version.
    expect(editor.open).toHaveBeenCalledTimes(2)
    expect(editor.open).toHaveBeenLastCalledWith('# One\n')
  })

  it('still skips a duplicate of the content the editor already holds', async () => {
    // The guard's original job: a watcher echo or a duplicate open must not
    // replace the live model (that resets caret, undo and scroll).
    const editor = makeEditor({ save: '# Same\n' })
    session.editor = editor
    const { sync } = makeSync(session)

    sync.onContentChanged('# Same\n')
    await flush()
    expect(editor.open).toHaveBeenCalledTimes(1)

    // Same text again, nothing typed in between.
    sync.onContentChanged('# Same\n')
    await flush()
    expect(editor.open).toHaveBeenCalledTimes(1)
  })

  it('re-applies a change that arrives during an in-flight apply (pendingExternal)', async () => {
    const gate = deferred()
    const editor = makeEditor({
      save: '# Canonical\n',
      open: vi.fn(async () => {
        await gate.promise
      }) as NekoEditor['open'],
    })
    session.editor = editor
    const { sync, scheduler } = makeSync(session)
    tabs.activeTab!.content = '# A\n'

    const first = sync.applyContent('# A\n')
    // A newer write lands while open() is still in flight: the watcher marks it
    // pending instead of starting a second open on the live editor.
    tabs.activeTab!.content = '# B\n'
    sync.onContentChanged('# B\n')
    expect(session.pendingExternal).toBe('# B\n')
    expect(editor.open).toHaveBeenCalledTimes(1)

    gate.resolve()
    await first
    await flush()

    // The pending write was NOT dropped: it is re-applied after the first apply
    // finishes, and the tab adopts the canonical form of the newest content.
    expect(session.pendingExternal).toBeNull()
    expect(editor.open).toHaveBeenCalledTimes(2)
    expect(editor.open).toHaveBeenLastCalledWith('# B\n')
    expect(session.lastLocalMarkdown).toBe('# Canonical\n')
    expect(tabs.activeTab?.content).toBe('# Canonical\n')
    // The first apply's finally routed through the re-apply branch, so the
    // overlay refresh is deferred to the second (final) apply.
    expect(scheduler).toHaveBeenCalledTimes(1)
  })

  it('a stale in-flight apply cannot clobber newer tab content', async () => {
    const gate = deferred()
    const editor = makeEditor({
      save: '# Stale Canonical\n',
      open: vi.fn(async () => {
        await gate.promise
      }) as NekoEditor['open'],
    })
    session.editor = editor
    const { sync } = makeSync(session)
    tabs.activeTab!.content = '# A\n'

    const first = sync.applyContent('# A\n')
    // An external write replaced the tab content while open() was in flight
    // (e.g. the async disk read that fills a placeholder tab). The completing
    // apply must NOT adopt its (older) serialization over the newer content.
    tabs.activeTab!.content = '# Newer\n'
    gate.resolve()
    await first
    await flush()

    expect(tabs.activeTab?.content).toBe('# Newer\n')
    expect(session.lastLocalMarkdown).toBe('# Stale Canonical\n')

    // The newer content reaches the watcher afterwards; with the stale apply
    // done, it supersedes (gen bump) and opens with the newer text, which now
    // wins the adopt.
    sync.onContentChanged('# Newer\n')
    await flush()
    expect(editor.open).toHaveBeenLastCalledWith('# Newer\n')
    expect(session.gen).toBe(1)
    expect(tabs.activeTab?.content).toBe('# Stale Canonical\n')
  })

  it('skips the echo of the editor’s own serialization (no re-open)', async () => {
    const editor = makeEditor({ save: '# Canonical\n' })
    session.editor = editor
    const { sync } = makeSync(session)
    tabs.activeTab!.content = '# Mine\n'

    await sync.applyContent('# Mine\n')
    expect(editor.open).toHaveBeenCalledTimes(1)
    // The persistence layer adopts the accepted serialization into the tab; the
    // content watcher echoes it back to onContentChanged. Re-opening would
    // re-parse the whole doc (wiping undo history and caret/scroll) for a
    // change the editor itself produced — it must be skipped.
    expect(tabs.activeTab?.content).toBe('# Canonical\n')
    sync.onContentChanged('# Canonical\n')
    await flush()
    expect(editor.open).toHaveBeenCalledTimes(1)
    expect(session.gen).toBe(0)
  })

  it('falls back to source mode and notifies an error when the parse fails', async () => {
    const editor = makeEditor({
      open: vi.fn().mockRejectedValue(new Error('bad mdx')) as NekoEditor['open'],
    })
    session.editor = editor
    const { sync, scheduler } = makeSync(session)
    tabs.activeTab!.content = '# Unknown\n'

    await sync.applyContent('# Unknown\n')

    expect(session.parseFailed).toBe(true)
    expect(view.mode).toBe('source')
    expect(notifyError).toHaveBeenCalled()
    expect(setCalloutView).not.toHaveBeenCalled()
    // The finally still runs: no pending write, so the overlay is refreshed.
    expect(scheduler).toHaveBeenCalled()
  })

  it('retries the failed content when the user switches back to rendered', async () => {
    const gate = deferred()
    const editor = makeEditor({
      save: '# Recovered Canonical\n',
      open: vi
        .fn()
        .mockRejectedValueOnce(new Error('bad mdx'))
        .mockImplementationOnce(async () => gate.promise) as NekoEditor['open'],
    })
    session.editor = editor
    const { sync } = makeSync(session)
    tabs.activeTab!.content = '# Unknown\n'

    await sync.applyContent('# Unknown\n')
    expect(session.parseFailed).toBe(true)

    view.setMode('source')
    view.setMode('rendered')
    sync.onModeChanged('rendered')
    gate.resolve()
    await flush()

    expect(session.parseFailed).toBe(false)
    expect(editor.open).toHaveBeenLastCalledWith('# Unknown\n')
    expect(session.lastLocalMarkdown).toBe('# Recovered Canonical\n')
  })

  it('ignores source-pane edits while the rendered pane is hidden', async () => {
    const editor = makeEditor({ save: '# Canonical\n' })
    session.editor = editor
    const { sync } = makeSync(session)
    // The user switched to source mode: the source pane now owns the text.
    view.setMode('source')
    tabs.activeTab!.content = '# Raw Markdown\n'

    sync.onContentChanged('# Raw Markdown\n')
    await flush()

    // The hidden rendered pane must not open (and thereby re-serialize) the
    // source text — doing so would echo a canonicalized copy back into the tab
    // and reset the CodeMirror caret.
    expect(editor.open).not.toHaveBeenCalled()
    expect(tabs.activeTab?.content).toBe('# Raw Markdown\n')
  })

  it('re-syncs the editor when the user returns from source to rendered mode', async () => {
    const editor = makeEditor({ save: '# Canonical\n' })
    session.editor = editor
    view.setMode('source')
    tabs.activeTab!.content = '# Raw Markdown\n'
    const { sync } = makeSync(session)

    view.setMode('rendered')
    sync.onModeChanged('rendered')
    await flush()

    expect(editor.open).toHaveBeenCalledWith('# Raw Markdown\n')
    expect(session.lastLocalMarkdown).toBe('# Canonical\n')
  })

  // C1: the suppress-reapply arm is per tab. A background save (autosave timer,
  // vault-switch flush, closing another tab) used to arm a module-wide flag that
  // the ACTIVE tab then consumed, so the tab the user had just switched to never
  // re-opened the editor: it kept rendering the previous note's model while the
  // tab held the new note's text, and the next keystroke published that stale
  // text into the new tab and autosaved it over the new note's file.
  // C6: `savedContent` is what the tab believes is ON DISK — App.vue hands the
  // live tab to the external-change check, which compares that field with the
  // bytes it reads back. For a file the editor canonicalizes on open (CRLF → LF)
  // the field used to hold the serializer output instead, so the comparison could
  // never succeed: every later watcher event looked like a real modification, a
  // clean tab was silently reloaded (reopening the model, dropping caret and
  // scroll) and a dirty one got a conflict dialog for a change nobody made.
  describe('external-change comparison for a canonicalizing (CRLF) open', () => {
    const DISK_CRLF = '# A\r\n\r\nbody\r\n'
    const CANONICAL_LF = '# A\n\nbody\n'

    async function openCrlfTab(): Promise<{
      store: ReturnType<typeof useTabsStore>
      tab: NonNullable<ReturnType<typeof useTabsStore>['tabs'][number]>
    }> {
      let disk = DISK_CRLF
      readMock.mockImplementation(async () => disk)
      crlfDisk = () => disk
      setCrlfDisk = (next: string) => {
        disk = next
      }
      const store = useTabsStore()
      store.setVault('/vault')
      await store.openTab('/vault/a.md')
      // The outer beforeEach already opened an untitled tab, so take the one that
      // was just opened (and is active) rather than index 0.
      const tab = store.activeTab!
      expect(tab.path).toBe('/vault/a.md')
      // The rendered editor canonicalizes CRLF → LF on open (a real Milkdown
      // serialize round-trip does this).
      session.editor = makeEditor({ save: CANONICAL_LF })
      const { sync } = makeSync(session)
      await sync.applyContent(DISK_CRLF)
      return { store, tab }
    }

    let crlfDisk = (): string => DISK_CRLF
    let setCrlfDisk: (next: string) => void = () => {}

    /** The real comparison service, wired exactly like App.vue wires it. */
    function makeExternal(store: ReturnType<typeof useTabsStore>) {
      const reload = vi.fn(async () => undefined)
      const onConflict = vi.fn()
      let handler: ((e: FsChangeEvent) => void) | null = null
      const external = createExternalDocSync({
        read: async () => crlfDisk(),
        onFsChange: async (cb) => {
          handler = cb
          return () => {
            handler = null
          }
        },
        getVault: () => '/vault',
        getActiveTab: () => store.activeTab,
        isSelfWrite: () => false,
        reload,
        onConflict,
        getOpenTabs: () => store.tabs,
        onMissing: vi.fn(),
      })
      return {
        reload,
        onConflict,
        start: () => external.start(),
        stop: () => external.stop(),
        emit: (e: FsChangeEvent) => handler?.(e),
      }
    }

    it('keeps the on-disk bytes rather than the serializer output', async () => {
      const { tab } = await openCrlfTab()
      expect(tab.content).toBe(CANONICAL_LF)
      expect(tab.savedContent).toBe(DISK_CRLF)
    })

    it('ignores an unchanged disk event and still reloads on a real change', async () => {
      const { store } = await openCrlfTab()
      const external = makeExternal(store)
      await external.start()

      external.emit({ path: '/vault/a.md', kind: 'modified' })
      await flush()
      expect(external.reload).not.toHaveBeenCalled()
      expect(external.onConflict).not.toHaveBeenCalled()

      setCrlfDisk('# A\r\n\r\nEDITED\r\n')
      external.emit({ path: '/vault/a.md', kind: 'modified' })
      await flush()
      expect(external.reload).toHaveBeenCalledWith(store.activeTab!.id)
      external.stop()
    })

    it('does not raise a conflict dialog for a dirty tab whose disk is untouched', async () => {
      const { tab, store } = await openCrlfTab()
      // The user typed after the open: the tab is dirty, the file is unchanged.
      tab.content = '# A\n\nbody edited\n'
      tab.dirty = true
      const external = makeExternal(store)
      await external.start()

      external.emit({ path: '/vault/a.md', kind: 'modified' })
      await flush()
      expect(external.onConflict).not.toHaveBeenCalled()
      expect(external.reload).not.toHaveBeenCalled()
      external.stop()
    })
  })

  it('does not let a background save of another tab swallow the active tab re-apply', async () => {
    const background = tabs.tabs[0]
    await tabs.openTab(null, '# Note B\n')
    const active = tabs.activeTab!
    expect(tabs.activeId).toBe(active.id)
    // The background tab was saved with an onSave rewrite in flight.
    armSuppressReapply(background.id)

    const editor = makeEditor({ save: '# B Canonical\n' })
    session.editor = editor
    const { sync } = makeSync(session)
    active.content = '# B External\n'

    sync.onContentChanged('# B External\n')
    await flush()

    // The active tab's change must reach the editor model...
    expect(editor.open).toHaveBeenCalledWith('# B External\n')
    // ...and the background tab's arm must be untouched (it is still the only tab
    // allowed to consume it).
    expect(shouldSuppressReapply(background.id)).toBe(true)
  })
})
