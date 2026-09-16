/**
 * The window's half of the live-buffer seam: what it answers, and — the part that matters — that
 * the revision the READ PATH carries and the revision the CONFLICT BASELINE compares are one
 * value.
 *
 * This is the file the two consumers meet in. `fs/read_text_file` is answered from the window
 * (`agent_runtime/live_notes.rs` on the other side), and the edit-conflict protection captures a
 * baseline from `AgentLiveNote.revision`. If those two ever disagreed about what a revision is,
 * both halves would still pass their own tests and the pair would be wrong in the way that costs
 * the user a paragraph: a write that believed it was checked.
 *
 * So every case here drives the REAL tab store through the REAL responder, and the second half of
 * each case feeds the responder's own output into `judgeAgentEdit` — no hand-made note, no
 * hand-made revision. What is asserted is a relationship between two modules, not the shape of
 * either.
 *
 * The three arms of the lookup each get a case, and the third one is the one a rounded answer
 * would get wrong: a tab still on its first read holds a placeholder wearing the note's path, and
 * answering `not-held` for it would serve the FILE for a note the user is looking at.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setRenderedFlush } from '../../../services/editor-ownership'
import { setSourceViewHandle } from '../../../services/source-view'
import { useTabsStore } from '../../../stores/tabs'
import { captureEditBaselines, judgeAgentEdit } from './agent-edit-apply'
import {
  LIVE_NOTE_ANSWER_CHANNEL,
  LIVE_NOTE_ATTACH_CHANNEL,
  LIVE_NOTE_REQUEST_CHANNEL,
  createLiveNoteResponder,
  liveNoteEditorOf,
  type LiveNoteAnswer,
  type LiveNoteQuestion,
  type LiveNoteResponder,
} from './live-note-responder'
import type { AgentLiveNote } from './agent-context-snapshot'
import type { EventPort } from '../../../platform/gateways/contracts'
import type { AgentIdentity } from '../../../platform/gateways/agent-contracts'

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
    saveFileDialog: vi.fn(async (): Promise<string | null> => null),
  },
}))

const VAULT = '/vault'
const NOTE = '/vault/note.md'

function identity(): AgentIdentity {
  return {
    agentId: 'opencode',
    profileId: 'default',
    runtimeEpoch: 'epoch-1',
    vaultId: VAULT,
    sessionId: 'ses_1',
  }
}

/** The window's event surface, as the responder uses it: subscribe, publish, and let a test play
 *  the host by delivering a question. */
function fakeEvents() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const published: Array<{ channel: string; payload: unknown }> = []
  const port: EventPort = {
    async on<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
      const set = listeners.get(event) ?? new Set()
      set.add(cb as (payload: unknown) => void)
      listeners.set(event, set)
      return () => set.delete(cb as (payload: unknown) => void)
    },
    async emit<T>(event: string, payload: T): Promise<void> {
      published.push({ channel: event, payload })
    },
  }
  return {
    port,
    published,
    /** The host asking one question, as `agent_live_note_request` delivers it. */
    ask(question: LiveNoteQuestion): void {
      listeners.get(LIVE_NOTE_REQUEST_CHANNEL)?.forEach((cb) => cb(question))
    },
    /** Whether anything is still subscribed — what `stop()` has to make false. */
    get subscribed(): number {
      return listeners.get(LIVE_NOTE_REQUEST_CHANNEL)?.size ?? 0
    },
  }
}

/** A first read the test decides when to answer, so a tab can be caught mid-load. */
function parkedRead(disk: string) {
  let settle: ((content: string) => void) | null = null
  let first = true
  readMock.mockImplementation(() => {
    if (!first) return Promise.resolve(disk)
    first = false
    return new Promise<string>((resolve) => {
      settle = resolve
    })
  })
  return { land: () => settle?.(disk) }
}

function typeInto(tab: { id: string; content: string }, text: string): void {
  const tabs = useTabsStore()
  tab.content = text
  tabs.markDirty(tab.id)
}

