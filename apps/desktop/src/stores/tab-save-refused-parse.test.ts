/**
 * C1 (task-37 report, critical) — a save after a refused parse.
 *
 * When `open()` throws, the rendered model still holds the PREVIOUS document,
 * and nothing on the write path consulted the failure: Ctrl+S serialized that
 * stale model into the tab and wrote it to the open file's path. A fresh
 * session blanked a 2 KB note to 0 bytes; a session that already had another
 * note open wrote that note's body under this file's frontmatter. Both reported
 * success — `saveTab` returned true, `dirty` was cleared and "Document saved"
 * went to the screen reader.
 *
 * These cases drive the real chain: the real Milkdown editor, the real external
 * sync, the real persistence layer, the real tabs store and the real save
 * transaction, with a recording fs port. The only substitution is the wiring
 * `useRenderedEditorStack` does at mount (a Pinia store cannot be mounted from a
 * unit test), reproduced in `mountRenderedPane` below.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { basicPlugins, createEditor } from '@nekowite/editor-core'
import {
  clearRefusedDocument,
  markSourceAuthored,
  renderedModelRefused,
  setRenderedFlush,
} from '../services/editor-ownership'
import { setSourceViewHandle } from '../services/source-view'
import { createDocumentSession, type DocumentSession } from '../features/editor/model/document-session'
import { createEditorExternalSync, type EditorExternalSync } from '../features/editor/controller/editor-external-sync'
import { createEditorPersistence } from '../features/editor/controller/editor-persistence'
import { useTabsStore } from './tabs'
import { useViewStore } from './view'
import { t } from '../i18n'

const readMock = vi.hoisted(() => vi.fn())
const writeMock = vi.hoisted(() => vi.fn())
const notifyErrorMock = vi.hoisted(() => vi.fn())
const announceMock = vi.hoisted(() => vi.fn())
vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    write: writeMock,
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
vi.mock('../services/errors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/errors')>()),
  notifyError: notifyErrorMock,
}))
vi.mock('../services/announcer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/announcer')>()),
  announce: announceMock,
}))

/** 2000 nested blockquotes — the 2 KB file that makes `open()` throw. */
const DEEP = '>'.repeat(2000) + ' deep\n'
const NOTE_A = '# Note A\n\nThe other note the user had open.\n'
const BAD_B = '---\ntitle: bad\n---\n\n' + DEEP
/** The ordinary note, in the sense C1 needs: its first serialization is
 *  byte-identical to its source, so the editor is still "holding" exactly the
 *  text the tab has after the open. A note the serializer canonicalizes on open
 *  (CRLF, say) is re-opened instead and never reaches the defect. */
const NOTE_Y = '# Fine\n'

interface PaneHarness {
  session: DocumentSession
  sync: EditorExternalSync
  teardown(): void
}

/**
 * The rendered pane as `useRenderedEditorStack` builds it: a real editor, the
 * external sync over the same session, and the flush hook the save path calls
 * (`setRenderedFlush(() => persistence.flush())`).
 */
function mountRenderedPane(): PaneHarness {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const session = createDocumentSession()
  const editor = createEditor(el, { plugins: basicPlugins })
  session.editor = editor
  const persistence = createEditorPersistence({ session })
  const sync = createEditorExternalSync({
    session,
    getEditor: () => session.editor,
    scheduleOverlayRefresh: () => {},
  })
  setRenderedFlush(() => persistence.flush())
  persistence.attachChangeListener()
  return {
    session,
    sync,
    teardown: () => {
      setRenderedFlush(null)
      setSourceViewHandle(null)
      editor.destroy()
      el.remove()
    },
  }
}

/** Every byte the save path handed the fs port, in order. */
let writes: Array<{ path: string; content: string }> = []

