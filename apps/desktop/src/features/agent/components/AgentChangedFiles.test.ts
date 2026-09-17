/**
 * The surface the editor pane hosts: what one run changed, and the three answers a user can give
 * about it.
 *
 * The review service and its view were both finished and both mounted nowhere — the audit's row 20,
 * 「建好了但够不到」 for the second time on this feature. So this file mounts the real host over the
 * real stores, clicks its real controls, and asserts on what a person would see: the row a run's
 * call produces, the note's own text and the file's bytes after a rejection, and the sentences the
 * surface owes when it refused to write.
 *
 * The two properties held down here that a screenshot could not: the rejection goes through the
 * note's OWN save transaction (`agent-note-write.ts`), so the assertions are read back off the file
 * the tab wrote; and a note that moved after the agent wrote it is refused rather than overwritten,
 * which is §7.2's 「不能覆盖用户后续编辑」.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { t } from '../../../i18n'
import type { AgentIdentity } from '../../../platform/gateways/agent-contracts'
import { useTabsStore } from '../../../stores/tabs'
import { useAgentSessionStore, type AgentSessionRecord } from '../stores/agent-session'
import { captureEditBaselines } from '../services/agent-edit-apply'
import { initialAgentSessionView, sessionKey } from '../services/agent-session-view'
import type { AgentToolEntry } from '../services/agent-timeline'
import AgentChangedFiles from './AgentChangedFiles.vue'

const readMock = vi.hoisted(() => vi.fn())
const writeMock = vi.hoisted(() => vi.fn())
vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    write: writeMock,
    stat: vi.fn(async () => ({ size: 0, mtime: 0 })),
    list: vi.fn(async () => []),
    watch: vi.fn(async () => () => {}),
    deleteFile: vi.fn(async () => ''),
    listHistory: vi.fn(async () => []),
    readHistory: vi.fn(async () => ''),
    restoreHistory: vi.fn(async () => ''),
    createDir: vi.fn(async () => ''),
    renameEntry: vi.fn(async () => ''),
    saveFileDialog: vi.fn(async () => null),
    saveAttachment: vi.fn(async () => ''),
  },
}))

const VAULT = '/vault'
const PATH = `${VAULT}/notes/a.md`
const BEFORE = '# A\n\nas it was when the question went out'
const AFTER = '# A\n\nthe version the agent wrote'

const IDENTITY: AgentIdentity = {
  agentId: 'opencode',
  profileId: 'default',
  runtimeEpoch: 'epoch-1',
  vaultId: VAULT,
  sessionId: 'session-1',
}

/** The file as the window sees it. A save writes here, so an assertion on it is an assertion about
 *  what the note's own save transaction did rather than about what a component remembered. */
const disk = new Map<string, string>([[PATH, BEFORE]])

let pinia: ReturnType<typeof createPinia>
let mounted: VueApp[] = []

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  disk.set(PATH, BEFORE)
  readMock.mockReset()
  writeMock.mockReset()
  readMock.mockImplementation(async (_vault: string, path: string) => {
    const content = disk.get(path)
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return content
  })
  writeMock.mockImplementation(async (_vault: string, path: string, content: string) => {
    disk.set(path, content)
    return null
  })
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function toolRow(overrides: Partial<AgentToolEntry> = {}): AgentToolEntry {
  return {
    kind: 'tool',
    id: 1,
    runId: 'run-1',
    toolCallId: 'call-1',
    title: `Edit ${PATH}`,
    toolKind: 'edit',
    status: 'completed',
    paths: [PATH],
    content: [{ type: 'diff', path: PATH, oldText: BEFORE, newText: AFTER }],
    input: { state: 'absent' },
    output: { state: 'absent' },
    ...overrides,
  }
}

/**
 * The state a run leaves behind: the note open, the run's call on the timeline, the baseline its
 * send captured, and the file holding what the agent wrote.
 *
 * The file is brought to `AFTER` through the app's own external-sync path (`reloadFromDisk`), not by
 * assigning the tab, because that is how a real external write reaches a tab: the content watcher
 * reads the file and the tab takes the text with nothing unsaved.
 */
