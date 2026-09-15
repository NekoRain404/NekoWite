/**
 * A keystroke typed into another tab while the vault switch's prompt is up is
 * either saved or asked about, before the switch takes the tab set away.
 *
 * Same defect as the window close's, on the third route that destroys a tab set:
 * `applyVault` read the untitled dirty tabs BEFORE raising the prompt, and then —
 * once the user had answered — registered the new root, committed, and ran
 * `removeAllTabs()`, which cancels every tab's autosave timer on the way. The
 * prompt is a corner toast with no focus trap, so the app is live behind it: the
 * tabs it asked about are the tabs of an earlier moment, and a keystroke typed
 * during the answer belonged to no file and no question.
 *
 * The store is the REAL one and so is the switch (`createDesktopRuntime`); only
 * the gateways, the vault-scoped stores and the two prompts are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setSourceViewHandle } from '../services/source-view'

const h = vi.hoisted(() => {
  const fs = {
    // Signatures declared, not inferred: an inferred mock answers only the value
    // it was built with, and these are answered per test.
    read: vi.fn<(_vault: string, _path: string) => Promise<string>>(),
    write: vi.fn<
      (_vault: string, _path: string, _content: string, _maxHistory?: number) => Promise<string | null>
    >(),
    list: vi.fn(async () => []),
    watch: vi.fn(async () => () => {}),
    deleteFile: vi.fn(async () => ''),
    stat: vi.fn(async () => ({ size: 0, mtime: 0 })),
    listHistory: vi.fn(async () => []),
    readHistory: vi.fn(async () => ''),
    restoreHistory: vi.fn(async () => ''),
    createDir: vi.fn(async () => ''),
    renameEntry: vi.fn(async () => ''),
    saveFileDialog: vi.fn(async (): Promise<string | null> => null),
    registerVault: vi.fn<(_path: string) => Promise<void>>(),
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
    // Stated against the real type rather than inferred: a mock built with one
    // literal narrows its answer to that literal, and a test answering "save" is
    // then a type error vitest never shows.
    requestUntitledVaultSwitch: vi.fn<(_d: { count: number }) => Promise<UntitledVaultChoice>>(),
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

vi.mock('../i18n', () => ({ t: (key: string): string => key }))

import { createDesktopRuntime } from './app-bootstrap'
import { useTabsStore } from '../stores/tabs'
import type { UntitledVaultChoice } from './recovery-closed-loop'

const VAULT_A = '/vaultA'
const VAULT_B = '/vaultB'
const PICKED = `${VAULT_A}/picked.md`

/** Every question the switch put in front of the user, with the control to
 *  answer it: a question the test holds open is a question the app is live
 *  behind, which is the state every test here is about. */
let prompts: { count: number; answer: (choice: UntitledVaultChoice) => void }[] = []

/** Every write the gateway saw, in order, with the root it was tagged with. */
let observed: { vault: string; path: string; content: string }[] = []

/** How many tabs were still dirty at the instant the switch destroyed the set —
 *  `removeAllTabs()` is the point of no return for every open tab. */
let dirtyAtRemoval: number[] = []