/** The last answer the responder published, as the host would receive it. */
function lastAnswer(events: ReturnType<typeof fakeEvents>): LiveNoteAnswer {
  const answers = events.published.filter((e) => e.channel === LIVE_NOTE_ANSWER_CHANNEL)
  expect(answers.length).toBeGreaterThan(0)
  return answers[answers.length - 1]!.payload as LiveNoteAnswer
}

function answerFor(events: ReturnType<typeof fakeEvents>, vaultId = VAULT): LiveNoteAnswer {
  events.ask({ requestId: 'live-0', vaultId, path: NOTE })
  return lastAnswer(events)
}

function responderFor(events: ReturnType<typeof fakeEvents>, windowId = 'main'): LiveNoteResponder {
  return createLiveNoteResponder({
    source: { lookUpLiveNote: (path) => useTabsStore().lookUpLiveNote(path) },
    events: events.port,
    vaultId: VAULT,
    windowId,
  })
}

/** The note the responder just described, as the editor would hand it to a capture. */
function liveFrom(answer: LiveNoteAnswer): AgentLiveNote {
  if (answer.state !== 'held') throw new Error(`the window did not hold the note: ${answer.state}`)
  return {
    vaultId: answer.vaultId,
    path: answer.path,
    revision: answer.revision,
    // `diskText: null` is the editor's own account of the dirty arm: the file was not read.
    // The wire carries three facts and this is what the fourth one means here.
    buffer: answer.dirty
      ? { state: 'dirty', text: answer.text, diskText: null }
      : { state: 'clean', text: answer.text },
  }
}

describe('the live-note responder', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    readMock.mockReset()
    writeMock.mockReset()
    readMock.mockResolvedValue('the file')
    writeMock.mockResolvedValue(null)
    setSourceViewHandle(null)
    setRenderedFlush(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers held with the buffer the tab holds, not the file', async () => {
    const tabs = useTabsStore()
    tabs.setVault(VAULT)
    await tabs.openTab(NOTE)
    const tab = tabs.tabs[0]!
    typeInto(tab, 'typed but never saved')

    const events = fakeEvents()
    const responder = responderFor(events)
    await responder.start()

    const answer = answerFor(events)
    expect(answer.state).toBe('held')
    if (answer.state !== 'held') return
    expect(answer.text).toBe('typed but never saved')
    expect(answer.text).not.toBe('the file')
    expect(answer.dirty).toBe(true)
    // The window names the vault and the path it was asked about — the host refuses an answer
    // that names anything else, and this is where the two spellings are the same fact.
    expect(answer.vaultId).toBe(VAULT)
    expect(answer.path).toBe(NOTE)
    expect(answer.windowId).toBe('main')
    expect(answer.requestId).toBe('live-0')
    await responder.stop()
  })

  it('serves a clean tab too, because the conflict baseline needs the revision either way', async () => {
    const tabs = useTabsStore()
    tabs.setVault(VAULT)
    await tabs.openTab(NOTE)

    const events = fakeEvents()
    const responder = responderFor(events)
    await responder.start()

    const answer = answerFor(events)
    expect(answer.state).toBe('held')
    if (answer.state !== 'held') return
    expect(answer.dirty).toBe(false)
    expect(answer.text).toBe('the file')
    await responder.stop()
  })

  it('says not-held for a path no tab holds — the one answer the host may serve from the file', async () => {
    const tabs = useTabsStore()
    tabs.setVault(VAULT)
    await tabs.openTab(NOTE)

    const events = fakeEvents()
    const responder = responderFor(events)
    await responder.start()

    events.ask({ requestId: 'live-1', vaultId: VAULT, path: '/vault/other.md' })
    expect(lastAnswer(events).state).toBe('not-held')
    await responder.stop()
  })

  it('says cannot-answer for a tab that is still on its first read, never not-held', async () => {
    // The placeholder holds an empty document wearing the note's path. `not-held` here would
    // serve the file for a note the user is looking at, and `held` would hand the agent an empty
    // document as the note. Neither is this window's to say, so it says so.
    const parked = parkedRead('the file')
    const tabs = useTabsStore()
    tabs.setVault(VAULT)
    const opening = tabs.openTab(NOTE)

    const events = fakeEvents()
    const responder = responderFor(events)
    await responder.start()

    const answer = answerFor(events)
    expect(answer.state).toBe('cannot-answer')
    if (answer.state === 'cannot-answer') {
      expect(answer.reason).toContain(NOTE)
    }

    await parked.land()
    await opening
    await responder.stop()
  })

  it('does not answer a question about a vault this window does not hold', async () => {
    const tabs = useTabsStore()
    tabs.setVault(VAULT)
    await tabs.openTab(NOTE)

    const events = fakeEvents()
    const responder = responderFor(events)
    await responder.start()
    const before = events.published.length

    events.ask({ requestId: 'live-2', vaultId: '/somewhere-else', path: NOTE })
    expect(events.published.length).toBe(before)
    await responder.stop()
  })

  it('registers when it starts, and releases both the registration and the listener when it stops', async () => {
    const events = fakeEvents()
    const responder = responderFor(events)

    await responder.start()
    const attach = events.published.at(-1)!
    expect(attach.channel).toBe(LIVE_NOTE_ATTACH_CHANNEL)
    expect(attach.payload).toEqual({ vaultId: VAULT, windowId: 'main', attached: true })

    // A second start is a no-op: two registrations for one window would make the host wait for an
    // answer it is already holding.
    await responder.start()
    expect(events.published.filter((e) => e.channel === LIVE_NOTE_ATTACH_CHANNEL)).toHaveLength(1)

    await responder.stop()
    const detach = events.published.at(-1)!
    expect(detach.channel).toBe(LIVE_NOTE_ATTACH_CHANNEL)
    expect(detach.payload).toEqual({ vaultId: VAULT, windowId: 'main', attached: false })
    expect(events.subscribed).toBe(0)
  })
})

