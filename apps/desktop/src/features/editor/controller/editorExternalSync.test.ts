import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { NekoEditor } from '@nekowite/editor-core'
import { setCalloutView } from '../../../plugins/callout'
import { notifyError } from '../../../services/errors'
import { useTabsStore } from '../../../stores/tabs'
import { useViewStore } from '../../../stores/view'
import { createDocumentSession, type DocumentSession } from '../model/documentSession'
import { createEditorExternalSync, type EditorExternalSyncDeps } from './editorExternalSync'

vi.mock('../../../plugins/callout', () => ({ setCalloutView: vi.fn() }))
vi.mock('../../../services/errors', () => ({
  notifyError: vi.fn(),
  notifyRecovery: vi.fn(),
}))
// The tab store (imported inside editorExternalSync for active content) reads
// files on openTab; a null-path openTab skips the fs read entirely, so no
// platform mock is needed here.

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
})
