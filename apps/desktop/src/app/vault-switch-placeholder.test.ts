/**
 * A vault switch is blocked by a tab whose first read has not landed.
 *
 * The third route of the same family as brief 104's two closes. `applyVault`
 * flushes the dirty tabs and, if the flush does not come back clean, aborts the
 * switch with `tabs.unsavedWorkBlocker` — the sentence that was written for
 * exactly this action, and the correct one here. What is not correct is that a
 * placeholder (an EMPTY document wearing a note's path) can never answer that
 * flush: `tab-write-preconditions.ts` refuses every write while `loading`, and
 * rightly, so `flushDirty()` is false for as long as the read is pending —
 * forever, if it never lands. The switch then never happens, with nothing on the
 * path able to settle it but the read itself.
 *
 * The text typed into such a tab is not the note's and cannot be written to the
 * note, so it moves to a tab of its own — and it has to move BEFORE the flush,
 * because the untitled prompt below the flush is the thing that offers the user
 * their text back before `removeAllTabs()` takes the tab set away.
 *
 * The store is the REAL one here; only the gateways, the settings/vault-session/
 * refs stores and the recovery prompts are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setSourceViewHandle } from '../services/source-view'

const h = vi.hoisted(() => {
  const fs = {
    read: vi.fn(),
    write: vi.fn(),
    list: vi.fn(async () => []),
    watch: vi.fn(async () => () => {}),
    deleteFile: vi.fn(async () => ''),
    stat: vi.fn(async () => ({ size: 0, mtime: 0 })),
    listHistory: vi.fn(async () => []),
    readHistory: vi.fn(async () => ''),
    restoreHistory: vi.fn(async () => ''),
    createDir: vi.fn(async () => ''),
    renameEntry: vi.fn(async () => ''),
    saveFileDialog: vi.fn(async () => null),
    registerVault: vi.fn(async () => undefined),
    onFsChange: vi.fn(async () => () => {}),
  }
  return {
    fs,
    gateways: {
      fs,
      dialogs: { openFolderDialog: vi.fn(async () => null), saveFileDialog: fs.saveFileDialog },
      events: { on: vi.fn(), emit: vi.fn() },
      ai: { complete: vi.fn(), cancel: vi.fn(), listModels: vi.fn() },
      keys: { storeAiKey: vi.fn(), loadAiKey: vi.fn() },
    },
    settingsMock: {
      maxHistory: 10,
      autosaveInterval: 'off' as const,
      loadKey: vi.fn(async () => undefined),
    },
    vaultSessionMock: {
      indexVault: vi.fn(async () => undefined),
      detachVault: vi.fn(),
      cancelSearchIndexBuild: vi.fn(),
    },
    refsMock: { loadVault: vi.fn(async () => undefined), clear: vi.fn() },
    loadVaultPlugins: vi.fn(async () => undefined),
    deactivateVaultPlugins: vi.fn(),
    vaultFileIndex: {
      get: vi.fn(async () => []),
      isTruncated: vi.fn(() => false),
      isIncomplete: vi.fn(() => false),
    },
    tmpRecovery: { scan: vi.fn(async () => undefined), gc: vi.fn(async () => undefined), cancel: vi.fn() },
    createTmpRecovery: vi.fn(),
    windowTracking: { restore: vi.fn(), start: vi.fn(), flush: vi.fn(), dispose: vi.fn() },
    // Stated against the real type rather than inferred: `'discard' as const`
    // narrows the mock's return to that one literal, so the test that answers
    // "save" (`mockResolvedValue('save')`) is a type error — and vitest strips
    // types while eslint does not typecheck, so `vue-tsc` is the only thing
    // that sees it. Three test files in this tree have been caught by the same
    // shape today.
    requestUntitledVaultSwitch: vi.fn(async (): Promise<UntitledVaultChoice> => 'discard'),
    notifyError: vi.fn(),
    notifyRecovery: vi.fn(),
  }
})

vi.mock('../platform/gateways/fs', () => ({ fsService: h.fs }))

vi.mock('../platform/runtime/gateway-runtime', () => ({
  getSharedGateways: () => h.gateways,
  initSharedGateways: vi.fn(),
  resetSharedGateways: vi.fn(),
}))

vi.mock('./window-state', () => ({ setupWindowTracking: () => h.windowTracking }))

vi.mock('./recovery-closed-loop', () => ({
  createTmpRecovery: h.createTmpRecovery,
  requestUntitledVaultSwitch: h.requestUntitledVaultSwitch,
}))

vi.mock('../services/vault-files', () => ({ vaultFileIndex: h.vaultFileIndex }))

vi.mock('../services/plugins', () => ({
  loadVaultPlugins: h.loadVaultPlugins,
  deactivateVaultPlugins: h.deactivateVaultPlugins,
}))

vi.mock('../services/editor-bridge', () => ({
  editorBridge: { setEditor: vi.fn(), getEditor: vi.fn(), getView: vi.fn(), onEditorChange: vi.fn() },
}))

vi.mock('../features/editor/session-manager', () => ({
  editorSessionManager: { destroyAll: vi.fn(), destroySession: vi.fn() },
}))

vi.mock('../stores/settings', () => ({ useSettingsStore: () => h.settingsMock }))
vi.mock('../stores/vault-session', () => ({ useVaultSessionStore: () => h.vaultSessionMock }))
vi.mock('../stores/refs', () => ({ useRefsStore: () => h.refsMock }))

vi.mock('../services/errors', () => ({
  notifyError: h.notifyError,
  notifyRecovery: h.notifyRecovery,
}))

// The keys are what the user-facing sentence is; asserting on the key keeps the
// test about which sentence was chosen.
vi.mock('../i18n', () => ({ t: (key: string): string => key }))

import { createDesktopRuntime } from './app-bootstrap'
import type { UntitledVaultChoice } from './recovery-closed-loop'
import { useTabsStore } from '../stores/tabs'

const CLOSE_WHILE_LOADING = 'tabs.closeWhileLoading'
const SWITCH_BLOCKED = 'tabs.unsavedWorkBlocker'

/** Every sentence the switch put in front of the user, in order. */
let notices: string[] = []

