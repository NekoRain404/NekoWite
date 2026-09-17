/**
 * Which row the transcript's two content controls act on.
 *
 * The choice is the whole of these functions, and it is the kind of choice that is invisible in
 * a screenshot: a "copy the newest answer" control that quietly copies a reasoning row, or a
 * "go to your last message" that goes to the engine's replay of it instead of the reader's own,
 * both look right and are wrong.
 */
import { describe, expect, it } from 'vitest'
import { newestReply, newestUserRow } from './agent-timeline-actions'
import type { AgentTimelineEntry } from './agent-timeline'

const user = (id: number, text: string, origin: 'host' | 'engine' = 'host'): AgentTimelineEntry => ({
  kind: 'user',
  id,
  runId: 'run-1',
  text,
  origin,
})

const reply = (id: number, text: string): AgentTimelineEntry => ({
  kind: 'text',
  id,
  runId: 'run-1',
  text,
})

const thought = (id: number, text: string): AgentTimelineEntry => ({
  kind: 'thought',
  id,
  runId: 'run-1',
  text,
})

const tool: AgentTimelineEntry = {
  kind: 'tool',
  id: 90,
  runId: 'run-1',
  toolCallId: 'call-1',
  title: 'Read a.md',
  toolKind: 'read',
  status: 'completed',
  paths: ['a.md'],
  content: [],
  input: { state: 'absent' },
  output: { state: 'absent' },
}

describe('the newest answer', () => {
  it('is the last reply in the transcript', () => {
    expect(newestReply([user(1, 'hi'), reply(2, 'first'), user(3, 'again'), reply(4, 'second')]))
      .toBe('second')
  })

  it('is the reply even when the turn ended on a tool call', () => {
    // The ordinary shape of a turn that edited something: the answer, then the call that
    // carried it out. Copying must not depend on what the last row happens to be.
    expect(newestReply([user(1, 'add a line'), reply(2, 'Done — here is the change.'), tool]))
      .toBe('Done — here is the change.')
  })

  it('is not the engine’s reasoning', () => {
    // A thought row is something the engine disclosed about how it got there. Handing it over
    // as "the answer" would put words in the answer that are not in it.
    expect(newestReply([reply(1, 'the answer'), thought(2, 'weighing two options')]))
      .toBe('the answer')
  })

  it('is null when the engine has not answered', () => {
    expect(newestReply([])).toBeNull()
    expect(newestReply([user(1, 'hi'), tool])).toBeNull()
    // An empty row is a row with nothing in it, not an answer of zero characters.
    expect(newestReply([reply(1, '')])).toBeNull()
  })
})

describe('the reader’s last message', () => {
  it('is the last thing they said, whichever half of the conversation wrote it', () => {
    // `origin: 'engine'` is the replayed copy a reopen produces. It is the same act by the same
    // person, and which one is present depends on how the session was opened.
    expect(newestUserRow([user(1, 'one'), reply(2, 'ok'), user(3, 'two', 'engine')]))
      .toMatchObject({ id: 3, text: 'two' })
  })

  it('is null when they have not said anything', () => {
    expect(newestUserRow([reply(1, 'unprompted')])).toBeNull()
    expect(newestUserRow([])).toBeNull()
  })
})
