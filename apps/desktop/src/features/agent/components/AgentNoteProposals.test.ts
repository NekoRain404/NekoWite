/**
 * The surface the editor pane hosts: what the agent produced for the note that is open, and the
 * decision about it.
 *
 * `agent-edit-apply.ts` and `AgentEditConflictView.vue` were both finished and both mounted nowhere;
 * the audit's whole point is that tests calling a service directly already passed while no user
 * could reach the thing. So this file mounts the real component over the real stores, clicks its
 * real controls, and asserts on what a person would see — the two texts, the buttons' effect on the
 * note's text, and the sentences the surface owes after a write did not land.
 *
 * Two things it holds down that a screenshot could not. First, the apply runs through
 * `applyAgentEdit`, so a note that moved while the model was thinking produces the conflict and a
 * note that did not is written without a question. Second, the surface keeps its own hands off the
 * document: every write in these cases arrives through the note's save transaction, and the
 * assertions are read back off the file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { t } from '../../../i18n'
import type { AgentIdentity } from '../../../platform/gateways/agent-contracts'
import { useTabsStore } from '../../../stores/tabs'
import { useAgentSessionStore, type AgentSessionRecord } from '../stores/agent-session'
import { captureEditBaselines } from '../services/agent-edit-apply'
import type { AgentLiveNote } from '../services/agent-context-snapshot'
import { initialAgentSessionView, sessionKey } from '../services/agent-session-view'
import type { AgentToolEntry } from '../services/agent-timeline'
import AgentNoteProposals from './AgentNoteProposals.vue'

const readMock = vi.hoisted(() => vi.fn())
const writeMock = vi.hoisted(() => vi.fn())
vi.mock('../../../platform/gateways/fs', () => ({
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
    saveFileDialog: vi.fn(async () => null),
  },
}))

const VAULT = '/vault'
const PATH = `${VAULT}/notes/a.md`
const AT_SEND = '# A\n\nas it was when the question went out'
const AGENT_TEXT = '# A\n\nthe version the agent produced'

const IDENTITY: AgentIdentity = {
  agentId: 'opencode',
  profileId: 'default',
  runtimeEpoch: 'epoch-1',
  vaultId: VAULT,
  sessionId: 'session-1',
}

const disk = new Map<string, string>([[PATH, AT_SEND]])

/** ONE Pinia for the whole case, installed on the app under test as well as made active: the
 *  stores this file seeds are the stores the component reads only if the two are the same
 *  instance, and two Pinia instances with one test between them is a green run that proves
 *  nothing. */
let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  disk.set(PATH, AT_SEND)
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

let mounted: VueApp[] = []

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

/** The note as the editor held it when the request went out: the baseline's whole content. */
function atSend(text = AT_SEND): AgentLiveNote {
  return { vaultId: VAULT, path: PATH, revision: 'page-1:tab-1:0', buffer: { state: 'clean', text } }
}

function diffCall(overrides: Partial<AgentToolEntry> = {}): AgentToolEntry {
  return {
    kind: 'tool',
    id: 1,
    runId: 'run-1',
    toolCallId: 'call-1',
    title: 'Edit notes/a.md',
    toolKind: 'edit',
    status: 'completed',
    paths: [PATH],
    content: [{ type: 'diff', path: PATH, oldText: AT_SEND, newText: AGENT_TEXT }],
    input: { state: 'absent' },
    output: { state: 'absent' },
    ...overrides,
  }
}

/**
 * Open the note in a tab and put a session under it, the way the rail does: the store's own record
 * for the identity, with the baseline its `send` would have captured.
 */
async function standing(note: AgentLiveNote | null = atSend(), entry: AgentToolEntry = diffCall()): Promise<void> {
  const tabs = useTabsStore()
  tabs.setVault(VAULT)
  await tabs.openTab(PATH)

  // The baseline a `send` would have captured, read through the editor's OWN lookup rather than
  // spelled by hand: the revision is an instance identity the tab store composes (a page nonce, a
  // tab id and the editor's edit count), and a hand-written one would make every case below a
  // conflict for the wrong reason.
  const held = tabs.lookUpLiveNote(PATH)
  const at = note === null || held.kind !== 'held' ? [] : captureEditBaselines([held.note], IDENTITY).baselines

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
    edits: at,
  }
  sessions.records[key] = record
  sessions.focus(key)
}

