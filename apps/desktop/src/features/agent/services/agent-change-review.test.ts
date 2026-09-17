/**
 * The change review's tests, one describe per acceptance clause.
 *
 * §10.2's three clauses each name a failure, so each test below is written against the moment that
 * failure would happen rather than against the shape of the code:
 *
 *  - **脏缓冲不丢失** — the editor's own account is a live object the user is typing into. The
 *    tests drive a real one, edit it, and check that a row built before the edit still says what it
 *    decided on: a row that resolved the buffer afterwards would be showing the view one text and
 *    the user another.
 *  - **外部变化不误归因** — every attribution is asserted *with its control*, because an
 *    attribution test that cannot show the difference passes on a module that answers `external`
 *    to everything. `a write call of this session is an agent change` is the control for the
 *    watcher and `files-changed` cases: same file, same observation, one changed fact.
 *  - **恢复拒绝新冲突** — recovery is withheld in three different situations, each a different
 *    thing for the user to do, and the refusal leaves the offers that are still safe.
 *
 * Events are built through `readAgentEvent`, so what the service is handed is a frame that passed
 * the same validator the adapters put their frames through — not a literal this file made up.
 */

import { describe, expect, it } from 'vitest'
import {
  AgentFailure,
  readAgentEvent,
  type AgentEvent,
  type AgentEventKind,
  type AgentIdentity,
  type AgentPayloads,
  type AgentToolContent,
  type AgentToolStatus,
} from '../../../platform/gateways/agent-contracts'
import type { AgentLiveNote, AgentLiveNoteBuffer } from './agent-context-snapshot'
import { captureEditBaselines, type AgentEditBaseline } from './agent-edit-apply'
import type { AgentToolEntry } from './agent-timeline'
import {
  applyChangeEvent,
  changeRows,
  createChangeReview,
  decideChange,
  observeDiskChange,
  reviewOfSession,
  type AgentChangeReview,
  type AgentChangeRow,
} from './agent-change-review'

const VAULT = '/home/user/vault'

function identity(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    agentId: 'opencode',
    profileId: 'default',
    runtimeEpoch: 'epoch-1',
    vaultId: VAULT,
    sessionId: 'session-1',
    ...overrides,
  }
}

/** One validated event, as the service receives it. */
function event<K extends AgentEventKind>(
  kind: K,
  payload: AgentPayloads[K],
  identityOverride: Partial<AgentIdentity> = {},
): AgentEvent {
  const read = readAgentEvent({
    ...identity(identityOverride),
    runId: 'run-1',
    sequence: 1,
    kind,
    payload,
  })
  if (read instanceof AgentFailure) throw read
  return read
}

/** One `diff` block, in the shape the pinned engine sends (`docs/audits/2026-09-16-opencode-acp-p0.md`
 *  §6.1): the path, the text the engine started from, and the text it leaves. */
function diff(path: string, oldText: string, newText: string): AgentToolContent {
  return { type: 'diff', path, oldText, newText }
}

/** A write-kind tool call naming `paths`. */
function write(
  toolCallId: string,
  paths: string[],
  options: {
    tool?: AgentPayloads['tool-update']['kind']
    status?: AgentToolStatus
    content?: AgentToolContent[]
  } = {},
): AgentEvent {
  return event('tool-update', {
    toolCallId,
    title: `Editing ${paths.join(', ')}`,
    kind: options.tool ?? 'edit',
    status: options.status ?? 'completed',
    paths,
    content: options.content ?? [],
    input: { state: 'text', json: '{}' },
    output: { state: 'absent' },
  })
}

/** The baseline a `send` would have captured for one note, read through the same function the
 *  store reads it through rather than spelled by hand. */
function baselineFor(path: string, text: string): AgentEditBaseline {
  const note: AgentLiveNote = {
    vaultId: VAULT,
    path,
    revision: 'page-1:tab-1:0',
    buffer: { state: 'clean', text },
  }
  const captured = captureEditBaselines([note], identity())
  const [held] = captured.baselines
  if (held === undefined) throw new Error(`no baseline captured for ${path}`)
  return held
}

