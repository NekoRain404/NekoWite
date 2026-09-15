import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { armSuppressReapply, shouldSuppressReapply } from '../../../services/suppress-reapply'
import {
  clearRefusedDocument,
  isRefusedDocument,
  markSourceAuthored,
  renderedModelRefused,
} from '../../../services/editor-ownership'
import { createDocumentSession, documentKey, type DocumentSession } from '../model/document-session'
import { createExternalDocSync } from '../../../services/external-doc-sync'
import type { FsChangeEvent } from '../../../platform/gateways/contracts'
import {
  createEditorExternalSync,
  PREVIEW_RESYNC_DEBOUNCE_MS,
  type EditorExternalSyncDeps,
} from './editor-external-sync'

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

function makeSync(
  session: DocumentSession,
  scheduler = vi.fn(),
  handOff?: () => Promise<void>,
) {
  const deps: EditorExternalSyncDeps = {
    session,
    getEditor: () => session.editor,
    scheduleOverlayRefresh: scheduler,
    handOffPendingEdits: handOff,
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

  afterEach(() => {
    // Module state, shared with the write path; a case that arms it must not
    // leave it armed for the next one.
    clearRefusedDocument()
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
    expect(editor.open).toHaveBeenCalledWith('# External\n', null)
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
    expect(editor.open).toHaveBeenLastCalledWith('# One\n', null)
  })

  /**
   * The hand-off a document switch runs is a whole-document serialization, so a
   * second switch can arrive while the first is still switching. The first must
   * not then open its document over the newer one — the pane would be left on a
   * note the user had already switched away from.
   */
  it('does not open the document a switch was interrupted away from', async () => {
    const tabs = useTabsStore()
    await tabs.openTab(null, '# A\n')
    await tabs.openTab(null, '# B\n')
    await tabs.openTab(null, '# C\n')
    const [a, b, c] = tabs.tabs
    const editor = makeEditor({ save: '# Canonical\n' })
    session.editor = editor
    // The model holds A's document.
    session.appliedKey = documentKey(tabs.vault, a!.id)
    session.appliedContent = '# A\n'
    session.lastLocalMarkdown = '# A\n'

    const gate = deferred()
    const { sync } = makeSync(session, vi.fn(), () => gate.promise)

    // The user switches to B, whose hand-off has not come back yet...
    tabs.setActive(b!.id)
    sync.onContentChanged('# B\n')
    await flush()
    expect(editor.open).not.toHaveBeenCalled()

    // ...and switches on to C before it does. Both hand-offs are the same one.
    tabs.setActive(c!.id)
    sync.onContentChanged('# C\n')
    await flush()
    gate.resolve()
    await flush()

    expect(editor.open).toHaveBeenCalledTimes(1)
    expect(editor.open).toHaveBeenCalledWith('# C\n', null)
    expect(session.appliedContent).toBe('# C\n')
    expect(tabs.tabs.find((t) => t.id === c!.id)?.dirty).toBe(false)
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
    expect(editor.open).toHaveBeenLastCalledWith('# B\n', null)
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
    expect(editor.open).toHaveBeenLastCalledWith('# Newer\n', null)
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

  // C1: the save path cannot see this session, so the refusal has to be
  // published, with the text that failed, for it to refuse anything.
  it('publishes the refused document, and clears it when an open succeeds', async () => {
    const editor = makeEditor({
      save: '# Canonical\n',
      open: vi
        .fn()
        .mockRejectedValueOnce(new Error('bad mdx'))
        .mockResolvedValue(undefined) as NekoEditor['open'],
    })
    session.editor = editor
    const { sync } = makeSync(session)

    await sync.applyContent('# Unknown\n')

    expect(renderedModelRefused()).toBe(true)
    expect(isRefusedDocument('# Unknown\n')).toBe(true)
    expect(isRefusedDocument('# Something else\n')).toBe(false)

    // The user switches back to a rendered view: the re-parse succeeds.
    view.setMode('source')
    view.setMode('rendered')
    sync.onModeChanged('rendered')
    await flush()

    expect(renderedModelRefused()).toBe(false)
    expect(isRefusedDocument('# Unknown\n')).toBe(false)
  })

  // C1, brief 58 (task-56 report). `appliedContent` is a claim that the editor
  // HOLDS that text, and a failed load drops the claim (held-document.ts) while
  // leaving the model showing the previous document. Keeping the claim let the
  // idempotence guard above skip the re-open on the strength of it, so the
  // editor held nothing while the refusal stayed armed — for every note the
  // user switched to afterwards, not just the one that failed.
  it('drops the applied-content claim with the failed load, so coming back re-opens', async () => {
    const openMock = vi.fn(async () => undefined)
    const editor = makeEditor({ save: '# Held\n', open: openMock })
    session.editor = editor
    const { sync } = makeSync(session)
    tabs.activeTab!.content = '# Held\n'

    await sync.applyContent('# Held\n')
    // The state the guard compares: both fields name the text the editor holds.
    expect(session.appliedContent).toBe('# Held\n')
    expect(session.lastLocalMarkdown).toBe('# Held\n')

    // The user opens a file whose parse throws.
    openMock.mockRejectedValueOnce(new Error('bad mdx'))
    await sync.applyContent('# Unknown\n')
    expect(renderedModelRefused()).toBe(true)
    expect(session.appliedContent).toBeNull()

    // They come back to the note the editor was holding, and switch to the
    // rendered view.
    tabs.activeTab!.content = '# Held\n'
    view.setMode('source')
    view.setMode('rendered')
    sync.onModeChanged('rendered')
    await flush()

    // The open ran instead of being skipped as already-applied: the editor
    // holds a document again, which is what clears the refusal.
    expect(editor.open).toHaveBeenCalledTimes(3)
    expect(editor.open).toHaveBeenLastCalledWith('# Held\n', null)
    expect(renderedModelRefused()).toBe(false)
    expect(session.appliedContent).toBe('# Held\n')
  })

  // The document IS loaded here — what failed is installing the callout view.
  // Arming the write guard would refuse saves of a note the model holds.
  it('does not publish a refusal when only the callout install failed', async () => {
    vi.mocked(setCalloutView).mockImplementationOnce(() => {
      throw new Error('editor view is not ready')
    })
    const editor = makeEditor({ save: '# Canonical\n' })
    session.editor = editor
    const { sync } = makeSync(session)

    await sync.applyContent('# Loaded\n')

    expect(session.parseFailed).toBe(true)
    expect(renderedModelRefused()).toBe(false)
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
    expect(editor.open).toHaveBeenLastCalledWith('# Unknown\n', null)
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

    expect(editor.open).toHaveBeenCalledWith('# Raw Markdown\n', null)
    expect(session.lastLocalMarkdown).toBe('# Canonical\n')
  })

  // The editor's parser reads a `.mdx` file with MDX syntax and everything else
  // as Markdown, so the path is not decoration: dropping it makes every document
  // Markdown, and a `.mdx` file loses the constructs only MDX has.
  it('hands the open document its file path, and null for an untitled tab', async () => {
    const editor = makeEditor({ save: '# Canonical\n' })
    session.editor = editor
    const { sync } = makeSync(session)

    tabs.activeTab!.path = '/vault/note.mdx'
    tabs.activeTab!.content = '# Note\n'
    sync.onContentChanged('# Note\n')
    await flush()

    expect(editor.open).toHaveBeenLastCalledWith('# Note\n', '/vault/note.mdx')

    tabs.activeTab!.path = null
    tabs.activeTab!.content = '# Untitled\n'
    sync.onContentChanged('# Untitled\n')
    await flush()

    expect(editor.open).toHaveBeenLastCalledWith('# Untitled\n', null)
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
        isSelfWrite: () => false,
        reload,
        onConflict,
        // The whole tab set, each tab with what it believes is on disk: the
        // service decides for every tab holding the changed file, not only the
        // one on screen.
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

  // Split mode keeps the preview live on purpose: the model follows source
  // edits. What it must NOT do is follow them keystroke by keystroke — the
  // source pane publishes through a 50 ms debounce, so a pause at normal typing
  // speed arrives here as a whole-document re-parse (`open()` rebuilds the
  // ProseMirror state) plus a whole-document re-serialization (`save()`). See
  // `split-reparse-measure` for what that costs on a real note.
  describe('preview re-sync while the source pane authors the text (split)', () => {
    /** What the source pane does when it publishes an edit burst. */
    function sourcePublishes(text: string): void {
      markSourceAuthored(text)
      tabs.activeTab!.content = text
      sync.onContentChanged(text)
    }

    let sync: ReturnType<typeof makeSync>['sync']

    beforeEach(() => {
      view.setMode('split')
      sync = makeSync(session).sync
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('coalesces a typing burst into one re-parse instead of one per pause', async () => {
      const editor = makeEditor({ save: '# Canonical\n' })
      session.editor = editor

      for (let i = 0; i < 5; i += 1) sourcePublishes(`# Typed ${i}\n`)
      // Nothing has been re-parsed yet: the user is still typing.
      expect(editor.open).not.toHaveBeenCalled()

      vi.advanceTimersByTime(PREVIEW_RESYNC_DEBOUNCE_MS)
      await flush()

      expect(editor.open).toHaveBeenCalledTimes(1)
      // The LAST text of the burst, not an intermediate one.
      expect(editor.open).toHaveBeenCalledWith('# Typed 4\n', null)
    })

    it('applies the pending re-sync when asked to (the focus-change flush)', async () => {
      const editor = makeEditor({ save: '# Canonical\n' })
      session.editor = editor

      sourcePublishes('# Typed\n')
      expect(editor.open).not.toHaveBeenCalled()

      // The user has moved to the rendered pane; the model must be current
      // before their first edit is serialized over the source text.
      sync.flushPendingSync()
      await flush()
      expect(editor.open).toHaveBeenCalledWith('# Typed\n', null)
    })

    it('still applies an external change immediately', async () => {
      // A disk reload / history restore is not source-authored text: nothing
      // is typing, so there is no burst to coalesce.
      const editor = makeEditor({ save: '# Canonical\n' })
      session.editor = editor

      tabs.activeTab!.content = '# From disk\n'
      sync.onContentChanged('# From disk\n')
      await flush()

      expect(editor.open).toHaveBeenCalledWith('# From disk\n', null)
    })

    it('drops the pending re-sync when the mode leaves split', async () => {
      const editor = makeEditor({ save: '# Canonical\n' })
      session.editor = editor

      sourcePublishes('# Typed\n')
      view.setMode('source')
      sync.onModeChanged('source')
      vi.advanceTimersByTime(PREVIEW_RESYNC_DEBOUNCE_MS)
      await flush()

      // Source mode owns the text; the model is re-synced on the way back.
      expect(editor.open).not.toHaveBeenCalled()
    })

    it('drops the pending re-sync when the tab goes away', async () => {
      const editor = makeEditor({ save: '# Canonical\n' })
      session.editor = editor

      sourcePublishes('# Typed in the note being closed\n')
      // The tab closed: the watcher reports no content at all.
      sync.onContentChanged(undefined)
      vi.advanceTimersByTime(PREVIEW_RESYNC_DEBOUNCE_MS)
      await flush()

      // A note that is no longer there must not be re-opened into the model.
      expect(editor.open).not.toHaveBeenCalled()
    })

    it('drops the pending re-sync when a save-time rewrite is suppressed', async () => {
      const editor = makeEditor({ save: '# Canonical\n' })
      session.editor = editor

      sourcePublishes('# Typed\n')
      // Saving rewrote the tab (the canonical text) and armed the suppression:
      // the pre-rewrite text still pending must not land after it.
      armSuppressReapply(tabs.activeTab!.id)
      sync.onContentChanged('# Canonical\n')
      vi.advanceTimersByTime(PREVIEW_RESYNC_DEBOUNCE_MS)
      await flush()

      expect(editor.open).not.toHaveBeenCalled()
    })

    it('drops the pending re-sync when another document is applied', async () => {
      const editor = makeEditor({ save: '# Canonical\n' })
      session.editor = editor

      sourcePublishes('# Typed in the old note\n')
      // The user switched notes before the debounce fired: the newer document
      // is applied immediately and the old note's text must not land after it.
      tabs.activeTab!.content = '# Another note\n'
      sync.onContentChanged('# Another note\n')
      await flush()
      vi.advanceTimersByTime(PREVIEW_RESYNC_DEBOUNCE_MS)
      await flush()

      expect(editor.open).toHaveBeenCalledTimes(1)
      expect(editor.open).toHaveBeenCalledWith('# Another note\n', null)
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
    expect(editor.open).toHaveBeenCalledWith('# B External\n', null)
    // ...and the background tab's arm must be untouched (it is still the only tab
    // allowed to consume it).
    expect(shouldSuppressReapply(background.id)).toBe(true)
  })
})
