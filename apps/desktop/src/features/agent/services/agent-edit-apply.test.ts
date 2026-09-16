/**
 * Applying an answer over a note the user may have been typing in.
 *
 * The scenario every test here is a variation of: the user asks, the model thinks, the user
 * keeps writing in the same note, the answer arrives. What is asserted is never "it worked" but
 * *which of the three things happened* — a write, a question, or nothing — and, on the ones that
 * write, that the text the user typed is still in the caller's hands afterwards.
 *
 * The last describe block is the one the acceptance is really about: the same path driven
 * through a burst of proposals whose notes move underneath them, where the only thing that must
 * hold is that no write lands over text nobody looked at.
 */
import { describe, expect, it } from 'vitest'
import type { AgentIdentity } from '../../../platform/gateways/agent-contracts'
import type { AgentLiveNote } from './agent-context-snapshot'
import {
  applyAgentEdit,
  captureEditBaselines,
  judgeAgentEdit,
  type AgentEditBaseline,
  type AgentEditChoice,
  type AgentEditConflict,
  type AgentEditHost,
  type AgentEditProposal,
  type AgentEditWriteOutcome,
  type DisplacedNote,
} from './agent-edit-apply'

const IDENTITY: AgentIdentity = {
  agentId: 'opencode',
  profileId: 'default',
  runtimeEpoch: 'epoch-1',
  vaultId: 'vault-a',
  sessionId: 'ses-1',
}

const PATH = 'notes/a.md'
const BEFORE = 'the note as the user left it'

/** A note as the editor has it. The default is the clean case: the buffer holds the file's text
 *  and the revision is the one that text was last synced at. */
function live(fields: {
  path?: string
  vaultId?: string
  revision?: string
  text?: string
  buffer?: AgentLiveNote['buffer']
} = {}): AgentLiveNote {
  return {
    vaultId: fields.vaultId ?? IDENTITY.vaultId,
    path: fields.path ?? PATH,
    revision: fields.revision ?? 'r1',
    buffer: fields.buffer ?? { state: 'clean', text: fields.text ?? BEFORE },
  }
}

/** The baseline the prompt path captures, from a note the editor is holding. */
function baselineOf(note: AgentLiveNote = live()): AgentEditBaseline {
  const captured = captureEditBaselines([note], IDENTITY)
  expect(captured.refused).toEqual([])
  return captured.baselines[0]
}

function proposalOf(agentText = 'the note the agent wrote', note: AgentLiveNote = live()): AgentEditProposal {
  return { baseline: baselineOf(note), text: agentText }
}

/** What a host was asked to do, in order. The order is load-bearing: the question has to come
 *  before the write. */
interface Seen {
  calls: string[]
  asked: AgentEditConflict[]
  written: Array<{ path: string; text: string }>
}

/**
 * A host that records what it was asked, and answers from scripted values.
 *
 * `live` is a function rather than a value so a test can move the note between two reads: the
 * apply path reads once to judge and again to decide what a conflict-apply displaces, and the
 * difference between those two reads is what several of these tests are about.
 */
function host(options: {
  live: (path: string) => AgentLiveNote | null
  choice?: AgentEditChoice
  write?: AgentEditWriteOutcome
}): { host: AgentEditHost; seen: Seen } {
  const seen: Seen = { calls: [], asked: [], written: [] }
  return {
    seen,
    host: {
      live(path) {
        seen.calls.push(`live:${path}`)
        return options.live(path)
      },
      async write(path, text) {
        seen.calls.push(`write:${path}`)
        seen.written.push({ path, text })
        return options.write ?? { status: 'saved' }
      },
      async ask(conflict) {
        seen.calls.push(`ask:${conflict.path}`)
        seen.asked.push(conflict)
        return options.choice ?? 'discard'
      },
    },
  }
}

describe('the note has not moved', () => {
  it('writes the answer, and has nothing to ask', async () => {
    const { host: h, seen } = host({ live: () => live() })

    const outcome = await applyAgentEdit(proposalOf(), IDENTITY, h)

    expect(outcome).toEqual({ status: 'applied', path: PATH, displaced: null })
    expect(seen.written).toEqual([{ path: PATH, text: 'the note the agent wrote' }])
    // No question was put to the user: there was no conflict to put.
    expect(seen.asked).toEqual([])
  })

  it('writes nothing when the user discards a conflict', async () => {
    const { host: h, seen } = host({
      live: () => live({ text: `${BEFORE}\nwhat I typed while it thought`, revision: 'r7' }),
      choice: 'discard',
    })

    const outcome = await applyAgentEdit(proposalOf(), IDENTITY, h)

    expect(outcome).toEqual({ status: 'discarded', path: PATH })
    expect(seen.written).toEqual([])
  })
})