/** A review that holds the recovery material a request would have left: the text the note held
 *  when the prompt went out. */
function withBaselines(
  review: AgentChangeReview,
  ...baselines: readonly AgentEditBaseline[]
): AgentChangeReview {
  return { ...review, baselines: Object.freeze([...baselines]) }
}

/** One `tool` row of the timeline, built the way the reducer builds it. */
function toolRow(
  toolCallId: string,
  paths: string[],
  options: { tool?: AgentToolEntry['toolKind']; status?: AgentToolStatus; content?: AgentToolContent[] } = {},
): AgentToolEntry {
  return {
    kind: 'tool',
    id: 1,
    runId: 'run-1',
    toolCallId,
    title: `Editing ${paths.join(', ')}`,
    toolKind: options.tool ?? 'edit',
    status: options.status ?? 'completed',
    paths: [...paths],
    content: [...(options.content ?? [])],
    input: { state: 'absent' },
    output: { state: 'absent' },
  }
}

/**
 * The editor, as the review meets it: notes with a buffer the user types into.
 *
 * It is deliberately narrower than the real editor and deliberately live — `type` changes what the
 * next lookup answers, which is what lets a test show that a row already built does not move with
 * it.
 */
function editor() {
  const notes = new Map<string, { revision: string; buffer: AgentLiveNoteBuffer }>()
  const read = (path: string): AgentLiveNote | null => {
    const held = notes.get(path)
    if (held === undefined) return null
    return { vaultId: VAULT, path, revision: held.revision, buffer: held.buffer }
  }
  return {
    read,
    /** A tab with unsaved edits: the file holds `diskText`, the buffer holds more. */
    openDirty(path: string, text: string, diskText: string | null): void {
      notes.set(path, { revision: 'r1', buffer: { state: 'dirty', text, diskText } })
    },
    openClean(path: string, text: string): void {
      notes.set(path, { revision: 'r1', buffer: { state: 'clean', text } })
    },
    /** The user types. The next lookup sees it; a row already built must not. */
    type(path: string, text: string): void {
      const held = notes.get(path)
      if (held === undefined) throw new Error(`${path} is not open`)
      held.buffer = {
        state: 'dirty',
        text,
        diskText: held.buffer.state === 'dirty' ? held.buffer.diskText : held.buffer.text,
      }
    },
    text(path: string): string | null {
      const held = notes.get(path)
      return held === undefined ? null : held.buffer.text
    },
  }
}

function reviewWith(...events: readonly AgentEvent[]): AgentChangeReview {
  return events.reduce(applyChangeEvent, createChangeReview(identity()))
}

function rowFor(rows: readonly AgentChangeRow[], path: string): AgentChangeRow {
  const row = rows.find((candidate) => candidate.path === path)
  if (row === undefined) throw new Error(`no row for ${path}`)
  return row
}

