/**
 * The reader's own row, and what it is allowed to remember.
 *
 * The engine's copy of the user's half is text and nothing else, but the *host's* row is written at
 * the moment the reader pressed send — the one instant the whole of what a turn carries is in
 * hand. Recorded there, it is the only record there is: the composer's strip is cleared when the
 * draft is, so a turn whose row says nothing leaves a conversation with no trace that the model was
 * ever shown a file.
 *
 * What is asserted here is what the row holds and what it deliberately does not: a label and a
 * kind, never the block. An image's `data` is base64 of up to ten megabytes and the view keeps
 * every row of the session, so a row carrying blocks would hold a conversation's worth of image
 * bytes in memory for as long as the tab is open.
 */
import { describe, expect, it } from 'vitest'
import type {
  AgentIdentity,
  AgentPromptAttachment,
} from '../../../platform/gateways/agent-contracts'
import { initialAgentSessionView, startAgentRun } from './agent-session-view'
import { userAttachments, type AgentUserEntry } from './agent-timeline'

const IDENTITY: AgentIdentity = {
  agentId: 'agent-1',
  profileId: 'profile-1',
  runtimeEpoch: 'epoch-1',
  vaultId: 'vault-1',
  sessionId: 'session-1',
}

const anImage: AgentPromptAttachment = {
  kind: 'image',
  name: 'knowledge-base-diagram.png',
  mediaType: 'image/png',
  data: 'QUJD',
}

const aFile: AgentPromptAttachment = {
  kind: 'resource',
  path: 'notes/a.md',
  text: '# a',
  mediaType: 'text/markdown',
}

/** The reader's row of a view, which is the only one `startAgentRun` writes. */
function userRow(attachments: readonly AgentPromptAttachment[]): AgentUserEntry {
  const started = startAgentRun(initialAgentSessionView(IDENTITY), 'look at these', attachments)
  expect(started.accepted).toBe(true)
  const row = started.view.timeline[0]
  if (row === undefined || row.kind !== 'user') throw new Error('no user row was written')
  return row
}

describe('what a turn carried', () => {
  it('names each file the way the reader saw it, across both arms', () => {
    // The two arms do not share a field name — a resource is a `path` and an image is a `name` —
    // which is the whole reason this goes through the contract's own label rule rather than
    // reading one of the two here.
    expect(userAttachments([aFile, anImage])).toEqual([
      { kind: 'resource', name: 'notes/a.md' },
      { kind: 'image', name: 'knowledge-base-diagram.png' },
    ])
  })

  it('keeps the order the reader attached them in', () => {
    expect(userAttachments([anImage, aFile]).map((record) => record.kind)).toEqual([
      'image',
      'resource',
    ])
  })

  it('leaves the bytes behind', () => {
    // The one thing the row must not hold. A record that carried `data` would be the whole turn's
    // image bytes retained by the view for the life of the session.
    expect(JSON.stringify(userAttachments([anImage]))).not.toContain('QUJD')
  })
})

describe('the reader’s row', () => {
  it('records what the send carried', () => {
    expect(userRow([aFile, anImage]).attachments).toEqual([
      { kind: 'resource', name: 'notes/a.md' },
      { kind: 'image', name: 'knowledge-base-diagram.png' },
    ])
  })

  it('records an empty list for a turn that carried nothing', () => {
    // Empty rather than absent: a reader of the row should not have to tell "this turn carried
    // nothing" from "this row predates the field".
    expect(userRow([]).attachments).toEqual([])
  })

  it('records the same list whichever way a send spells its attachments', () => {
    // The store's own default is `[]`, and a caller of `startAgentRun` that passes nothing is the
    // ordinary case for every test and every caller that predates this field.
    const started = startAgentRun(initialAgentSessionView(IDENTITY), 'hello')
    expect(started.accepted).toBe(true)
    expect(started.view.timeline[0]).toMatchObject({ kind: 'user', attachments: [] })
  })
})