describe('the user typed in the same note while the run was in flight', () => {
  it('does not write, and hands the conflict both texts', async () => {
    const { host: h, seen } = host({
      live: () => live({ text: `${BEFORE}\nwhat I typed while it thought`, revision: 'r7' }),
      choice: 'discard',
    })

    const outcome = await applyAgentEdit(proposalOf(), IDENTITY, h)

    expect(outcome.status).toBe('discarded')
    // Nothing reached the note: this is the whole point of the task.
    expect(seen.written).toEqual([])
    expect(seen.asked).toHaveLength(1)
    expect(seen.asked[0]).toMatchObject({
      path: PATH,
      agentText: 'the note the agent wrote',
      noteText: `${BEFORE}\nwhat I typed while it thought`,
      baselineRevision: 'r1',
      currentRevision: 'r7',
    })
  })

  it('is a conflict when only the text moved, so a revision that lags an unsaved edit cannot let the write through', async () => {
    // The revision this feature is handed is the one the buffer was last SYNCED with, so a
    // buffer with unsaved edits can sit at an unchanged revision while its text moves under it.
    // The text is the second witness, and this is the edit it exists for.
    const { host: h, seen } = host({
      live: () => live({ text: `${BEFORE} plus unsaved` }),
      choice: 'discard',
    })

    const outcome = await applyAgentEdit(proposalOf(), IDENTITY, h)

    expect(outcome.status).toBe('discarded')
    expect(seen.written).toEqual([])
  })

  it('applies anyway when the user says so, and hands back exactly what the write displaced', async () => {
    const mine = `${BEFORE}\nmine`
    const { host: h, seen } = host({ live: () => live({ text: mine, revision: 'r7' }), choice: 'apply' })

    const outcome = await applyAgentEdit(proposalOf(), IDENTITY, h)

    // The user's text is a value the caller holds afterwards — not text that was on screen
    // once and then gone, which is what "recoverable" has to mean to be worth anything.
    const displaced: DisplacedNote | null = outcome.status === 'applied' ? outcome.displaced : null
    expect(displaced).toEqual({ path: PATH, revision: 'r7', text: mine })
    expect(seen.written).toEqual([{ path: PATH, text: 'the note the agent wrote' }])
  })

  it('records the text the write really took, not the text the dialog showed', async () => {
    // The question is on screen for as long as the user takes to answer it, and the note is
    // still editable behind it. The displaced text is read after the answer, so what the caller
    // gets back is the text that was actually replaced.
    const reads = [live({ text: `${BEFORE}\nfirst thought`, revision: 'r7' }), live({ text: `${BEFORE}\nsecond thought`, revision: 'r9' })]
    let at = 0
    const { host: h, seen } = host({ live: () => reads[Math.min(at++, reads.length - 1)], choice: 'apply' })

    const outcome = await applyAgentEdit(proposalOf(), IDENTITY, h)

    expect(outcome).toMatchObject({
      status: 'applied',
      displaced: { revision: 'r9', text: `${BEFORE}\nsecond thought` },
    })
    // The dialog showed the first of the two, which is what makes the difference worth holding.
    expect(seen.asked[0]?.noteText).toBe(`${BEFORE}\nfirst thought`)
    expect(seen.written).toHaveLength(1)
  })

  it('writes nothing when the note closed while the question was open', async () => {
    const reads: Array<AgentLiveNote | null> = [live({ text: `${BEFORE}\nmine`, revision: 'r7' }), null]
    let at = 0
    const { host: h, seen } = host({ live: () => reads[at++] ?? null, choice: 'apply' })

    const outcome = await applyAgentEdit(proposalOf(), IDENTITY, h)

    expect(outcome).toEqual({ status: 'refused', refusal: { reason: 'note-not-open', path: PATH } })
    // Not re-opened, not written blind: the answer would have landed in a document the user has
    // not seen.
    expect(seen.written).toEqual([])
  })
})