describe('attribution: which change is the agent’s', () => {
  it('a write-kind call of this session names the file, and that is the agent’s change', () => {
    // The control for everything below: the module must be *able* to say `agent`, or the external
    // assertions would hold on a module that never attributes anything.
    const rows = changeRows(reviewWith(write('call-1', ['notes/a.md'])), () => null)

    expect(rows).toHaveLength(1)
    expect(rows[0].path).toBe('notes/a.md')
    expect(rows[0].attribution).toBe('agent')
    expect(rows[0].toolCallId).toBe('call-1')
  })

  it('a disk change nothing in the session claims is external, not the agent’s', () => {
    // The clause's own case: the file changed while the host was not looking, and no call of this
    // session names it — a sync client, a git checkout, the user in another editor.
    const review = observeDiskChange(reviewWith(write('call-1', ['notes/a.md'])), 'notes/b.md')

    expect(rowFor(changeRows(review, () => null), 'notes/b.md').attribution).toBe('external')
    // …and the file the call did name is untouched by that: one observation, one path.
    expect(rowFor(changeRows(review, () => null), 'notes/a.md').attribution).toBe('agent')
  })

  it('the engine merely naming a path does not make it the agent’s change', () => {
    // `files-changed` is a hint in the contract's own words — not a diff, and not proof. A review
    // that promoted it would tell the user the agent changed a file the agent only mentioned.
    const review = reviewWith(event('files-changed', { paths: ['notes/b.md'] }))

    expect(rowFor(changeRows(review, () => null), 'notes/b.md').attribution).toBe('reported')
  })

  it('the watcher and the engine together are still not an attribution', () => {
    // The plausible-looking promotion: the watcher saw the file change *and* the engine said it
    // touched it, which is the shape a shell command that wrote a file arrives in. Neither is a
    // tool association, so the row says what is true — the engine reported it — instead of naming
    // the agent, or instead of blaming the user's other programs for it.
    const review = observeDiskChange(
      reviewWith(event('files-changed', { paths: ['notes/b.md'] })),
      'notes/b.md',
    )

    const row = rowFor(changeRows(review, () => null), 'notes/b.md')
    expect(row.attribution).toBe('reported')
    expect(row.attribution).not.toBe('external')
  })

  it('a read call never makes its file a change at all', () => {
    // P0 §6.1's measured frame: a read tool that reports the path it read. Storing it would leave
    // "the agent changed this" one comparison away from a note the agent only opened.
    const review = reviewWith(write('call-1', ['notes/a.md'], { tool: 'read' }))

    expect(changeRows(review, () => null)).toEqual([])
  })

  it('an event from another session, epoch or vault never enters this review', () => {
    // §6.2's composite identity: the wrong-session attribution the plan names first. Each field is
    // checked on its own, because each answers a different way the frame could be wrong.
    const base = createChangeReview(identity())
    const foreign = [
      event('tool-update', toolPayload('call-1', ['a.md']), { sessionId: 'session-2' }),
      event('tool-update', toolPayload('call-2', ['b.md']), { runtimeEpoch: 'epoch-2' }),
      event('tool-update', toolPayload('call-3', ['c.md']), { vaultId: '/home/user/other' }),
      event('tool-update', toolPayload('call-4', ['d.md']), { agentId: 'other-agent' }),
    ]

    for (const frame of foreign) {
      expect(applyChangeEvent(base, frame)).toBe(base)
    }
    expect(changeRows(base, () => null)).toEqual([])
  })

  it('a second update to one call replaces it instead of adding a second row', () => {
    // The wire sends `tool_call` and then any number of `tool_call_update` frames for one id.
    const review = reviewWith(
      write('call-1', ['notes/a.md'], { status: 'in_progress' }),
      write('call-1', ['notes/a.md'], { status: 'completed' }),
    )

    const rows = changeRows(review, () => null)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('completed')
  })

  it('a call that reported failure is still the agent’s change, and the row says so', () => {
    // The host cannot rule out that a failed call wrote before it failed. Dropping the row would
    // hand the file to `external` — blaming another program for the agent's own write — so the
    // status travels instead.
    const review = reviewWith(write('call-1', ['notes/a.md'], { status: 'failed' }))
    const row = rowFor(changeRows(review, () => null), 'notes/a.md')

    expect(row.attribution).toBe('agent')
    expect(row.status).toBe('failed')
  })

  it('a permission request is a proposal, and this list is about files that changed', () => {
    // §7.2 keeps the two apart: an unwritten proposal is apply/discard, a written change is
    // view/recover/merge. A request in this list would read as a change that has not happened.
    const review = reviewWith(
      event('permission-request', {
        requestId: 'req-1',
        toolCallId: 'call-1',
        title: 'notes/a.md',
        input: { state: 'text', json: '{"filepath":"notes/a.md"}' },
        content: [],
        options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
      }),
    )

    expect(changeRows(review, () => null)).toEqual([])
  })

  it('the last call to name a path is the one the row shows', () => {
    const review = reviewWith(
      write('call-1', ['notes/a.md'], { tool: 'edit' }),
      write('call-2', ['notes/a.md'], { tool: 'delete' }),
    )

    const row = rowFor(changeRows(review, () => null), 'notes/a.md')
    expect(row.toolCallId).toBe('call-2')
    expect(row.tool).toBe('delete')
  })
})

