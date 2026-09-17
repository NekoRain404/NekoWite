/**
 * What the editor pane has to decide about, read off the session's own stream.
 *
 * The join this file tests is the one that was missing: the judging half of an agent edit has
 * been live since `agent-session.ts` started capturing baselines at the send, and nothing ever
 * handed it a proposal. This projection is where a proposal comes from — a tool call's own
 * `diff` block, which ACP defines as the pair `oldText`/`newText` and which `agent-edit-apply.ts`
 * names in its own header as the shape a proposal already has.
 *
 * The assertions are mostly about what is NOT offered. Each refusal below is a different way of
 * answering a question nobody asked: a write with no version to check it against, a write whose
 * original text the engine never stated, a write the engine produced against a document this
 * note is not, and a write that would leave the note exactly as it is.
 */
import { describe, expect, it } from 'vitest'
import type { AgentIdentity } from '../../../platform/gateways/agent-contracts'
import type { AgentToolEntry } from './agent-timeline'
import { captureEditBaselines } from './agent-edit-apply'
import type { AgentLiveNote } from './agent-context-snapshot'
import { noteProposalsFor } from './agent-note-proposals'

const IDENTITY: AgentIdentity = {
  agentId: 'opencode',
  profileId: 'default',
  runtimeEpoch: 'epoch-1',
  vaultId: '/vault',
  sessionId: 'session-1',
}

const NOTE_PATH = '/vault/notes/a.md'
const AT_SEND = '# A\n\nas it was when the question went out'

/** The note as the editor held it at the send. This is the baseline's whole content. */
function live(overrides: Partial<AgentLiveNote> = {}): AgentLiveNote {
  return {
    vaultId: '/vault',
    path: NOTE_PATH,
    revision: 'page-1:tab-1:0',
    buffer: { state: 'clean', text: AT_SEND },
    ...overrides,
  }
}

function baselineOf(note: AgentLiveNote = live()) {
  return captureEditBaselines([note], IDENTITY).baselines[0]!
}

function toolCall(overrides: Partial<AgentToolEntry> = {}): AgentToolEntry {
  return {
    kind: 'tool',
    id: 1,
    runId: 'run-1',
    toolCallId: 'call-1',
    title: 'Edit notes/a.md',
    toolKind: 'edit',
    status: 'completed',
    paths: [NOTE_PATH],
    content: [],
    input: { state: 'absent' },
    output: { state: 'absent' },
    ...overrides,
  }
}

function diffCall(overrides: Partial<AgentToolEntry> = {}, block: Record<string, unknown> = {}): AgentToolEntry {
  return toolCall({
    ...overrides,
    content: [
      {
        type: 'diff',
        path: NOTE_PATH,
        oldText: AT_SEND,
        newText: '# A\n\nthe version the agent produced',
        ...block,
      },
    ],
  } as Partial<AgentToolEntry>)
}

const ASK = { entries: [diffCall()], path: NOTE_PATH, baseline: baselineOf() }