describe('the user typed in a different note', () => {
  it('applies to the note the request named, without a question', async () => {
    // A version bump elsewhere is not a conflict: the baseline is per path, and this note is
    // exactly where the request left it.
    const { host: h, seen } = host({ live: (path) => (path === PATH ? live() : null) })

    const outcome = await applyAgentEdit(proposalOf(), IDENTITY, h)

    expect(outcome).toMatchObject({ status: 'applied', displaced: null })
    expect(seen.asked).toEqual([])
    expect(seen.written).toEqual([{ path: PATH, text: 'the note the agent wrote' }])
  })
})

describe('the document is a different instance', () => {
  it('refuses to write into a note closed and reopened at the same path, even when its text came back identical', async () => {
    // Reopening the same file is a different document: the editor's revision is its claim about
    // the document, not about the bytes, and the write was prepared for the document that was
    // open when the user asked.
    const { host: h, seen } = host({
      live: () => live({ revision: 'doc-2#1' }),
      choice: 'discard',
    })

    const outcome = await applyAgentEdit(proposalOf('after', live({ revision: 'doc-1#4' })), IDENTITY, h)

    expect(seen.asked[0]).toMatchObject({ baselineRevision: 'doc-1#4', currentRevision: 'doc-2#1' })
    expect(outcome.status).toBe('discarded')
    expect(seen.written).toEqual([])
  })

  it('refuses a note no tab holds, and a note in another vault', async () => {
    const closed = host({ live: () => null })
    expect(await applyAgentEdit(proposalOf(), IDENTITY, closed.host)).toEqual({
      status: 'refused',
      refusal: { reason: 'note-not-open', path: PATH },
    })

    const foreign = host({ live: () => live({ vaultId: 'vault-b' }) })
    expect(await applyAgentEdit(proposalOf(), IDENTITY, foreign.host)).toEqual({
      status: 'refused',
      refusal: { reason: 'vault-mismatch', path: PATH, noteVaultId: 'vault-b', contextVaultId: 'vault-a' },
    })
  })

  it('refuses an answer produced under a session that is over', async () => {
    // A restarted runtime looks the same on the wire, so the epoch is part of what an apply is
    // checked against — and here it is the only thing that changed.
    const { host: h, seen } = host({ live: () => live() })

    const outcome = await applyAgentEdit(proposalOf(), { ...IDENTITY, runtimeEpoch: 'epoch-2' }, h)

    expect(outcome).toEqual({ status: 'refused', refusal: { reason: 'identity-changed', field: 'runtimeEpoch' } })
    // Nothing was written and nothing was asked: a session that is over cannot put a question to
    // a user who has moved on, and there is nothing to decide.
    expect(seen.calls.filter((call) => !call.startsWith('live:'))).toEqual([])
  })
})

describe('the write itself', () => {
  it('reports a failed save as its own outcome, with the displaced text still in hand', async () => {
    const mine = `${BEFORE}\nmine`
    const { host: h, seen } = host({
      live: () => live({ text: mine, revision: 'r7' }),
      choice: 'apply',
      write: { status: 'save-failed' },
    })

    const outcome = await applyAgentEdit(proposalOf(), IDENTITY, h)

    // Not `applied`: the text is in the note and the file does not have it, and a caller that
    // reported success here would be the silent failure this arm exists to prevent.
    expect(outcome).toEqual({
      status: 'save-failed',
      path: PATH,
      displaced: { path: PATH, revision: 'r7', text: mine },
    })
    expect(seen.written).toHaveLength(1)
  })

  it('turns a note nothing can take the text into a refusal, not a write', async () => {
    const { host: h } = host({ live: () => live(), write: { status: 'unavailable' } })

    const outcome = await applyAgentEdit(proposalOf(), IDENTITY, h)

    expect(outcome).toEqual({ status: 'refused', refusal: { reason: 'write-unavailable', path: PATH } })
  })
})