describe('the buffer: what this window holds for the changed file', () => {
  it('keeps both texts when the buffer has unsaved edits, and neither is replaced', () => {
    const files = editor()
    files.openDirty('notes/a.md', 'first line\nmy unsaved second line', 'first line')
    const review = reviewWith(write('call-1', ['notes/a.md']))

    const rows = changeRows(review, files.read)
    const row = rowFor(rows, 'notes/a.md')

    expect(row.verdict.kind).toBe('unsaved-edits')
    if (row.verdict.kind !== 'unsaved-edits') throw new Error('unreachable')
    // Both texts are named, so the user can see that nothing here decided between them.
    expect(row.verdict.bufferText).toBe('first line\nmy unsaved second line')
    expect(row.verdict.diskText).toBe('first line')
    // And the editor still holds exactly what the user typed.
    expect(files.text('notes/a.md')).toBe('first line\nmy unsaved second line')
  })

  it('a row built before a keystroke still says what it decided on', () => {
    // The failure this pins is the one the buffer cannot come back from: a row that resolves the
    // live buffer when it is *rendered* shows the user text that was not the text it judged — and
    // the text it judged is what the offer was decided against.
    const files = editor()
    files.openDirty('notes/a.md', 'one', 'zero')
    const review = reviewWith(write('call-1', ['notes/a.md']))

    const before = rowFor(changeRows(review, files.read), 'notes/a.md')
    files.type('notes/a.md', 'one and the end of the statement')

    if (before.verdict.kind !== 'unsaved-edits') throw new Error('unreachable')
    expect(before.verdict.bufferText).toBe('one')
    // The next read is the user's newer text: the row is a value, not a view onto the tab.
    const after = rowFor(changeRows(review, files.read), 'notes/a.md')
    if (after.verdict.kind !== 'unsaved-edits') throw new Error('unreachable')
    expect(after.verdict.bufferText).toBe('one and the end of the statement')
  })

  it('a buffer that never read the file says so rather than showing an empty file', () => {
    // `diskText: null` is "not read". Rendered as "" it would show the user an empty file where the
    // agent had in fact changed one — a merge view built on that loses the agent's text silently.
    const files = editor()
    files.openDirty('notes/a.md', 'unsaved', null)

    const row = rowFor(changeRows(reviewWith(write('call-1', ['notes/a.md'])), files.read), 'notes/a.md')
    if (row.verdict.kind !== 'unsaved-edits') throw new Error('unreachable')
    expect(row.verdict.diskText).toBeNull()
  })

  it('a clean buffer follows the disk, the way every other external write does', () => {
    const files = editor()
    files.openClean('notes/a.md', 'the text as it was')

    const row = rowFor(changeRows(reviewWith(write('call-1', ['notes/a.md'])), files.read), 'notes/a.md')
    expect(row.verdict.kind).toBe('follows-disk')
  })

  it('a file no tab holds is a record, not a conflict', () => {
    const row = rowFor(changeRows(reviewWith(write('call-1', ['notes/a.md'])), () => null), 'notes/a.md')
    expect(row.verdict.kind).toBe('record')
  })
})

