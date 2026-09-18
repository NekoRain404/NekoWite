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
import { createAgentComposition } from '../../../app/agent-composition'
import { attachmentMonthDir } from '../../attachments'
import { captureEditBaselines } from '../services/agent-edit-apply'
import { createMemoryAgentGateway } from '../../../platform/gateways/memory-agent'
import { useAgentSession } from '../composables/use-agent-session'
import type { AgentLiveNote } from '../services/agent-context-snapshot'
import { initialAgentSessionView, sessionKey } from '../services/agent-session-view'
import type { AgentToolEntry } from '../services/agent-timeline'
import AgentNoteProposals from './AgentNoteProposals.vue'

const readMock = vi.hoisted(() => vi.fn())
const writeMock = vi.hoisted(() => vi.fn())
const statMock = vi.hoisted(() => vi.fn())
const listMock = vi.hoisted(() => vi.fn())
const saveAttachmentMock = vi.hoisted(() => vi.fn())
vi.mock('../../../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    write: writeMock,
    stat: statMock,
    list: listMock,
    saveAttachment: saveAttachmentMock,
    watch: vi.fn(async () => () => {}),
    deleteFile: vi.fn(async () => ''),
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
  statMock.mockReset()
  listMock.mockReset()
  saveAttachmentMock.mockReset()
  statMock.mockImplementation(async (_vault: string, path: string) => ({
    size: new TextEncoder().encode(disk.get(path) ?? '').length,
    mtime: 0,
  }))
  listMock.mockImplementation(async () => [])
  // The port answers with where the file really went, which is what the caller checks the plan's
  // own path against.
  saveAttachmentMock.mockImplementation(async (_vault: string, name: string) =>
    `attachments/${attachmentMonthDir()}/${name}`,
  )
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
    dropped: 0,
    lastDrop: null,
    edits: at,
  }
  // Seeded by key, and nothing else: the store holds no "session in front" for this surface to be
  // pointed at, which is what makes the case below — a *second* session in the same store — a
  // question about this component rather than about the store's pointer.
  sessions.records[key] = record
}

/**
 * The composition the shell hands the editor pane, built the way the app builds it.
 *
 * `environment: 'browser'` only picks the memory gateway — which none of these cases touches — and
 * the insertion binding is the composition's REAL one, over the tab store's own lookup. That is the
 * point: the case below is the first caller `connectSvgInsertion` has ever had, so it is driven
 * through the object the app passes down rather than through a stand-in for it.
 */
function compositionOverTabs() {
  return createAgentComposition({
    vaultId: VAULT,
    environment: 'browser',
    liveNotes: { lookUpLiveNote: (path: string) => useTabsStore().lookUpLiveNote(path) },
  })
}

/** Mount the surface, with the composition wired as the shell wires it. */
async function mountWithInsertions(insertions: ReturnType<typeof compositionOverTabs>): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(AgentNoteProposals, { identity: IDENTITY, insertions })
      },
    }),
  )
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  await nextTick()
  // The artifact is read off the disk by a watcher, which is asynchronous: one macrotask is what
  // the read's own promise chain needs to have landed before the tree is read.
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
  return host
}

/**
 * Another surface of this window on another session, through the real binding.
 *
 * This is the rail's panel when the rail is showing a different session — and it was the state the
 * store's pointer could be left in by the pet's task link, whose click named a session the rail had
 * moved past. The surface below draws its proposals for the session the *shell* hands it, so what
 * this case holds down is that the apply is judged against the same one: a window that is on
 * another session must not be able to send this note's edit somewhere else, or refuse it.
 */