async function afterTheRun(entry: AgentToolEntry = toolRow()): Promise<void> {
  const tabs = useTabsStore()
  tabs.setVault(VAULT)
  await tabs.openTab(PATH)
  const held = tabs.lookUpLiveNote(PATH)
  const captured =
    held.kind === 'held' ? captureEditBaselines([held.note], IDENTITY).baselines : []

  disk.set(PATH, AFTER)
  const tab = tabs.tabs.find((candidate) => candidate.path === PATH)
  if (tab !== undefined) await tabs.reloadFromDisk(tab.id)

  const sessions = useAgentSessionStore()
  const key = sessionKey(IDENTITY)
  const record: AgentSessionRecord = {
    identity: IDENTITY,
    view: { ...initialAgentSessionView(IDENTITY), timeline: [entry] },
    draft: '',
    scrollTop: 0,
    unread: false,
    dropped: 0,
    lastDrop: null,
    edits: captured,
  }
  sessions.records[key] = record
  sessions.focus(key)
}

/** Mount the surface as the editor pane mounts it. `identity` is read on every render, which is
 *  what lets the session-switch case below move the session under a mounted surface. */
async function mount(identity: () => AgentIdentity = () => IDENTITY): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(AgentChangedFiles, { identity: identity() })
      },
    }),
  )
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  await nextTick()
  return host
}

/** The session store of the mounted app: one Pinia instance, so this is the store the component
 *  reads rather than a second one that happens to hold the same names. */
const sessionsOf = (): ReturnType<typeof useAgentSessionStore> => useAgentSessionStore()