describe('the session’s own record: where a review comes from in the app', () => {
  it('the rows come from the timeline and the engine’s list, not from a second stream', () => {
    // The producer the app has: the session's own record, which is what the transcript draws. A
    // review folded from a listener would be empty for a surface that mounted after the run, and
    // would be free to disagree with the transcript the user just read.
    const review = reviewOfSession(
      identity(),
      { timeline: [toolRow('call-1', ['notes/a.md'])], changedFiles: ['notes/b.md'] },
      [],
    )
    const rows = changeRows(review, () => null)

    expect(rows.map((row) => row.path)).toEqual(['notes/a.md', 'notes/b.md'])
    expect(rowFor(rows, 'notes/a.md').attribution).toBe('agent')
    expect(rowFor(rows, 'notes/b.md').attribution).toBe('reported')
  })

  it('a call’s own diff block is the text the row checks the note against', () => {
    const review = reviewOfSession(
      identity(),
      {
        timeline: [toolRow('call-1', ['notes/a.md'], { content: [diff('notes/a.md', 'before', 'after')] })],
        changedFiles: [],
      },
      [baselineFor('notes/a.md', 'before')],
    )
    const row = rowFor(changeRows(review, () => null), 'notes/a.md')

    expect(row.result).toBe('after')
    expect(row.baseline).toBe('before')
  })

  it('a call that stated no text leaves the row with nothing to check against', () => {
    // Not the same fact as "the file is empty": the engine named a path and said nothing about
    // what it did to it. §7.2's 「没有基线时标记不可直接恢复」 is the same rule one step along.
    const review = reviewOfSession(
      identity(),
      { timeline: [toolRow('call-1', ['notes/a.md'])], changedFiles: [] },
      [baselineFor('notes/a.md', 'before')],
    )
    const row = rowFor(changeRows(review, () => null), 'notes/a.md')

    expect(row.result).toBeNull()
  })

  it('a write the timeline shows twice keeps one row, as the transcript does', () => {
    const review = reviewOfSession(
      identity(),
      {
        timeline: [
          toolRow('call-1', ['notes/a.md'], { status: 'in_progress' }),
          toolRow('call-1', ['notes/a.md'], { status: 'completed' }),
        ],
        changedFiles: [],
      },
      [],
    )

    const rows = changeRows(review, () => null)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('completed')
  })

  it('a read row never becomes a change, and a call naming no path is not one either', () => {
    const review = reviewOfSession(
      identity(),
      {
        timeline: [toolRow('call-1', ['notes/a.md'], { tool: 'read' }), toolRow('call-2', [])],
        changedFiles: [],
      },
      [],
    )

    expect(changeRows(review, () => null)).toEqual([])
  })

  it('an event from another session never enters a review built from the record', () => {
    // The record is the session's own, so this is the belt to that braces — and it is the same
    // comparison the event fold makes, which is why the two producers cannot disagree.
    const review = reviewOfSession(
      identity(),
      { timeline: [toolRow('call-1', ['notes/a.md'])], changedFiles: ['notes/b.md'] },
      [baselineFor('notes/a.md', 'before'), baselineFor('notes/b.md', 'before')],
    )
    const rows = changeRows(review, () => null)

    for (const row of rows) {
      expect(row.attribution).not.toBe('external')
    }
  })
})