/** The tab set as it stood when the keep-or-discard prompt was raised. */
let atUntitledPrompt: string[] = []

const snapshot = (): string[] =>
  useTabsStore().tabs.map((tab) => `${tab.path ?? 'untitled'}|${tab.dirty}|${tab.content}`)

function collectNotices(): void {
  notices = []
  atUntitledPrompt = []
  h.notifyError.mockImplementation((m: string) => {
    notices.push(m)
  })
  h.notifyRecovery.mockImplementation((p: { onDismiss: () => void }) => p.onDismiss())
}

/** A first read the test decides when — or whether — to answer. Later reads
 *  (the save path compares the disk against the tab before it writes) answer at
 *  once, so a flush that does reach the write path does not park on them. */
function parkedRead(disk: string) {
  let settle: ((content: string) => void) | null = null
  let first = true
  h.fs.read.mockImplementation(() => {
    if (!first) return Promise.resolve(disk)
    first = false
    return new Promise<string>((resolve) => {
      settle = resolve
    })
  })
  return { land: () => settle?.(disk) }
}

/** A keystroke as the panes deliver it once published. */
function typeInto(tab: { id: string; content: string }, text: string): void {
  const tabs = useTabsStore()
  tab.content = text
  tabs.markDirty(tab.id)
}

const NOTE_PATH = '/vaultA/a.md'

function writesTo(path: string): unknown[] {
  return h.fs.write.mock.calls.filter((c) => c[1] === path)
}