describe('the comparison itself', () => {
  it('refuses a lookup that answered with another note', () => {
    const judged = judgeAgentEdit(proposalOf(), live({ path: 'notes/b.md' }), IDENTITY)
    expect(judged).toEqual({
      status: 'refused',
      refusal: { reason: 'target-changed', path: 'notes/b.md', plannedPath: PATH },
    })
  })

  it('refuses a note captured from another vault, and says which one', () => {
    const captured = captureEditBaselines([live({ vaultId: 'vault-b', path: 'notes/b.md' })], IDENTITY)
    expect(captured.baselines).toEqual([])
    expect(captured.refused).toEqual([
      { reason: 'vault-mismatch', path: 'notes/b.md', noteVaultId: 'vault-b', contextVaultId: 'vault-a' },
    ])
  })
})

describe('under rapid switching', () => {
  it('reads only the path the request named, and takes the question before the write', async () => {
    // The note moves between the judgement and the write, which is the order a fast user
    // produces: the dialog names one text, the write replaces a newer one. Both reads are about
    // the proposal's own path — never "the active note" — and the question comes first.
    const reads: string[] = []
    const { host: h, seen } = host({
      live: (path) => {
        const text = `${BEFORE} plus ${reads.length} keystrokes`
        reads.push(text)
        return live({ path, text, revision: `r${reads.length + 1}` })
      },
      choice: 'apply',
    })

    const outcome = await applyAgentEdit(proposalOf(), IDENTITY, h)

    expect(seen.calls).toEqual([`live:${PATH}`, `ask:${PATH}`, `live:${PATH}`, `write:${PATH}`])
    expect(seen.asked[0]?.noteText).toBe(reads[0])
    expect(outcome).toMatchObject({ status: 'applied', displaced: { text: reads[1] } })
  })

  it('writes only for the proposals the user applied, whatever order the answers arrive in', async () => {
    // Twelve proposals answered one after another, the way a run with several notes on screen
    // produces them, with the notes moving between every read. The count is the assertion: no
    // write without a question, and no question without an answer that came from the user.
    const answers: AgentEditChoice[] = ['apply', 'discard', 'apply', 'discard']
    const asked: string[] = []
    const written: string[] = []

    for (let i = 0; i < 12; i += 1) {
      const path = `notes/n${i}.md`
      const captured = captureEditBaselines([live({ path, text: `before ${i}` })], IDENTITY)
      const proposal: AgentEditProposal = { baseline: captured.baselines[0], text: `after ${i}` }
      const choice = answers[i % answers.length]
      let read = 0

      const outcome = await applyAgentEdit(proposal, IDENTITY, {
        live: (askedPath) => live({ path: askedPath, text: `before ${i} plus ${read++}`, revision: `v${read + 1}` }),
        async write(writtenPath, text) {
          written.push(`${writtenPath}:${text}`)
          return { status: 'saved' }
        },
        async ask(conflict) {
          asked.push(conflict.path)
          return choice
        },
      })

      expect(outcome.status).toBe(choice === 'apply' ? 'applied' : 'discarded')
    }

    expect(asked).toHaveLength(12)
    expect(written).toHaveLength(6)
    // Every write carries the agent's text, never the user's: the text that changed under the
    // apply is what gets displaced, not what gets written.
    written.forEach((entry, at) => {
      expect(entry).toBe(`notes/n${at * 2}.md:after ${at * 2}`)
    })
  })

  it('refuses the proposals whose note closed mid-burst, and writes none of them', async () => {
    // Every note in the burst is closed while its answer is being decided, and the user says
    // "apply anyway" to each. A closed note is a refusal — not a re-open, not a write — so the
    // burst cannot turn "the user switched away" into "the document changed under them".
    let writes = 0
    let questions = 0

    for (let i = 0; i < 12; i += 1) {
      const path = `notes/n${i}.md`
      const captured = captureEditBaselines([live({ path })], IDENTITY)
      let read = 0

      const outcome = await applyAgentEdit({ baseline: captured.baselines[0], text: `after ${i}` }, IDENTITY, {
        // The FIRST read sees the note (so the conflict is real), the second does not (the tab
        // closed while the question was on screen).
        live: (askedPath) => (read++ === 0 ? live({ path: askedPath, revision: 'r2', text: 'mine' }) : null),
        async write() {
          writes += 1
          return { status: 'saved' }
        },
        async ask() {
          questions += 1
          return 'apply'
        },
      })

      expect(outcome).toEqual({ status: 'refused', refusal: { reason: 'note-not-open', path } })
    }

    // Every one of them was asked and answered, and none of them was written.
    expect(questions).toBe(12)
    expect(writes).toBe(0)
  })
})