describe('recovery: what is offered, and what is refused', () => {
  it('a settled change to an open, clean note that still holds what the call left offers recovery', () => {
    // The control for every refusal below: the module must be *able* to offer the write, or the
    // refusals would hold on a module that never offers anything.
    const files = editor()
    files.openClean('notes/a.md', 'after')
    const review = withBaselines(
      reviewWith(write('call-1', ['notes/a.md'], { content: [diff('notes/a.md', 'before', 'after')] })),
      baselineFor('notes/a.md', 'before'),
    )
    const row = rowFor(changeRows(review, files.read), 'notes/a.md')

    expect(row.offers).toEqual(['view', 'recover'])
    expect(row.refused).toBeNull()
  })

  it('a path no request named has no baseline to put back', () => {
    // §7.2: 「没有基线时标记不可直接恢复，不伪造「撤销成功」」. The row is still the agent's — the
    // call named it — and what is missing is the version to restore, which nothing else holds.
    const files = editor()
    files.openClean('notes/a.md', 'after')
    const review = reviewWith(write('call-1', ['notes/a.md'], { content: [diff('notes/a.md', 'before', 'after')] }))
    const row = rowFor(changeRows(review, files.read), 'notes/a.md')

    expect(row.offers).toEqual(['view'])
    expect(row.refused).toEqual({ reason: 'no-baseline', path: 'notes/a.md' })
  })

  it('a call that stated no text is refused rather than written over', () => {
    // The app cannot tell an agent's text from the user's own later edit without the text the
    // call left, and overwriting on a guess is the silent loss §7.2 rules out.
    const files = editor()
    files.openClean('notes/a.md', 'after')
    const review = withBaselines(reviewWith(write('call-1', ['notes/a.md'])), baselineFor('notes/a.md', 'before'))
    const row = rowFor(changeRows(review, files.read), 'notes/a.md')

    expect(row.offers).toEqual(['view'])
    expect(row.refused).toEqual({ reason: 'result-unstated', path: 'notes/a.md' })
  })

  it('a write still in flight is not recoverable', () => {
    // Recovering now would race a writer that is still going: the user would be shown a restored
    // file and the engine would put its version back over it. Refused here rather than at the host
    // because the call's status is what the review can see and the host cannot.
    const review = reviewWith(write('call-1', ['notes/a.md'], { status: 'in_progress' }))
    const row = rowFor(changeRows(review, () => null), 'notes/a.md')

    expect(row.offers).toEqual(['view'])
    expect(row.refused).toEqual({ reason: 'write-in-flight', toolCallId: 'call-1' })
  })

  it('an unsaved buffer withholds recovery: the user’s own text is not written over', () => {
    // §7.2: 脏缓冲遇到磁盘变化进入冲突状态，禁止自动覆盖任一侧. The note's own conflict flow is
    // where the two texts are settled — this row shows both of them and writes neither.
    const files = editor()
    files.openDirty('notes/a.md', 'mine', 'theirs')
    const review = withBaselines(
      reviewWith(write('call-1', ['notes/a.md'], { content: [diff('notes/a.md', 'before', 'after')] })),
      baselineFor('notes/a.md', 'before'),
    )
    const row = rowFor(changeRows(review, files.read), 'notes/a.md')

    expect(row.offers).toEqual(['view'])
    expect(row.refused).toEqual({ reason: 'unsaved-edits', path: 'notes/a.md' })
    // Both texts are still on the row: the buffer's, and the one the call said it left.
    expect(row.result).toBe('after')
  })

  it('a note no tab holds is offered through the host, which is the writer that needs none', () => {
    // The dead end this route removed: `agent-note-write.ts` puts text into a note through the
    // tab's own save transaction — the precondition, the vault and the content watcher — so a path
    // with no tab could only be refused, and the notes a reader is least likely to have open are
    // exactly the ones an agent went and changed. The host performed the write, holds the bytes it
    // replaced, and needs no buffer at all — so the row offers the rejection and names the writer.
    //
    // It is offered *without* a window baseline, deliberately: a note no tab holds is precisely a
    // note whose baseline this window never captured, and asking about that first is what made
    // every closed note answer「no request named this file」. The host judges its own record.
    const review = reviewWith(
      write('call-1', ['notes/a.md'], { content: [diff('notes/a.md', 'before', 'after')] }),
    )
    const row = rowFor(changeRows(review, () => null), 'notes/a.md')

    expect(row.verdict.kind).toBe('record')
    expect(row.baseline).toBeNull()
    expect(row.offers).toEqual(['view', 'recover'])
    expect(row.recoverVia).toBe('host')
    expect(row.refused).toBeNull()
  })

  it('a note a tab holds is put back through the note’s own save, not the host', () => {
    // The other route, and the difference is the file rather than a preference: while a tab holds
    // the note the buffer, the vault check and the precondition all apply, and the pane that owns
    // the text is asked before anything is written — none of which the host's own write can see.
    const files = editor()
    files.openClean('notes/a.md', 'after')
    const review = withBaselines(
      reviewWith(write('call-1', ['notes/a.md'], { content: [diff('notes/a.md', 'before', 'after')] })),
      baselineFor('notes/a.md', 'before'),
    )
    const row = rowFor(changeRows(review, files.read), 'notes/a.md')

    expect(row.verdict.kind).toBe('follows-disk')
    expect(row.offers).toEqual(['view', 'recover'])
    expect(row.recoverVia).toBe('editor')
  })

  it('a note that is no longer what the call left is refused rather than overwritten', () => {
    // §7.2's 「恢复前检查当前内容是否仍等于已记录结果」: the user (or another program) moved the
    // note after the agent wrote it, and putting the baseline back would take that edit away.
    const files = editor()
    files.openClean('notes/a.md', 'the agent’s text, and then my own edit')
    const review = withBaselines(
      reviewWith(write('call-1', ['notes/a.md'], { content: [diff('notes/a.md', 'before', 'after')] })),
      baselineFor('notes/a.md', 'before'),
    )
    const row = rowFor(changeRows(review, files.read), 'notes/a.md')

    expect(row.offers).toEqual(['view'])
    expect(row.refused).toEqual({ reason: 'changed-since', path: 'notes/a.md' })
  })

  it('a note in another vault than the session’s is refused, however the path reads', () => {
    // §6.2's vault is one of the five identity fields, and a path is only a path inside one vault:
    // writing this session's baseline into a same-named note of another vault is the cross-root
    // mistake the identity exists to catch.
    const other = (): AgentLiveNote | null => ({
      vaultId: '/home/user/other-vault',
      path: 'notes/a.md',
      revision: 'r1',
      buffer: { state: 'clean', text: 'after' },
    })
    const review = withBaselines(
      reviewWith(write('call-1', ['notes/a.md'], { content: [diff('notes/a.md', 'before', 'after')] })),
      baselineFor('notes/a.md', 'before'),
    )
    const row = rowFor(changeRows(review, other), 'notes/a.md')

    expect(row.offers).toEqual(['view'])
    expect(row.refused).toEqual({
      reason: 'vault-mismatch',
      path: 'notes/a.md',
      noteVaultId: '/home/user/other-vault',
      sessionVaultId: VAULT,
    })
  })

  it('a change nothing claims has no recovery to offer', () => {
    // §7.2: without a baseline the change is marked not directly recoverable, and a button whose
    // press would report an undo that never happened is the fabricated success it forbids.
    const review = observeDiskChange(
      reviewWith(event('files-changed', { paths: ['notes/b.md'] })),
      'notes/c.md',
    )
    const rows = changeRows(review, () => null)

    expect(rowFor(rows, 'notes/b.md').refused).toEqual({
      reason: 'not-agent-change',
      attribution: 'reported',
    })
    expect(rowFor(rows, 'notes/c.md').refused).toEqual({
      reason: 'not-agent-change',
      attribution: 'external',
    })
  })

  it('the refusal is per row: one file’s conflict does not withhold another’s recovery', () => {
    const files = editor()
    files.openDirty('notes/a.md', 'mine', 'theirs')
    files.openClean('notes/b.md', 'after')
    const review = withBaselines(
      reviewWith(
        write('call-1', ['notes/a.md'], { content: [diff('notes/a.md', 'before', 'after')] }),
        write('call-2', ['notes/b.md'], { content: [diff('notes/b.md', 'before', 'after')] }),
      ),
      baselineFor('notes/a.md', 'before'),
      baselineFor('notes/b.md', 'before'),
    )

    const rows = changeRows(review, files.read)
    expect(rowFor(rows, 'notes/a.md').offers).toEqual(['view'])
    expect(rowFor(rows, 'notes/b.md').offers).toEqual(['view', 'recover'])
  })

  it('every row can be looked at, whatever was refused', () => {
    // The one offer that survives every refusal: a row the user cannot open is a change they
    // cannot see, and §5.3 puts the review in the editor's workspace for exactly that reason.
    const files = editor()
    files.openDirty('notes/a.md', 'mine', 'theirs')
    const review = observeDiskChange(
      reviewWith(
        write('call-1', ['notes/a.md']),
        write('call-2', ['notes/b.md'], { status: 'pending' }),
        event('files-changed', { paths: ['notes/c.md'] }),
      ),
      'notes/d.md',
    )

    for (const row of changeRows(review, files.read)) {
      expect(row.offers).toContain('view')
    }
  })
})