describe('a vault switch with a tab whose first read has not landed', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    h.fs.write.mockResolvedValue(null)
    h.fs.saveFileDialog.mockResolvedValue(null)
    h.fs.registerVault.mockResolvedValue(undefined)
    h.fs.watch.mockResolvedValue(() => {})
    h.fs.onFsChange.mockResolvedValue(() => {})
    h.createTmpRecovery.mockReturnValue(h.tmpRecovery)
    h.settingsMock.loadKey.mockResolvedValue(undefined)
    h.vaultSessionMock.indexVault.mockResolvedValue(undefined)
    h.vaultSessionMock.detachVault.mockImplementation(() => {})
    h.vaultSessionMock.cancelSearchIndexBuild.mockImplementation(() => {})
    h.refsMock.loadVault.mockResolvedValue(undefined)
    h.refsMock.clear.mockImplementation(() => {})
    h.loadVaultPlugins.mockResolvedValue(undefined)
    h.deactivateVaultPlugins.mockImplementation(() => {})
    h.requestUntitledVaultSwitch.mockResolvedValue('discard')
    collectNotices()
    setSourceViewHandle(null)
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('switches the vault, moving the typing into a tab the prompt then covers', async () => {
    // The read never lands: this is the unbounded form.
    parkedRead('DISK BEFORE')
    const tabs = useTabsStore()
    const runtime = createDesktopRuntime()
    tabs.setVault('/vaultA')
    const opening = tabs.openTab(NOTE_PATH)
    typeInto(tabs.tabs[0], 'USER TYPED')
    h.requestUntitledVaultSwitch.mockImplementation(async () => {
      atUntitledPrompt.push(...snapshot())
      return 'discard'
    })

    await runtime.applyVault('/vaultB')

    expect(runtime.vaultPath.value).toBe('/vaultB')
    expect(tabs.vault).toBe('/vaultB')
    expect(h.fs.registerVault).toHaveBeenCalledWith('/vaultB')
    // Before the switch took the tab set away, the user's text was in an
    // untitled tab and the prompt asked them what to do with it.
    expect(atUntitledPrompt).toContain('untitled|true|USER TYPED')
    expect(notices).toContain(CLOSE_WHILE_LOADING)
    expect(notices).not.toContain(SWITCH_BLOCKED)
    // The placeholder's borrowed text never reached the note's file.
    expect(writesTo(NOTE_PATH)).toHaveLength(0)
    expect(h.fs.write).not.toHaveBeenCalled()
    void opening
  })

  it('keeps the typing in ONE untitled tab when the save-as cannot land, and never writes the note', async () => {
    parkedRead('DISK BEFORE')
    const tabs = useTabsStore()
    const runtime = createDesktopRuntime()
    tabs.setVault('/vaultA')
    const opening = tabs.openTab(NOTE_PATH)
    typeInto(tabs.tabs[0], 'USER TYPED')
    // The user answers "save" and then cancels the file dialog: the switch is
    // blocked this time (the text is not on disk), and the text has to be where
    // they left it.
    h.requestUntitledVaultSwitch.mockResolvedValue('save')

    await runtime.applyVault('/vaultB')

    expect(runtime.vaultPath.value).toBeNull()
    expect(tabs.vault).toBe('/vaultA')
    expect(notices).toContain(SWITCH_BLOCKED)
    const untitled = tabs.tabs.filter((t) => t.path === null)
    expect(untitled).toHaveLength(1)
    expect(untitled[0].content).toBe('USER TYPED')
    expect(untitled[0].dirty).toBe(true)
    expect(writesTo(NOTE_PATH)).toHaveLength(0)
    void opening
  })

  it('switches without a prompt or a message when nothing was typed into the loading tab', async () => {
    parkedRead('DISK BEFORE')
    const tabs = useTabsStore()
    const runtime = createDesktopRuntime()
    tabs.setVault('/vaultA')
    const opening = tabs.openTab(NOTE_PATH)
    expect(tabs.tabs[0].loading).toBe(true)

    await runtime.applyVault('/vaultB')

    // Nothing of the user's was in it: no rescue, no sentence, no prompt.
    expect(runtime.vaultPath.value).toBe('/vaultB')
    expect(h.requestUntitledVaultSwitch).not.toHaveBeenCalled()
    expect(notices).toHaveLength(0)
    expect(h.fs.write).not.toHaveBeenCalled()
    void opening
  })
})