const written = (): string[] => observed.map((w) => w.content)

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('a keystroke typed while the vault switch is asking', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    observed = []
    prompts = []
    dirtyAtRemoval = []
    h.fs.read.mockResolvedValue('v1')
    h.fs.write.mockImplementation(async (vault, path, content) => {
      observed.push({ vault, path, content })
      return null
    })
    // The disk a save reads before it writes (`tab-write-preconditions.ts`):
    // whatever the last landed write left there, so an ordinary save is not
    // refused as somebody else's edit — a different mechanism than this one.
    h.fs.read.mockImplementation(async () => observed[observed.length - 1]?.content ?? 'v1')
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
    h.notifyRecovery.mockImplementation((p: { onDismiss: () => void }) => p.onDismiss())
    h.requestUntitledVaultSwitch.mockImplementation(
      (d: { count: number }) =>
        new Promise<UntitledVaultChoice>((resolve) => {
          prompts.push({ count: d.count, answer: resolve })
        }),
    )
    setSourceViewHandle(null)
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Watch the moment the tab set is taken. */
  function watchRemoval(tabs: ReturnType<typeof useTabsStore>): void {
    const removeAllTabs = tabs.removeAllTabs
    vi.spyOn(tabs, 'removeAllTabs').mockImplementation(() => {
      dirtyAtRemoval.push(tabs.tabs.filter((t) => t.dirty).length)
      removeAllTabs()
    })
  }

  /** An untitled dirty tab, which is what raises the question. */
  async function untitledDirtyTab(tabs: ReturnType<typeof useTabsStore>, text: string): Promise<void> {
    await tabs.openTab(null, text)
    tabs.markDirty(tabs.activeId!)
  }

  it('saves the keystroke typed into another tab while the question was up', async () => {
    const tabs = useTabsStore()
    const runtime = createDesktopRuntime()
    tabs.setVault(VAULT_A)
    await untitledDirtyTab(tabs, 'first text')
    // The tab the user types into is not the tab that raised the question: it
    // has a file, it was clean when the switch flushed, and the flush is behind
    // the question — so nothing but this loop can carry what they type next.
    await tabs.openTab(`${VAULT_A}/b.md`)
    const other = tabs.tabs.find((t) => t.path === `${VAULT_A}/b.md`)!
    watchRemoval(tabs)

    const switching = runtime.applyVault(VAULT_B)
    await vi.waitFor(() => expect(prompts).toHaveLength(1))

    other.content = 'v1 typed during the question'
    tabs.markDirty(other.id)
    prompts[0].answer('discard')
    await switching

    // The typing reached the disk before the set went, and it went into the
    // vault it was typed in — not the one being switched to.
    expect(observed).toEqual([
      { vault: VAULT_A, path: `${VAULT_A}/b.md`, content: 'v1 typed during the question' },
    ])
    expect(dirtyAtRemoval).toEqual([0])
    expect(runtime.vaultPath.value).toBe(VAULT_B)
    expect(h.notifyError).not.toHaveBeenCalled()
  })

  it('asks about the untitled tab the user opened while the question was up', async () => {
    const tabs = useTabsStore()
    const runtime = createDesktopRuntime()
    tabs.setVault(VAULT_A)
    await untitledDirtyTab(tabs, 'first text')
    h.fs.saveFileDialog.mockResolvedValue(PICKED)

    const switching = runtime.applyVault(VAULT_B)
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    expect(prompts.map((p) => p.count)).toEqual([1])

    // The user presses + and types, with the toast still on the screen.
    await untitledDirtyTab(tabs, 'late text')
    prompts[0].answer('discard')

    // The answer covered the tab it named and no other: the switch is still
    // asking, about the tab it has never asked about.
    await flush()
    expect(prompts.map((p) => p.count)).toEqual([1, 1])
    expect(tabs.tabs.map((t) => t.content)).toEqual(['late text'])

    prompts[1].answer('save')
    await switching

    expect(written()).toEqual(['late text'])
    expect(runtime.vaultPath.value).toBe(VAULT_B)
    expect(h.notifyError).not.toHaveBeenCalled()
  })

  it('asks once and switches when the user answers the one question it raised', async () => {
    const tabs = useTabsStore()
    const runtime = createDesktopRuntime()
    tabs.setVault(VAULT_A)
    await untitledDirtyTab(tabs, 'only text')
    h.fs.saveFileDialog.mockResolvedValue(PICKED)
    watchRemoval(tabs)

    const switching = runtime.applyVault(VAULT_B)
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    expect(prompts.map((p) => p.count)).toEqual([1])
    prompts[0].answer('save')
    await switching

    // The ordinary switch: one question, one write, and no second pass asking
    // about a tab the user has already ruled on. A loop that re-asked on every
    // pass would pass the two tests above and ruin this one.
    expect(prompts).toHaveLength(1)
    expect(written()).toEqual(['only text'])
    expect(dirtyAtRemoval).toEqual([0])
    expect(runtime.vaultPath.value).toBe(VAULT_B)
  })

  it('does not ask again about the tabs the question already named', async () => {
    const tabs = useTabsStore()
    const runtime = createDesktopRuntime()
    tabs.setVault(VAULT_A)
    await untitledDirtyTab(tabs, 'one')
    await untitledDirtyTab(tabs, 'two')
    h.fs.saveFileDialog.mockResolvedValue(PICKED)

    const switching = runtime.applyVault(VAULT_B)
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    // One question covering both, and the answer to it is final.
    expect(prompts.map((p) => p.count)).toEqual([2])
    prompts[0].answer('save')
    await switching

    expect(prompts).toHaveLength(1)
    expect(written()).toEqual(['one', 'two'])
    expect(runtime.vaultPath.value).toBe(VAULT_B)
  })

  it('commits nothing when the switch was superseded while the question was up', async () => {
    const tabs = useTabsStore()
    const runtime = createDesktopRuntime()
    tabs.setVault(VAULT_A)
    await untitledDirtyTab(tabs, 'only text')
    h.fs.saveFileDialog.mockResolvedValue(PICKED)

    const switching = runtime.applyVault(VAULT_B)
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    // The question is user time, so it is a completion point of the switch — and
    // one whose sequence has moved on must not register a root and take a tab
    // set from the switch that superseded it.
    runtime.dispose()
    prompts[0].answer('save')
    await switching

    expect(observed).toEqual([])
    expect(h.fs.registerVault).not.toHaveBeenCalled()
    expect(runtime.vaultPath.value).toBeNull()
    expect(tabs.vault).toBe(VAULT_A)
    expect(tabs.tabs).toHaveLength(1)
    // And it says nothing: the refusal is a stale reason, not a refusal of
    // anything the user is still doing.
    expect(h.notifyError).not.toHaveBeenCalled()
  })

  it('switches without asking anything when nothing is unsaved', async () => {
    const tabs = useTabsStore()
    const runtime = createDesktopRuntime()
    tabs.setVault(VAULT_A)
    await tabs.openTab(`${VAULT_A}/b.md`)

    await runtime.applyVault(VAULT_B)

    expect(prompts).toHaveLength(0)
    expect(observed).toEqual([])
    expect(runtime.vaultPath.value).toBe(VAULT_B)
    expect(tabs.tabs).toHaveLength(0)
  })
})