/**
 * Let a fire-and-forget `applyContent` settle.
 *
 * The pane's own mode watcher calls `onModeChanged` without awaiting it (the
 * real editor's open/serialize are promise chains, not timers), so a test that
 * drives a mode switch has to let them finish before it touches the model.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('a save after a refused parse', () => {
  const panes: PaneHarness[] = []

  beforeEach(() => {
    setActivePinia(createPinia())
    readMock.mockReset()
    writeMock.mockReset()
    notifyErrorMock.mockReset()
    announceMock.mockReset()
    writes = []
    writeMock.mockImplementation((_vault: string, path: string, content: string) => {
      writes.push({ path, content })
      return Promise.resolve(null)
    })
  })

  afterEach(() => {
    for (const pane of panes.splice(0)) pane.teardown()
    clearRefusedDocument()
  })

  function mount(): PaneHarness {
    const pane = mountRenderedPane()
    panes.push(pane)
    return pane
  }

  it('variant A — a fresh session does not blank the note, and the save is refused', async () => {
    readMock.mockResolvedValue(DEEP)
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/deep.md')
    const tab = tabs.tabs[0]

    const pane = mount()
    // What the pane does on mount: load the active tab's document.
    await pane.sync.applyContent(tab.content)
    expect(pane.session.parseFailed).toBe(true)
    expect(DEEP.length).toBe(2006)

    // Ctrl+S (ui/EditorPane.vue) → tabs.saveActive() → the save transaction.
    await tabs.saveActive()

    // The file on disk is untouched — nothing was written at all.
    expect(writes).toEqual([])
    // The caller that can see the result sees a refusal, not a success.
    await expect(tabs.saveTab(tab.id)).resolves.toBe(false)
    // ...and the tab still holds the document, undamaged.
    expect(tab.content).toBe(DEEP)
    expect(tab.dirty).toBe(false)
    // The user is told the file was not saved, and is NOT told it was.
    expect(notifyErrorMock).toHaveBeenCalledWith(t('tabs.saveBlockedUnrenderable'))
    expect(announceMock).not.toHaveBeenCalled()
  })

  it('variant B — does not write the other note into this file, and the save is refused', async () => {
    readMock.mockResolvedValue(NOTE_A)
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/a.md')

    const pane = mount()
    await pane.sync.applyContent(NOTE_A)

    // The user clicks the note whose parse throws.
    readMock.mockResolvedValue(BAD_B)
    await tabs.openTab('/vault/bad.md')
    const tab = tabs.tabs[0].path === '/vault/bad.md' ? tabs.tabs[0] : tabs.tabs[1]
    await pane.sync.applyContent(tab.content)
    expect(pane.session.parseFailed).toBe(true)

    await tabs.saveActive()

    expect(writes).toEqual([])
    await expect(tabs.saveTab(tab.id)).resolves.toBe(false)
    expect(tab.content).toBe(BAD_B)
    expect(tab.dirty).toBe(false)
    expect(notifyErrorMock).toHaveBeenCalledWith(t('tabs.saveBlockedUnrenderable'))
    expect(announceMock).not.toHaveBeenCalled()
  })

  it('saves text the user typed in the source pane, without discarding it', async () => {
    readMock.mockResolvedValue(DEEP)
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/deep.md')
    const tab = tabs.tabs[0]

    const pane = mount()
    await pane.sync.applyContent(tab.content)
    expect(pane.session.parseFailed).toBe(true)

    // The user fixed the nesting in the text they were sent to: the source pane
    // publishes through its own debounce and marks the text as its own.
    const fixed = '>'.repeat(10) + ' deep\n'
    setSourceViewHandle({
      getView: () => null,
      flush: () => {
        markSourceAuthored(fixed)
        tab.content = fixed
        tab.dirty = true
      },
    })

    await tabs.saveActive()

    // Their edit reaches the file it came from, and nothing is lost.
    expect(writes).toEqual([{ path: '/vault/deep.md', content: fixed }])
    expect(tab.content).toBe(fixed)
    expect(tab.savedContent).toBe(fixed)
    expect(tab.dirty).toBe(false)
    expect(announceMock).toHaveBeenCalledWith(t('recovery.saved'))
  })

  // NOTE: this case sets `dirty` by hand and never mounts the rendered pane
  // onto the note it saves, so the withheld publish is not in it. It says only
  // that the save *guard* is keyed to the refused text. The publish path — and
  // the model the editor is actually holding — is the case below.
  it('leaves a save of another tab alone while one document is refused', async () => {
    readMock.mockResolvedValue(DEEP)
    const tabs = useTabsStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/deep.md')
    const deepTab = tabs.tabs[0]

    const pane = mount()
    await pane.sync.applyContent(deepTab.content)
    expect(pane.session.parseFailed).toBe(true)

    // A second, perfectly ordinary note. Its own bytes are not the document the
    // model refused, so nothing about it is in doubt.
    readMock.mockResolvedValue(NOTE_Y)
    await tabs.openTab('/vault/fine.md')
    const fineTab = tabs.tabs.find((x) => x.path === '/vault/fine.md')!
    fineTab.dirty = true

    await tabs.saveTab(fineTab.id)

    expect(writes).toEqual([{ path: '/vault/fine.md', content: NOTE_Y }])
  })

  // C1, brief 58 (task-56 report). The refusal is armed for the document that
  // failed to load, but the idempotence guard in front of the re-open is about
  // the text the editor was last opened with — and a failed open leaves that
  // text alone while dropping the editor's claim to hold it. So coming back to
  // a good note, switching to the rendered view, hit the guard and skipped the
  // re-open: the editor held no document, `editor.save()` refused, the rendered
  // pane published nothing — and the save guard never fired either, because it
  // compares this tab's text against the OTHER document's. Ctrl+S then wrote
  // the pre-keystroke text, cleared `dirty` and announced "Document saved", and
  // the typing was gone.
  it('takes the good note back after a refusal, and its save carries what the user typed', async () => {
    readMock.mockResolvedValue(NOTE_Y)
    const tabs = useTabsStore()
    const view = useViewStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/y.md')
    const fineTab = tabs.tabs[0]

    const pane = mount()
    await pane.sync.applyContent(fineTab.content)
    // The defect's precondition, asserted rather than assumed: the model holds
    // this text byte for byte (the pair of fields the guard compares are equal).
    expect(pane.session.lastLocalMarkdown).toBe(NOTE_Y)
    expect(pane.session.appliedContent).toBe(NOTE_Y)

    // The user opens the note the rendered view refuses.
    readMock.mockResolvedValue(DEEP)
    await tabs.openTab('/vault/x.md')
    const refusedTab = tabs.activeTab!
    await pane.sync.applyContent(refusedTab.content)
    expect(pane.session.parseFailed).toBe(true)
    expect(renderedModelRefused()).toBe(true)

    // They click back to the good note (source mode, so nothing is applied) and
    // switch to the rendered view — the ordinary way to keep writing.
    tabs.setActive(fineTab.id)
    pane.sync.onContentChanged(fineTab.content)
    view.setMode('rendered')
    pane.sync.onModeChanged('rendered')
    await settle()

    // The editor holds this document again — the claim is true, and its own
    // serialization answers with the note's text.
    expect(renderedModelRefused()).toBe(false)
    await expect(pane.session.editor!.save()).resolves.toBe(NOTE_Y)

    // The user types in the rendered pane.
    const editorView = pane.session.editor!.getView()
    editorView.dispatch(editorView.state.tr.insertText('TYPED ', 1))

    await tabs.saveActive()

    // The file receives the typing — not the text from before the keystroke —
    // and the save still reports what it did.
    expect(writes).toEqual([{ path: '/vault/y.md', content: '# TYPED Fine\n' }])
    expect(fineTab.content).toBe('# TYPED Fine\n')
    expect(fineTab.dirty).toBe(false)
    expect(announceMock).toHaveBeenCalledWith(t('recovery.saved'))
  })

  // The other half of the case above: the way back into a rendered view is the
  // same for the refused document, and a retry that fails again must leave the
  // refusal armed — the P0 it exists for is the save of THAT document, and the
  // fix above must not be reachable by clearing the refusal on the way in.
  it('keeps refusing the document that fails again when the user returns to it', async () => {
    readMock.mockResolvedValue(DEEP)
    const tabs = useTabsStore()
    const view = useViewStore()
    tabs.setVault('/vault')
    await tabs.openTab('/vault/deep.md')
    const tab = tabs.tabs[0]

    const pane = mount()
    await pane.sync.applyContent(tab.content)
    expect(pane.session.parseFailed).toBe(true)

    // Back to the rendered view: the retry runs and fails again on the same
    // 2 KB of nesting.
    view.setMode('rendered')
    pane.sync.onModeChanged('rendered')
    await settle()

    expect(pane.session.parseFailed).toBe(true)
    expect(renderedModelRefused()).toBe(true)

    await tabs.saveActive()

    expect(writes).toEqual([])
    expect(tab.content).toBe(DEEP)
    expect(notifyErrorMock).toHaveBeenCalledWith(t('tabs.saveBlockedUnrenderable'))
    expect(announceMock).not.toHaveBeenCalled()
  })
})