describe('the one lookup, read by both consumers', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    readMock.mockReset()
    writeMock.mockReset()
    readMock.mockResolvedValue('the file')
    writeMock.mockResolvedValue(null)
    setSourceViewHandle(null)
    setRenderedFlush(null)
  })

  it('a keystroke moves the revision the read carries, and the baseline notices', async () => {
    const tabs = useTabsStore()
    tabs.setVault(VAULT)
    await tabs.openTab(NOTE)
    const tab = tabs.tabs[0]!

    const events = fakeEvents()
    const responder = responderFor(events)
    await responder.start()

    // The request is submitted: the baseline is captured from the RESPONDER'S OWN ANSWER, which
    // is the version the read path would carry to the engine.
    const atSend = liveFrom(answerFor(events))
    const captured = captureEditBaselines([atSend], identity())
    expect(captured.refused).toHaveLength(0)
    const baseline = captured.baselines[0]!

    // The user keeps typing in the same note while the model thinks.
    typeInto(tab, 'typed while the model was thinking')

    const now = liveFrom(answerFor(events))
    const judgement = judgeAgentEdit(
      { baseline, text: 'the agent’s answer' },
      now,
      identity(),
    )
    // A conflict, which is what refuses the write and asks the user. The revision moving is half
    // of that; the text moving is the other half, and both come from the same lookup.
    expect(judgement.status).toBe('conflict')
    if (judgement.status === 'conflict') {
      expect(judgement.currentRevision).not.toBe(judgement.baselineRevision)
      expect(judgement.noteText).toBe('typed while the model was thinking')
    }
    await responder.stop()
  })

  it('a note closed and reopened at the same path is a different document, even with identical text', async () => {
    const tabs = useTabsStore()
    tabs.setVault(VAULT)
    await tabs.openTab(NOTE)
    const tab = tabs.tabs[0]!

    const events = fakeEvents()
    const responder = responderFor(events)
    await responder.start()
    const atSend = liveFrom(answerFor(events))
    const baseline = captureEditBaselines([atSend], identity()).baselines[0]!
    expect(baseline.text).toBe('the file')

    // Closed, then reopened: the same path, the same bytes back from the file, and a different
    // document instance. A revision that were a digest of the text would compare equal here and
    // let a write land in a document the user had just opened.
    tabs.removeTab(tab.id)
    await tabs.openTab(NOTE)
    expect(tabs.tabs[0]!.content).toBe('the file')

    const now = liveFrom(answerFor(events))
    expect(now.buffer.text).toBe(baseline.text)
    expect(now.revision).not.toBe(baseline.revision)
    const judgement = judgeAgentEdit({ baseline, text: 'the agent’s answer' }, now, identity())
    expect(judgement.status).toBe('conflict')
    await responder.stop()
  })

  it('a page reload is a new editor: the same tab id is a different document', async () => {
    // The defect this catches is invisible from inside one page, and it is the one that would
    // corrupt attribution silently. `tab.id` is `tab-${++seq}` from a counter the lifecycle module
    // owns, so a webview reload restarts the counter while the host process — and its runtime
    // epoch — survive. Without a per-page-load term in the revision, a baseline taken before a
    // reload compares EQUAL against a different document after it, and `judgeAgentEdit`'s
    // identity check cannot catch that: the epoch did not move and the path is the same.
    //
    // So the reload is real here rather than simulated: `vi.resetModules()` rebuilds the module
    // graph, which is what reloading the webview does, and the second graph mints the same tab id
    // again because it starts counting from one. Same text, same id, same path — and the revisions
    // must differ.
    const first = await import('../../../stores/tabs')
    const a = first.useTabsStore()
    a.setVault(VAULT)
    await a.openTab(NOTE)
    const before = a.lookUpLiveNote(NOTE)
    expect(before.kind).toBe('held')

    vi.resetModules()
    const reloaded = await import('pinia')
    reloaded.setActivePinia(reloaded.createPinia())
    const second = await import('../../../stores/tabs')
    const b = second.useTabsStore()
    b.setVault(VAULT)
    await b.openTab(NOTE)
    const after = b.lookUpLiveNote(NOTE)
    expect(after.kind).toBe('held')

    // The premise, asserted rather than assumed: the counter really did restart.
    expect(b.tabs[0]!.id).toBe(a.tabs[0]!.id)
    if (before.kind !== 'held' || after.kind !== 'held') return
    expect(after.note.buffer.text).toBe(before.note.buffer.text)
    expect(after.note.revision).not.toBe(before.note.revision)
  })

  it('gives the insertion service the same note the responder answers with', async () => {
    const tabs = useTabsStore()
    tabs.setVault(VAULT)
    await tabs.openTab(NOTE)
    const tab = tabs.tabs[0]!
    typeInto(tab, 'typed but never saved')

    const events = fakeEvents()
    const responder = responderFor(events)
    await responder.start()
    const answered = liveFrom(answerFor(events))

    // `liveNoteEditorOf` is the other projection of the one lookup, and the two must describe one
    // document: a second lookup would be a second answer to "what does this note hold".
    const editor = liveNoteEditorOf({ lookUpLiveNote: (path) => useTabsStore().lookUpLiveNote(path) })
    const viaEditor = editor.liveNote(NOTE)
    expect(viaEditor).not.toBeNull()
    // Field by field rather than by deep equality: the wire carries three facts and the
    // editor's own value carries a fourth (`diskText`, which the answer has no field for), so
    // what has to be equal is the document the two describe — and that is these.
    expect(viaEditor!.vaultId).toBe(answered.vaultId)
    expect(viaEditor!.path).toBe(answered.path)
    expect(viaEditor!.revision).toBe(answered.revision)
    expect(viaEditor!.buffer.text).toBe(answered.buffer.text)
    expect(viaEditor!.buffer.state).toBe(answered.buffer.state)
    // And a tab that cannot answer is `null` here, which the insertion service refuses on: a
    // refusal costs an insert, while an insert into a placeholder would cost the note.
    expect(editor.liveNote('/vault/not-open.md')).toBeNull()
    await responder.stop()
  })
})

describe('the channels', () => {
  it('are the three the host publishes on and listens for', () => {
    // The strings are half of a wire whose other half is `state/live_note_windows.rs`; the Rust
    // side asserts against these exact literals, because nothing else can catch a drift here —
    // a mismatch is a wire that silently never connects.
    expect(LIVE_NOTE_REQUEST_CHANNEL).toBe('agent-live-note-request')
    expect(LIVE_NOTE_ANSWER_CHANNEL).toBe('agent-live-note-answer')
    expect(LIVE_NOTE_ATTACH_CHANNEL).toBe('agent-live-note-attach')
  })
})