async function anotherSessionOnScreen(): Promise<void> {
  const gateway = createMemoryAgentGateway({ agentId: 'opencode', profileId: 'default' })
  await gateway.start()
  const elsewhere = await gateway.openSession({ vaultId: '/elsewhere', cwd: '/elsewhere' })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(
    defineComponent({
      setup() {
        useAgentSession({ gateway, session: elsewhere })
        return () => null
      },
    }),
  )
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  await nextTick()
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
  // The flow behind a control is a chain of promises — a save reads the file, an insertion reads
  // and writes one — and each await is a turn of its own. Round the loop a few times rather than
  // guessing which one the last state lands on; a case that needed more would be a hang rather
  // than a wrong answer, and the assertions below are about what the user ends up looking at.
  for (let round = 0; round < 6; round += 1) {
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
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

  it('drives the composition’s own insertion binding for an SVG the run staged', async () => {
    // The artifact the engine wrote into the vault, and the call that wrote it.
    const stagedPath = `${VAULT}/attachments/${attachmentMonthDir()}/diagram.svg`
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#123"/></svg>'
    disk.set(stagedPath, markup)
    const svgCall = diffCall({
      toolCallId: 'call-svg',
      paths: [stagedPath],
      content: [],
    })
    await standing(atSend(), svgCall)
    const host = await mountWithInsertions(compositionOverTabs())

    // The verified preview is drawn, and it is the serialiser's output rather than the raw file.
    const preview = host.querySelector('[data-artifact-preview]')
    expect(preview).not.toBeNull()
    expect(preview!.querySelector('svg')).not.toBeNull()
    expect(host.querySelector('[data-artifact-refused]')).toBeNull()

    await click(byAction(host, 'agent-artifact-insert'))

    // The file is in the vault, at the path the note points at…
    expect(saveAttachmentMock).toHaveBeenCalledTimes(1)
    const [vault, name, base64, dir] = saveAttachmentMock.mock.calls[0]!
    expect(vault).toBe(VAULT)
    expect(name).toBe('diagram.svg')
    expect(dir).toBe(`attachments/${attachmentMonthDir()}`)
    expect(Buffer.from(base64 as string, 'base64').toString('utf8')).toBe(markup)

    // …and the note gained exactly the markdown the plan named for it: the reference is measured
    // from the NOTE's own directory (`notes/` here), which is what makes it resolve from there.
    const written = disk.get(PATH)!
    expect(written.startsWith(AT_SEND)).toBe(true)
    expect(written).toContain(`![diagram](../attachments/${attachmentMonthDir()}/diagram.svg)`)
    expect(host.textContent).toContain(t('agent.note.svg.outcome.inserted'))
  })

  it('draws nothing for an artifact the checks refused, and says which check', async () => {
    const stagedPath = `${VAULT}/attachments/${attachmentMonthDir()}/diagram.svg`
    // A doctype is a refusal rather than a sanitisation, and the sentence has to reach the reader:
    // a preview that silently drew nothing would look like a document with no content.
    disk.set(stagedPath, '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>')
    await standing(atSend(), diffCall({ toolCallId: 'call-svg', paths: [stagedPath], content: [] }))
    const host = await mountWithInsertions(compositionOverTabs())

    expect(host.querySelector('[data-artifact-preview]')).toBeNull()
    expect(host.querySelector('[data-artifact-refused]')?.textContent).toContain('doctype')
    expect(byAction(host, 'agent-artifact-insert')).toBeNull()
  })

  it('applies under the session it was handed, not the one another surface is on', async () => {
    await standing()
    await anotherSessionOnScreen()
    const host = await mount()

    await click(byAction(host, 'agent-edit-apply'))

    // The note is where the request left it and the write goes in, judged against the session the
    // shell handed this surface. A store that answered "which session is this" could name the other
    // one — and the apply, which compares the session a proposal was produced under with the one it
    // is applied under, would refuse a write the reader asked for and had every reason to expect.
    expect(disk.get(PATH)).toBe(AGENT_TEXT)
    expect(host.textContent).toContain(t('agent.note.outcome.saved'))
  })

  it('offers nothing when there is no session on screen', async () => {
    const tabs = useTabsStore()
    tabs.setVault(VAULT)
    await tabs.openTab(PATH)
    const host = await mount()

    expect(host.querySelector('[data-agent-note-proposal]')).toBeNull()
  })
})