/** Mount the surface and settle its first render. */
async function mount(): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(AgentNoteProposals, { identity: IDENTITY, insertions: null })
      },
    }),
  )
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  await nextTick()
  return host
}

const byAction = (host: HTMLElement, action: string): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)
const conflictText = (host: HTMLElement, role: string): string =>
  host.querySelector<HTMLElement>(`[data-agent-edit-conflict] [data-role="${role}"]`)?.textContent ?? ''

async function click(el: Element | null): Promise<void> {
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await nextTick()
  // The apply's promises resolve over several microtasks; let them all run before reading.
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

describe('the proposal the editor pane draws', () => {
  it('offers the agent’s version of the note that is open, and applies it without a question', async () => {
    await standing()
    const host = await mount()

    expect(host.querySelector('[data-agent-note-proposal]')).not.toBeNull()
    expect(byAction(host, 'agent-edit-discard')).not.toBeNull()

    await click(byAction(host, 'agent-edit-apply'))

    // The note is where the request left it, so there is nothing to ask: the text is in the note
    // and on the file, and the surface says which.
    expect(disk.get(PATH)).toBe(AGENT_TEXT)
    expect(host.querySelector('[data-agent-note-proposal]')).toBeNull()
    // Asserted against the catalogue rather than against a literal: the sentence is the
    // catalogue's, and a test that spelled it here would pass in one language and mean nothing.
    expect(host.textContent).toContain(t('agent.note.outcome.saved'))
  })

  it('shows both texts and takes the answer when the note moved while the model was thinking', async () => {
    await standing()
    const tabs = useTabsStore()
    tabs.activeTab!.content = '# A\n\nwhat I typed while it thought'
    const host = await mount()

    await click(byAction(host, 'agent-edit-apply'))

    // The user's own typing is still in the note, and the question is the one this whole feature
    // was built for: the agent's version against theirs, both of them whole.
    expect(conflictText(host, 'agent')).toBe(AGENT_TEXT)
    expect(conflictText(host, 'note')).toBe('# A\n\nwhat I typed while it thought')
    expect(disk.get(PATH)).toBe(AT_SEND)

    await click(host.querySelector('[data-agent-edit-conflict] [data-action="apply"]'))

    expect(disk.get(PATH)).toBe(AGENT_TEXT)
    expect(host.querySelector('[data-agent-edit-conflict]')).toBeNull()
  })

  it('writes nothing when the user keeps their own version', async () => {
    await standing()
    const tabs = useTabsStore()
    tabs.activeTab!.content = '# A\n\nwhat I typed while it thought'
    const host = await mount()

    await click(byAction(host, 'agent-edit-apply'))
    await click(host.querySelector('[data-agent-edit-conflict] [data-action="discard"]'))

    expect(disk.get(PATH)).toBe(AT_SEND)
    expect(tabs.tabs.find((t) => t.path === PATH)?.content).toBe('# A\n\nwhat I typed while it thought')
    expect(host.textContent).toContain(t('agent.note.outcome.discarded'))
  })

  it('says the file does not have the text when the save was refused', async () => {
    await standing()
    const host = await mount()
    // Somebody else replaced the file after this tab read it: the save's own precondition refuses.
    disk.set(PATH, '# A\n\nwhat another program wrote')

    await click(byAction(host, 'agent-edit-apply'))

    expect(host.textContent).toContain(t('agent.note.outcome.saveFailed'))
    expect(disk.get(PATH)).toBe('# A\n\nwhat another program wrote')
  })

  it('offers nothing at all for a note no request named', async () => {
    await standing()
    const tabs = useTabsStore()
    // The run never named this note, so there is no version for an answer to be checked against —
    // and a control whose only outcome is a refusal is not drawn.
    useAgentSessionStore().records[sessionKey(IDENTITY)]!.edits = []
    void tabs
    const host = await mount()

    expect(host.querySelector('[data-agent-note-proposal]')).toBeNull()
    expect(host.querySelector('[data-agent-edit-conflict]')).toBeNull()
  })

  it('offers nothing when there is no session on screen', async () => {
    const tabs = useTabsStore()
    tabs.setVault(VAULT)
    await tabs.openTab(PATH)
    const host = await mount()

    expect(host.querySelector('[data-agent-note-proposal]')).toBeNull()
  })
})
