/**
 * The pane that hosts the agent's change-review surface — held in the state it is drawn in, and in
 * the ones it is not.
 *
 * Every other place that exercises that surface mounts it by hand. `AgentChangedFiles.test.ts`
 * builds it over the real stores to assert what it says and what its three answers do, and
 * `e2e/agent-changes.spec.ts` mounts it under a scripted runtime because the application's own
 * session is nobody's script — so neither can hold the property this file exists for: that the
 * pane the *application* mounts is the one that hosts it. `ui/EditorPane.vue` places
 * `<AgentChangedFiles>` above the proposals with a docblock giving the reason (Review opens the
 * note, Keep answers about it, Reject writes it back through the note's own save, so the list
 * belongs where the notes are), and nothing pinned that placement: the pane's four neighbouring
 * specs cover the editor, the image intake, the scroll sync and the tail space, so the element
 * could be deleted from the template with every one of them still green — §6.7's 「建好了但够不到」
 * at its last inch.
 *
 * So this mounts the REAL pane, the way its neighbours mount it, with the shell's own prop handed
 * in as `app/AppShell.vue` hands it in (`:agent-identity="agentForEditor"`), over a session record
 * seeded the way `AgentChangedFiles.test.ts` seeds one. The assertions are on `data-*` attributes
 * and structure and never on copy: every word the surface draws comes from its caller, so a spec
 * that matched a sentence would break on a rewording rather than on a defect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App as VueApp } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import type { AgentIdentity } from '../platform/gateways/agent-contracts'
import { useTabsStore } from '../stores/tabs'
import {
  useAgentSessionStore,
  type AgentSessionRecord,
} from '../features/agent/stores/agent-session'
import { initialAgentSessionView, sessionKey } from '../features/agent/services/agent-session-view'
import { captureEditBaselines } from '../features/agent/services/agent-edit-apply'
import type { AgentToolEntry } from '../features/agent/services/agent-timeline'

// The window's file access, as a map this file owns: the note is read when the tab opens and
// again when the reload below brings it to what the run left. Same arrangement as
// `AgentChangedFiles.test.ts`, and the reason the tab holds the agent's text through the app's own
// external-sync path rather than by having a value assigned to it.
const readMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/gateways/fs', () => ({
  fsService: {
    read: readMock,
    write: vi.fn(async () => null),
    list: vi.fn(async () => []),
    // `FsPort.watch` resolves to nothing; the pane's subtree only needs the promise.
    watch: vi.fn(async () => undefined),
    deleteFile: vi.fn(async () => ''),
    stat: vi.fn(async () => ({ size: 0, mtime: 0 })),
    listHistory: vi.fn(async () => []),
    readHistory: vi.fn(async () => ''),
    restoreHistory: vi.fn(async () => ''),
    openFolderDialog: vi.fn(async () => null),
    saveFileDialog: vi.fn(async () => null),
    onFsChange: vi.fn(async () => () => {}),
    listTrash: vi.fn(async () => []),
    restoreFromTrash: vi.fn(async () => ''),
    saveAttachment: vi.fn(async () => ''),
    importAttachment: vi.fn(async () => ''),
    resolveMediaPath: vi.fn(async () => ''),
    createDir: vi.fn(async () => ''),
    renameEntry: vi.fn(async () => ''),
  },
}))

import EditorPane from './EditorPane.vue'

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

/** The file as the window sees it, so a read is answered from the same place a write would land. */
const disk = new Map<string, string>([[PATH, BEFORE]])

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let pinia: Pinia
let mounted: VueApp[] = []

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  disk.set(PATH, BEFORE)
  readMock.mockReset()
  readMock.mockImplementation(async (_vault: string, path: string) => {
    const content = disk.get(path)
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return content
  })
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

/** The run's call on this note: an edit that named the path and said what it left there. */
function toolRow(): AgentToolEntry {
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
  }
}

/**
 * The session's own record, which is the one thing every case below has to have in place for the
 * question "was this surface drawn, and about what" to have an answer at all.
 *
 * `edits` is the baselines the send captured; a case that leaves it empty still gets a review —
 * the row comes from the run's call on the timeline — which is what lets the last case below say
 * that a live session was available to draw and the pane drew none of it.
 */
function seedTheRecord(edits: AgentSessionRecord['edits'] = []): void {
  const record: AgentSessionRecord = {
    identity: IDENTITY,
    view: { ...initialAgentSessionView(IDENTITY), timeline: [toolRow()] },
    draft: '',
    scrollTop: 0,
    dropped: 0,
    lastDrop: null,
    edits,
  }
  useAgentSessionStore().records[sessionKey(IDENTITY)] = record
}

