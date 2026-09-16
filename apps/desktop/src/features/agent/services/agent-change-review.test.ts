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
  type AgentToolStatus,
} from '../../../platform/gateways/agent-contracts'
import type { AgentLiveNote, AgentLiveNoteBuffer } from './agent-context-snapshot'
import {
  applyChangeEvent,
  changeRows,
  createChangeReview,
  observeDiskChange,
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

/** A write-kind tool call naming `paths`. */
function write(
  toolCallId: string,
  paths: string[],
  options: { tool?: AgentPayloads['tool-update']['kind']; status?: AgentToolStatus } = {},
): AgentEvent {
  return event('tool-update', {
    toolCallId,
    title: `Editing ${paths.join(', ')}`,
    kind: options.tool ?? 'edit',
    status: options.status ?? 'completed',
    paths,
    input: { state: 'text', json: '{}' },
    output: { state: 'absent' },
  })
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
    expect(row.offers).toContain('merge')
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

describe('recovery: what is offered, and what is refused', () => {
  it('a settled agent change with nothing open offers recovery', () => {
    const row = rowFor(changeRows(reviewWith(write('call-1', ['notes/a.md'])), () => null), 'notes/a.md')

    expect(row.offers).toEqual(['view', 'recover'])
    expect(row.refused).toBeNull()
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

  it('an unsaved buffer withholds recovery and offers the merge instead', () => {
    const files = editor()
    files.openDirty('notes/a.md', 'mine', 'theirs')
    const row = rowFor(changeRows(reviewWith(write('call-1', ['notes/a.md'])), files.read), 'notes/a.md')

    expect(row.offers).toEqual(['view', 'merge'])
    expect(row.refused).toEqual({ reason: 'unsaved-edits', path: 'notes/a.md' })
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
    const review = reviewWith(write('call-1', ['notes/a.md']), write('call-2', ['notes/b.md']))

    const rows = changeRows(review, files.read)
    expect(rowFor(rows, 'notes/a.md').offers).toEqual(['view', 'merge'])
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

/** The payload of a `tool-update`, for the identity cases above. */
function toolPayload(toolCallId: string, paths: string[]): AgentPayloads['tool-update'] {
  return {
    toolCallId,
    title: `Editing ${paths.join(', ')}`,
    kind: 'edit',
    status: 'completed',
    paths,
    input: { state: 'absent' },
    output: { state: 'absent' },
  }
}
