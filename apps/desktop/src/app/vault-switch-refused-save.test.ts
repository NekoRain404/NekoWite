/**
 * A vault switch blocked by a file that refuses the write now offers a way out,
 * and takes it to the vault the text was typed in.
 *
 * The third and last route of a family this session closed twice. `applyVault`
 * flushed the dirty tabs and, when the flush did not come back clean, reported
 * `tabs.unsavedWorkBlocker` and returned — while the window close and "Close
 * all" both reach `createUnflushableRescue` and offer the text a copy under a
 * name the user picks. A note restored from the trash carries the read-only bit,
 * so a user can meet this without ever having set it, and the switch is
 * destructive — it runs `removeAllTabs()` and replaces the authorized root — so
 * the refusal protects them from a real loss and, without a route, protects them
 * into a dead end: the only ways forward were to lose the edits or to leave the
 * app and `chmod` the file.
 *
 * Two claims here are not about the outcome, and the tests say so:
 *
 *   * **the copy is written into the OUTGOING vault, before `registerVault`
 *     replaces the authorized root.** Asserted on the path — what the switch had
 *     already done at the instant each write was issued — because "the switch
 *     committed and a copy exists" is exactly what a rescue placed after the
 *     registration produces against a gateway that does not enforce the
 *     backend's rule. The gateway below does enforce it: once a root is
 *     registered, a write tagged with any other root is refused, which is what
 *     the real backend does and why the ordering is load-bearing rather than
 *     tidy.
 *   * **a switch that saves cleanly is asked nothing at all** — no prompt, no
 *     message, no dialog.
 *
 * The store is the REAL one and so is the switch (`createDesktopRuntime`); only
 * the gateways, the vault-scoped stores and the two prompts are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setSourceViewHandle } from '../services/source-view'

const h = vi.hoisted(() => {
  const fs = {
    // Signatures declared rather than inferred: an inferred mock answers only the
    // value it was built with, and these are answered per test.
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
    // Its signature again, because the tests read the roots it was asked for:
    // the ordering claim is about when this call had happened, not whether.
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
    tmpRecovery: {
      scan: vi.fn(async () => undefined),
      gc: vi.fn(async () => undefined),
      cancel: vi.fn(),
    },
    createTmpRecovery: vi.fn(),
    windowTracking: { restore: vi.fn(), start: vi.fn(), flush: vi.fn(), dispose: vi.fn() },
    // Stated against the real type rather than inferred: `'discard' as const`
    // narrows the mock's return to that one literal, so a test answering "save"
    // is a type error vitest would never show (`vue-tsc` is the only thing that
    // sees it). This route never meets an untitled tab; the type is here so the
    // file cannot ship that shape again.
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

// Keys, plus params: which sentence was chosen AND which file it named. The
// rescue prompt is asserted by key, because the key is the choice being tested.
vi.mock('../i18n', () => ({
  t: (key: string, params?: Record<string, unknown>): string =>
    params ? `${key} ${JSON.stringify(params)}` : key,
}))

import { createDesktopRuntime } from './app-bootstrap'
import { useTabsStore } from '../stores/tabs'
import { READ_ONLY_PREFIX, copyNameFor } from '../stores/write-refusal'
import type { RecoveryPrompt } from '../services/errors'
import type { UntitledVaultChoice } from './recovery-closed-loop'

const VAULT_A = '/vaultA'
const VAULT_B = '/vaultB'
const NOTE = `${VAULT_A}/ro.md`
const COPY = copyNameFor(NOTE)
const TYPED = 'typed into a protected note'

const SWITCH_BLOCKED = 'tabs.unsavedWorkBlocker'
const COPY_OFFER = 'tabs.unsavedWorkRescue'
const READ_ONLY_NAMED = `tabs.saveBlockedReadOnlyCopy {"path":"${NOTE}"}`

/** Every question the switch raised, in order. The test answers each one, which
 *  is what makes "the route was offered" and "the user took it" two states
 *  rather than one. */