/**
 * What the pane has to be able to see for the review to hold the row a run produced: the note open,
 * the baseline the send captured, and the file holding what the agent wrote. The last two are the
 * reason the note is brought to `AFTER` through the app's own external-sync path rather than by
 * assigning a value to the tab.
 */
async function seedTheRun(): Promise<void> {
  const tabs = useTabsStore()
  tabs.setVault(VAULT)
  await tabs.openTab(PATH)
  const held = tabs.lookUpLiveNote(PATH)
  const captured =
    held.kind === 'held' ? captureEditBaselines([held.note], IDENTITY).baselines : []

  disk.set(PATH, AFTER)
  const tab = tabs.tabs.find((candidate) => candidate.path === PATH)
  if (tab !== undefined) await tabs.reloadFromDisk(tab.id)

  seedTheRecord(captured)
}

/**
 * The real pane, mounted the way its neighbouring specs mount it and handed the shell's own props
 * the way `app/AppShell.vue` hands them over. What a caller omits, the component's own defaults
 * answer — which is what the third case below is about.
 */
async function mountPane(props: { agentIdentity?: AgentIdentity | null } = {}): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(EditorPane, props)
  app.use(pinia)
  app.mount(host)
  mounted.push(app)
  await flush()
  return host
}

describe('the editor pane’s agent surfaces', () => {
  it('hosts the change surface, with the row for the note the run changed', async () => {
    await seedTheRun()

    const host = await mountPane({ agentIdentity: IDENTITY })

    // Inside the pane's own root, not merely somewhere in the document: the property is that this
    // pane hosts the surface.
    const surface = host.querySelector('.editor-pane [data-agent-changes]')
    expect(surface).not.toBeNull()
    // A row and not the empty strip: the same element is drawn for a run that changed nothing, so
    // only the path says the review was built from the session this pane was told it serves.
    const row = surface?.querySelector<HTMLElement>(`li[data-path="${PATH}"]`) ?? null
    expect(row).not.toBeNull()
    expect(row?.dataset.attribution).toBe('agent')
    expect(row?.dataset.decision).toBe('none')
    // And the pane around it is the editor's: the surface is drawn beside a note, which is where
    // its answers are answerable.
    expect(host.querySelector('.editor-pane .panes')).not.toBeNull()
  })

  it('draws no change surface while it is serving no session', async () => {
    // The record case 1 draws from is seeded here too, deliberately: with no identity the pane is
    // not being told which session it serves, and a surface that read "the" record out of the
    // store would review a run this pane cannot see.
    await seedTheRun()

    const host = await mountPane({ agentIdentity: null })

    // The editor itself drew, so the absence below is the identity's doing and not a pane that
    // never rendered its `hasTab` branch.
    expect(host.querySelector('.editor-pane .panes')).not.toBeNull()
    expect(host.querySelector('[data-agent-changes]')).toBeNull()
    // And there was something to draw: the record is in the store the surface would have read.
    expect(useAgentSessionStore().recordFor(sessionKey(IDENTITY))).not.toBeNull()
  })

  it('draws none on the pane nobody handed a session to either', async () => {
    // The four neighbouring specs mount exactly this way — `createApp(EditorPane)` with no props —
    // so the pane's own defaults are what answer the question in all of them. `null` above is the
    // shell saying "no runtime"; an omitted prop is nobody having said anything, and the two have
    // to keep landing on the same empty surface rather than on a pane that goes looking for a
    // session of its own (the store read `stores/agent-session.ts` deliberately does not offer).
    await seedTheRun()

    const host = await mountPane()

    expect(host.querySelector('.editor-pane .panes')).not.toBeNull()
    expect(host.querySelector('[data-agent-changes]')).toBeNull()
  })

  it('draws none on the pane with no note in front, live session or not', async () => {
    // The surface's own header says where it belongs: drawn while a session is live *and a note is
    // in front of the user*. That second half is the pane's `hasTab` branch, which is where the
    // element sits — and hoisting it out is a plausible tidy-up, since it is the first child of
    // the only branch that draws. Doing so would put a change list on screen with no note to
    // answer about, and nothing else in this suite would notice.
    seedTheRecord()

    const host = await mountPane({ agentIdentity: IDENTITY })

    expect(host.querySelector('.editor-pane .editor-empty')).not.toBeNull()
    expect(host.querySelector('[data-agent-changes]')).toBeNull()
    // The session was live and had something to say; there was simply no note for it to be about.
    expect(useAgentSessionStore().recordFor(sessionKey(IDENTITY))).not.toBeNull()
  })
})