describe('the answers a change can be given', () => {
  /** The reachable row: a settled change of this session, an open clean note holding exactly what
   *  the call said it left, and the baseline the request captured. */
  function recoverable(): { files: ReturnType<typeof editor>; review: AgentChangeReview } {
    const files = editor()
    files.openClean('notes/a.md', 'after')
    const review = withBaselines(
      reviewWith(write('call-1', ['notes/a.md'], { content: [diff('notes/a.md', 'before', 'after')] })),
      baselineFor('notes/a.md', 'before'),
    )
    return { files, review }
  }

  it('a kept change stays on the list and stops offering the write', () => {
    // Keeping is the decision that the agent's version is the note's own text. Nothing is written —
    // there is nothing to write — and what changes is what the window will still do about the row.
    const { files, review } = recoverable()
    const before = rowFor(changeRows(review, files.read), 'notes/a.md')
    expect(before.offers).toEqual(['view', 'recover'])

    const kept = decideChange(review, {
      path: 'notes/a.md',
      toolCallId: 'call-1',
      decision: 'kept',
      rejection: null,
    })
    const row = rowFor(changeRows(kept, files.read), 'notes/a.md')

    expect(row.decision?.decision).toBe('kept')
    expect(row.offers).toEqual(['view'])
    // A kept note is not a refused one: nothing is wrong with it, so there is nothing to explain.
    expect(row.refused).toBeNull()
    expect(files.text('notes/a.md')).toBe('after')
  })

  it('a rejected change carries what the write did', () => {
    const { files, review } = recoverable()
    const rejected = decideChange(review, {
      path: 'notes/a.md',
      toolCallId: 'call-1',
      decision: 'rejected',
      rejection: { via: 'editor', written: { status: 'saved' } },
    })
    const row = rowFor(changeRows(rejected, files.read), 'notes/a.md')

    expect(row.decision).toEqual({
      path: 'notes/a.md',
      toolCallId: 'call-1',
      decision: 'rejected',
      rejection: { via: 'editor', written: { status: 'saved' } },
    })
    expect(row.offers).toEqual(['view'])
  })

  it('a second answer replaces the first', () => {
    const { files, review } = recoverable()
    const once = decideChange(review, {
      path: 'notes/a.md',
      toolCallId: 'call-1',
      decision: 'rejected',
      rejection: { via: 'editor', written: { status: 'save-failed' } },
    })
    const twice = decideChange(once, {
      path: 'notes/a.md',
      toolCallId: 'call-1',
      decision: 'kept',
      rejection: null,
    })

    expect(twice.decisions).toHaveLength(1)
    expect(rowFor(changeRows(twice, files.read), 'notes/a.md').decision?.decision).toBe('kept')
  })

  it('a later write of the same path is a new change, and the answer does not carry', () => {
    // The answer is about *a change*, not about a path. The agent writing the note again is a
    // change nobody has answered, and a row that read "kept" there would be hiding work the user
    // has not seen.
    const { files, review } = recoverable()
    const answered = decideChange(review, {
      path: 'notes/a.md',
      toolCallId: 'call-1',
      decision: 'kept',
      rejection: null,
    })
    const again = {
      ...answered,
      writes: Object.freeze([
        ...answered.writes,
        Object.freeze({
          toolCallId: 'call-2',
          tool: 'edit' as const,
          paths: Object.freeze(['notes/a.md']),
          status: 'completed' as const,
          results: Object.freeze([{ path: 'notes/a.md', text: 'after' }]),
        }),
      ]),
    }

    const row = rowFor(changeRows(again, files.read), 'notes/a.md')
    expect(row.toolCallId).toBe('call-2')
    expect(row.decision).toBeNull()
    expect(row.offers).toEqual(['view', 'recover'])
  })
})

/** The payload of a `tool-update`, for the identity cases above. */
function toolPayload(toolCallId: string, paths: string[]): AgentPayloads['tool-update'] {
  return {
    toolCallId,
    title: `Editing ${paths.join(', ')}`,
    kind: 'edit',
    status: 'completed',
    paths,
    content: [],
    input: { state: 'absent' },
    output: { state: 'absent' },
  }
}