let prompts: RecoveryPrompt[] = []
/** Every sentence either the switch or the write path put in front of the user. */
let notices: string[] = []
/** Every write the gateway saw, with the switch's state at the instant it was
 *  issued: the ordering evidence, and the reason it is taken here rather than
 *  inferred afterwards. */
let observed: {
  vault: string
  path: string
  content: string
  rootsRegistered: number
}[] = []

function collect(): void {
  notices = []
  prompts = []
  h.notifyError.mockImplementation((m: string) => {
    notices.push(m)
  })
  h.notifyRecovery.mockImplementation((p: RecoveryPrompt) => {
    prompts.push(p)
    notices.push(p.message)
  })
}

/** The root the backend is currently authorized for, or null before the first
 *  registration. `registerVault` is the only thing that changes it. */
function registeredRoot(): string | null {
  const calls = h.fs.registerVault.mock.calls
  return calls.length > 0 ? calls[calls.length - 1][0] : null
}

/**
 * The vault-tagged write as the backend runs it. Two of its rules are
 * load-bearing here and both are the real ones: a read-only note refuses every
 * write aimed at it (the bit a note restored from the trash carries, which the
 * user need never have set), and once `registerVault` has replaced the
 * authorized root, a write tagged with any other root is refused outright —
 * which is why the copy route has to run before that call rather than after it.
 *
 * `readOnlyNote: false` is the ordinary file, for the test that must see a
 * switch with nothing at all to refuse.
 */
function gateway(readOnlyNote = true): void {
  observed = []
  h.fs.write.mockImplementation(async (vault, path, content) => {
    observed.push({ vault, path, content, rootsRegistered: h.fs.registerVault.mock.calls.length })
    const root = registeredRoot()
    if (root !== null && vault !== root) throw new Error(`vault root not opened: ${vault}`)
    if (readOnlyNote && path === NOTE) throw new Error(`${READ_ONLY_PREFIX}read-only file`)
    return null
  })
}

/** Every write that landed on `path`, by content. */
function writesTo(path: string): string[] {
  return observed.filter((w) => w.path === path).map((w) => w.content)
}

/** A note with the user's typing in its tab, and the vault it was typed in. */
async function typedIntoTheNote(): Promise<ReturnType<typeof useTabsStore>> {
  const tabs = useTabsStore()
  tabs.setVault(VAULT_A)
  await tabs.openTab(NOTE)
  tabs.tabs[0].content = TYPED
  tabs.markDirty(tabs.tabs[0].id)
  return tabs
}