describe('a proposal for the note the editor has open', () => {
  it('offers the engine’s own new text, bound to the version the request was made against', () => {
    const [proposal] = noteProposalsFor(ASK)

    expect(proposal?.kind).toBe('edit')
    if (proposal?.kind !== 'edit') return
    // The check the apply path will run is against the REQUEST's version, not against a version
    // read when the answer arrived: that is the rule the whole module exists for.
    expect(proposal.proposal.baseline).toEqual(baselineOf())
    expect(proposal.proposal.baseline.text).toBe(AT_SEND)
    expect(proposal.proposal.text).toBe('# A\n\nthe version the agent produced')
    expect(proposal.toolCallId).toBe('call-1')
  })

  it('offers nothing when no request named this note, so there is no version to check against', () => {
    expect(noteProposalsFor({ ...ASK, baseline: null })).toEqual([])
  })

  it('offers nothing when the engine stated no original text', () => {
    // `null` is not proof of a new file — the schema's deserializer produces it for text that
    // failed to parse too — so it is an absence to report, never a version to write over.
    expect(noteProposalsFor({ ...ASK, entries: [diffCall({}, { oldText: null })] })).toEqual([])
  })

  it('offers nothing when the engine produced against a different document than the note holds', () => {
    // The engine's original text and the text the request was made against are two witnesses of
    // one fact. When they disagree, the answer was not produced for this note, and writing it
    // over the note would be the silent overwrite with a question mark in front of it.
    expect(
      noteProposalsFor({ ...ASK, entries: [diffCall({}, { oldText: '# A\n\nsomething else entirely' })] }),
    ).toEqual([])
  })

  it('offers nothing when applying it would leave the note exactly as it is', () => {
    expect(noteProposalsFor({ ...ASK, entries: [diffCall({}, { newText: AT_SEND })] })).toEqual([])
  })

  it('offers nothing for a diff about another file', () => {
    expect(noteProposalsFor({ ...ASK, entries: [diffCall({}, { path: '/vault/notes/b.md' })] })).toEqual([])
  })

  it('offers nothing for a diff with no path at all', () => {
    // The engine builds the field as `filePath ?? ""`, so a blank path is a value it stated. It
    // names no file, so there is no note to offer this against.
    expect(noteProposalsFor({ ...ASK, entries: [diffCall({}, { path: '' })] })).toEqual([])
  })

  it('reads past the rows that are not tool calls, and past tool calls that carry no diff', () => {
    const entries = [
      {
        kind: 'user' as const,
        id: 1,
        runId: 'run-1',
        text: 'rewrite this',
        origin: 'host' as const,
        attachments: [],
      },
      toolCall({ id: 2, toolCallId: 'call-read', toolKind: 'read', content: [] }),
      diffCall({ id: 3 }),
    ]

    const proposals = noteProposalsFor({ ...ASK, entries })
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.kind).toBe('edit')
  })

  it('keeps one proposal per tool call, in the order the stream carried them', () => {
    const entries = [
      diffCall({ id: 1, toolCallId: 'call-1' }, { newText: 'first' }),
      diffCall({ id: 2, toolCallId: 'call-2' }, { newText: 'second' }),
    ]

    expect(noteProposalsFor({ ...ASK, entries }).map((p) => p.toolCallId)).toEqual(['call-1', 'call-2'])
  })
})

describe('a staged SVG the agent wrote', () => {
  const SVG_PATH = '/vault/attachments/2026-09/diagram.svg'

  it('offers the artifact a write-kind call named, for the note that is open', () => {
    const entries = [toolCall({ toolCallId: 'call-svg', paths: [SVG_PATH], content: [] })]

    const proposals = noteProposalsFor({ ...ASK, entries, baseline: null })
    expect(proposals).toEqual([{ kind: 'svg', toolCallId: 'call-svg', path: SVG_PATH }])
  })

  it('offers nothing for an SVG the run only read', () => {
    // `AGENT_WRITE_TOOLS`' rule: a path a call merely touched is not a file the call changes, and
    // offering to insert a document nobody wrote would be this surface inventing an artifact.
    const entries = [toolCall({ toolKind: 'read', paths: [SVG_PATH], content: [] })]
    expect(noteProposalsFor({ ...ASK, entries, baseline: null })).toEqual([])
  })

  it('offers nothing for a file that is not an SVG', () => {
    const entries = [toolCall({ paths: ['/vault/attachments/2026-09/photo.png'], content: [] })]
    expect(noteProposalsFor({ ...ASK, entries, baseline: null })).toEqual([])
  })

  it('keeps the newest artifact when a path is written more than once', () => {
    const entries = [
      toolCall({ id: 1, toolCallId: 'call-1', paths: [SVG_PATH], content: [] }),
      toolCall({ id: 2, toolCallId: 'call-2', paths: [SVG_PATH], content: [] }),
    ]

    expect(noteProposalsFor({ ...ASK, entries, baseline: null })).toEqual([
      { kind: 'svg', toolCallId: 'call-2', path: SVG_PATH },
    ])
  })

  it('does not need a baseline: an insertion is checked against the spot, not against a request', () => {
    const entries = [toolCall({ paths: [SVG_PATH], content: [] })]
    expect(noteProposalsFor({ ...ASK, entries, baseline: null })).toHaveLength(1)
  })
})