const row = (host: HTMLElement, path: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[data-path="${path}"][data-attribution]`)
const action = (host: HTMLElement, path: string, name: string): HTMLButtonElement | null =>
  row(host, path)?.querySelector<HTMLButtonElement>(`[data-action="${name}"]`) ?? null
const sentence = (host: HTMLElement, selector: string): string =>
  host.querySelector<HTMLElement>(selector)?.textContent?.trim() ?? ''

async function click(el: Element | null): Promise<void> {
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  // A rejection is a save: a read, a precondition, a write, each its own turn. Round the loop
  // rather than guessing which await the last state lands on.
  for (let round = 0; round < 8; round += 1) {
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await nextTick()
}

describe('what the run changed', () => {
  it('says the run has changed nothing rather than drawing an empty list', async () => {
    // The strip is on screen from the moment a session is live — that one line is how a reader
    // learns where the answers appear — and with no rows it says so instead of drawing a frame.
    const tabs = useTabsStore()
    tabs.setVault(VAULT)
    await tabs.openTab(PATH)
    const key = sessionKey(IDENTITY)
    sessionsOf().records[key] = {
      identity: IDENTITY,
      view: initialAgentSessionView(IDENTITY),
      draft: '',
      scrollTop: 0,
      unread: false,
      dropped: 0,
      lastDrop: null,
      edits: [],
    }
    sessionsOf().focus(key)
    const host = await mount()

    expect(sentence(host, '[data-changes-empty]')).toBe(t('agent.changes.empty'))
    expect(host.querySelectorAll('li[data-path]')).toHaveLength(0)
    expect(host.querySelector('[data-changes-summary]')).toBeNull()
  })

  it('draws nothing at all while no session is up', async () => {
    // No runtime, no run, and nothing to say about one.
    const host = await mount()

    expect(host.querySelector('[data-agent-changes]')).toBeNull()
  })

  it('names the files the run’s own calls changed, and counts them', async () => {
    await afterTheRun()
    const host = await mount()

    expect(row(host, PATH)).not.toBeNull()
    expect(row(host, PATH)?.dataset.attribution).toBe('agent')
    expect(row(host, PATH)?.dataset.verdict).toBe('follows-disk')
    expect(sentence(host, '[data-changes-summary]')).toBe(
      t('agent.changes.summary', { files: '1', kept: '0', putBack: '0', toReview: '1' }),
    )
  })

  it('draws a file the engine only reported as a hint, with no answer offered for it', async () => {
    // `files-changed` is the engine's own list and not an attribution: a row for it says the engine
    // named the file, and a rejection there would claim a version this window never kept.
    await afterTheRun()
    const held = sessionsOf().records[sessionKey(IDENTITY)]
    if (held === undefined) throw new Error('no record')
    held.view = { ...held.view, changedFiles: ['notes/other.md'] }
    const host = await mount()

    expect(row(host, 'notes/other.md')?.dataset.attribution).toBe('reported')
    expect(action(host, 'notes/other.md', 'recover')).toBeNull()
    expect(row(host, 'notes/other.md')?.querySelector('[data-refused]')?.getAttribute('data-refusal')).toBe(
      'not-agent-change',
    )
  })

  it('takes the whole strip out of the way and back, keeping the count readable', async () => {
    await afterTheRun()
    const host = await mount()

    await click(host.querySelector('[data-action="collapse"]'))

    expect(row(host, PATH)).toBeNull()
    expect(sentence(host, '[data-changes-summary]')).toContain('1')

    await click(host.querySelector('[data-action="expand"]'))
    expect(row(host, PATH)).not.toBeNull()
  })
})

describe('the answers', () => {
  it('Review opens the note the change is in, and the row can then be rejected', async () => {
    // A row for a note no tab holds: the run wrote it, the user has not opened it. The window's
    // only write into a note's file is the note's own save transaction, so this is the one state in
    // which a rejection cannot be made — and Review, one click, is how the user gets there.
    // Absolute, because that is how a tab and the engine both spell a path (`agent-note-proposals`
    // normalizes the separator and nothing else) — and `openTab` in the test below is addressed by
    // the same spelling the row shows.
    const CLOSED = `${VAULT}/notes/closed.md`
    await afterTheRun(
      toolRow({ paths: [CLOSED], content: [{ type: 'diff', path: CLOSED, oldText: BEFORE, newText: AFTER }] }),
    )
    // The version the request captured for that note, read through `captureEditBaselines` rather
    // than spelled by hand, so the row is refused for the note not being open and for nothing else.
    const held = sessionsOf().records[sessionKey(IDENTITY)]
    if (held === undefined) throw new Error('no record')
    held.edits = [
      ...held.edits,
      ...captureEditBaselines(
        [{ vaultId: VAULT, path: CLOSED, revision: 'r', buffer: { state: 'clean', text: BEFORE } }],
        IDENTITY,
      ).baselines,
    ]
    disk.set(CLOSED, AFTER)
    useTabsStore().removeAllTabs()
    const host = await mount()

    expect(row(host, CLOSED)?.dataset.verdict).toBe('record')
    expect(action(host, CLOSED, 'recover')).toBeNull()
    expect(row(host, CLOSED)?.querySelector('[data-refused]')?.getAttribute('data-refusal')).toBe(
      'note-not-open',
    )

    await click(action(host, CLOSED, 'view'))

    expect(useTabsStore().tabs.some((tab) => tab.path === CLOSED)).toBe(true)
    // The note is open and holds what the call left, so the rejection is offered with no second
    // frame: the row is rebuilt from the record and the live buffer on every render.
    expect(action(host, CLOSED, 'recover')).not.toBeNull()
  })

  it('Keep records the answer and stops offering the write, without touching the note', async () => {
    await afterTheRun()
    const host = await mount()
    expect(action(host, PATH, 'recover')).not.toBeNull()

    await click(action(host, PATH, 'keep'))

    expect(row(host, PATH)?.dataset.decision).toBe('kept')
    expect(action(host, PATH, 'keep')).toBeNull()
    expect(action(host, PATH, 'recover')).toBeNull()
    // Nothing was written: keeping is a decision about the change, not a write.
    expect(disk.get(PATH)).toBe(AFTER)
    expect(sentence(host, '[data-changes-summary]')).toBe(
      t('agent.changes.summary', { files: '1', kept: '1', putBack: '0', toReview: '0' }),
    )
  })

  it('Reject puts the note back through its own save transaction, and says the file has it', async () => {
    await afterTheRun()
    const host = await mount()

    await click(action(host, PATH, 'recover'))

    // Both halves: the note in front of the user, and the file the tab wrote.
    const tabs = useTabsStore()
    expect(tabs.tabs.find((tab) => tab.path === PATH)?.content).toBe(BEFORE)
    expect(disk.get(PATH)).toBe(BEFORE)
    expect(row(host, PATH)?.dataset.decision).toBe('rejected')
    expect(sentence(host, '[data-agent-changes] [data-decision-outcome]')).toBe(
      t('agent.changes.written.saved'),
    )
  })

  it('refuses a note that moved after the agent wrote it, and writes nothing', async () => {
    // §7.2: 恢复前检查当前内容是否仍等于已记录结果；不一致则三方比较/人工合并，不能覆盖用户后续编辑.
    await afterTheRun()
    const tabs = useTabsStore()
    const tab = tabs.tabs.find((candidate) => candidate.path === PATH)
    if (tab === undefined) throw new Error('no tab')
    tab.content = '# A\n\nwhat I wrote after the agent did'
    disk.set(PATH, tab.content)
    tabs.markSaved(tab.id)
    const host = await mount()

    expect(action(host, PATH, 'recover')).toBeNull()
    expect(row(host, PATH)?.querySelector('[data-refused]')?.getAttribute('data-refusal')).toBe(
      'changed-since',
    )
    expect(disk.get(PATH)).toBe('# A\n\nwhat I wrote after the agent did')
  })

  it('an answer does not carry across a session the engine restarted', async () => {
    // A call id is the engine's, and two sessions can mint the same one — the memory double's own
    // is `run-1:tool`. An answer that outlived the session it was given in would mark a row of the
    // next one as decided, which is the one thing an answer must never do.
    const OTHER: AgentIdentity = { ...IDENTITY, runtimeEpoch: 'epoch-2' }
    await afterTheRun()
    for (const identity of [IDENTITY, OTHER]) {
      const key = sessionKey(identity)
      if (sessionsOf().records[key] === undefined) {
        sessionsOf().records[key] = { ...sessionsOf().records[sessionKey(IDENTITY)]!, identity }
      }
    }
    const which = ref<AgentIdentity>(IDENTITY)
    const host = await mount(() => which.value)

    await click(action(host, PATH, 'keep'))
    expect(row(host, PATH)?.dataset.decision).toBe('kept')

    // The same path, the same call id, another session: the row is unanswered there.
    which.value = OTHER
    await nextTick()

    expect(row(host, PATH)?.dataset.decision).toBe('none')
    expect(action(host, PATH, 'keep')).not.toBeNull()
  })

  it('refuses to write over a note with unsaved edits, and shows both texts', async () => {
    await afterTheRun()
    const tabs = useTabsStore()
    const tab = tabs.tabs.find((candidate) => candidate.path === PATH)
    if (tab === undefined) throw new Error('no tab')
    tab.content = '# A\n\nmy unsaved line'
    tabs.markDirty(tab.id)
    const host = await mount()

    expect(row(host, PATH)?.dataset.verdict).toBe('unsaved-edits')
    expect(action(host, PATH, 'recover')).toBeNull()
    expect(row(host, PATH)?.querySelector('[data-refused]')?.getAttribute('data-refusal')).toBe(
      'unsaved-edits',
    )
    // Both texts are named: the user's, and the one the call said it left.
    expect(sentence(host, '[data-unsaved-buffer] pre')).toBe('# A\n\nmy unsaved line')
    expect(sentence(host, '[data-agent-version] pre')).toBe(AFTER)
    expect(disk.get(PATH)).toBe(AFTER)
  })
})