describe('a vault switch blocked by a file that refuses the write', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    h.fs.read.mockResolvedValue('on disk')
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
    collect()
    setSourceViewHandle(null)
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('offers the route, and switches once the user takes it', async () => {
    h.fs.saveFileDialog.mockResolvedValue(COPY)
    gateway()
    const tabs = await typedIntoTheNote()
    const runtime = createDesktopRuntime()

    const switching = runtime.applyVault(VAULT_B)
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    // The route the two closes have always had, on this control too — asked,
    // never taken on the user's behalf.
    expect(prompts.map((p) => p.message.split(' ')[0])).toEqual([COPY_OFFER])
    expect(h.fs.saveFileDialog).not.toHaveBeenCalled()

    prompts[0].onRestore()
    await switching

    // The switch went through, and it took the tab set with it — the text was
    // the only thing that mattered, and it is on disk under the picked name.
    expect(runtime.vaultPath.value).toBe(VAULT_B)
    expect(tabs.vault).toBe(VAULT_B)
    expect(tabs.tabs).toHaveLength(0)
    expect(writesTo(COPY)).toEqual([TYPED])
    // Both attempts at the note — the flush's and the copy route's — were
    // refused, and neither wrote anything: the protected file is untouched.
    expect(writesTo(NOTE)).toEqual([TYPED, TYPED])
    // The dialog proposed a name that is not the file that refused, and opened
    // in the vault the text was typed in.
    expect(h.fs.saveFileDialog).toHaveBeenCalledWith(COPY, VAULT_A)
    expect(notices).toContain(READ_ONLY_NAMED)
    // Nothing was refused in the end: the route was the way through.
    expect(notices).not.toContain(SWITCH_BLOCKED)
  })

  it('writes the copy into the outgoing vault, before the root is replaced', async () => {
    h.fs.saveFileDialog.mockResolvedValue(COPY)
    gateway()
    await typedIntoTheNote()
    const runtime = createDesktopRuntime()

    const switching = runtime.applyVault(VAULT_B)
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    prompts[0].onRestore()
    await switching

    const copy = observed.find((w) => w.path === COPY)
    expect(copy).toBeDefined()
    // The ordering, asserted on the path: at the instant the copy's write was
    // issued, `registerVault` had not been called. A rescue placed one line
    // lower passes every assertion about the result — the switch commits, the
    // copy exists — and fails this one; against the real backend it does not
    // even get that far, because the root it would be tagged with is no longer
    // the authorized one.
    expect(copy?.rootsRegistered).toBe(0)
    // And it is tagged with the OUTGOING vault, which is where a note the user
    // typed in while `/vaultA` was open belongs — not the one being switched to.
    expect(copy?.vault).toBe(VAULT_A)
    expect(copy?.content).toBe(TYPED)
    // The other side of the same ordering: the root was replaced afterwards.
    expect(h.fs.registerVault).toHaveBeenCalledWith(VAULT_B)
    expect(h.fs.registerVault.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.fs.write.mock.invocationCallOrder[observed.indexOf(copy!)],
    )
  })

  it('leaves the vault and the text where they were when the route is declined', async () => {
    gateway()
    const tabs = await typedIntoTheNote()
    const runtime = createDesktopRuntime()

    const switching = runtime.applyVault(VAULT_B)
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    prompts[0].onDismiss()
    await switching

    // Nothing moved: not the vault, not the root, not the tab set.
    expect(runtime.vaultPath.value).toBeNull()
    expect(tabs.vault).toBe(VAULT_A)
    expect(h.fs.registerVault).not.toHaveBeenCalled()
    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.tabs[0].content).toBe(TYPED)
    expect(tabs.tabs[0].dirty).toBe(true)
    // No copy was written anywhere, and nothing was aimed at the protected file
    // beyond the attempts that were refused.
    expect(writesTo(COPY)).toEqual([])
    expect(writesTo(NOTE)).toEqual([TYPED])
    // And the refusal says so, in the sentence this action owns.
    expect(notices).toContain(SWITCH_BLOCKED)
  })

  it('does not commit a switch that was superseded while the route was open', async () => {
    h.fs.saveFileDialog.mockResolvedValue(COPY)
    gateway()
    const tabs = await typedIntoTheNote()
    const runtime = createDesktopRuntime()

    const switching = runtime.applyVault(VAULT_B)
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    // The route is user time, so it is a completion point of the switch — and a
    // switch whose sequence has moved on must not register a root and take a tab
    // set from the one that superseded it. Teardown is the same judgement
    // `isStale` makes for a newer switch (`disposed` is the other half of it).
    runtime.dispose()
    prompts[0].onRestore()
    await switching

    // The user's answer still stands — the copy they asked for was written —
    // and nothing of the vault switch was applied on top of it.
    expect(writesTo(COPY)).toEqual([TYPED])
    expect(runtime.vaultPath.value).toBeNull()
    expect(h.fs.registerVault).not.toHaveBeenCalled()
    expect(tabs.vault).toBe(VAULT_A)
    expect(tabs.tabs).toHaveLength(1)
  })

  it('switches without asking anything at all when every save lands', async () => {
    gateway(false)
    const tabs = await typedIntoTheNote()
    const runtime = createDesktopRuntime()

    await runtime.applyVault(VAULT_B)

    // The ordinary switch: the flush wrote the text, nothing was asked, and no
    // route was offered for a refusal that never happened.
    expect(writesTo(NOTE)).toEqual([TYPED])
    expect(prompts).toEqual([])
    expect(notices).toEqual([])
    expect(h.fs.saveFileDialog).not.toHaveBeenCalled()
    expect(h.fs.registerVault).toHaveBeenCalledWith(VAULT_B)
    expect(runtime.vaultPath.value).toBe(VAULT_B)
    expect(tabs.vault).toBe(VAULT_B)
  })
})
