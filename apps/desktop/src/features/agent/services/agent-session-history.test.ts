/**
 * The two decisions the history surface makes before anything is drawn.
 *
 * Both are rules with a wrong version that reads as a fact about the engine, which is why they
 * are tested here rather than left to the components that consume them: a trigger drawn for a
 * feature the engine never said it answers, and a row that reports a name or an age the engine
 * did not send. The third arm of `AgentCapabilityFinding` is the one this file exists for —
 * `unverified` is nobody having asked, and it must not read as "available" or as "no".
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../../i18n'
import {
  AGENT_CAPABILITY_FEATURES,
  AGENT_CAPABILITY_HOST_OFFERS,
} from '../../../platform/gateways/agent-contracts'
import type {
  AgentCapabilityFinding,
  AgentCapabilityReport,
  AgentSessionHistory,
} from '../../../platform/gateways/agent-contracts'
import {
  agentSessionHistoryRows,
  capabilityAvailable,
  describeSessionAge,
  filterSessionRows,
} from './agent-session-history'

/** A whole report — one row per feature the contract knows — with `session-list` set to what the
 *  case is about. A short report would not be one this window could read at all
 *  (`readCapabilityReports`), so a test that built one would be testing a shape the contract
 *  refuses. */
function report(finding: AgentCapabilityFinding): AgentCapabilityReport[] {
  return AGENT_CAPABILITY_FEATURES.map((feature) => ({
    feature,
    declared: 'unverified' as const,
    host: AGENT_CAPABILITY_HOST_OFFERS[feature],
    finding:
      feature === 'session-list'
        ? finding
        : { status: 'unverified' as const, detail: 'nothing was measured' },
  }))
}

/** The same table with `session-close` moved to whatever the case is about: the two features this
 *  surface gates on are read by the same rule and can disagree. */
function reportForClose(finding: AgentCapabilityFinding): AgentCapabilityReport[] {
  return AGENT_CAPABILITY_FEATURES.map((feature) => ({
    feature,
    declared: 'unverified' as const,
    host: AGENT_CAPABILITY_HOST_OFFERS[feature],
    finding:
      feature === 'session-close'
        ? finding
        : { status: 'unverified' as const, detail: 'nothing was measured' },
  }))
}

const PAGE: AgentSessionHistory = {
  sessions: [
    {
      sessionId: 'session-2',
      cwd: '/notes/vault',
      title: 'New session - 2026-01-01T00:00:02Z',
      updatedAt: '2026-01-01T00:00:02Z',
      held: true,
    },
    {
      sessionId: 'session-1',
      cwd: '/notes/other',
      title: null,
      updatedAt: null,
      // The engine's table outlives the run that wrote it: this is a session an earlier runtime
      // instance opened, which is the case a history exists for and the one this host refuses to
      // close (`held` is read, never derived).
      held: false,
    },
  ],
  nextCursor: null,
}

beforeEach(() => {
  setLocale('en')
})

describe('whether the engine offers the method behind a control', () => {
  it('is offered only for the engine’s own available finding', () => {
    expect(capabilityAvailable(report({ status: 'available' }), 'session-list')).toBe(true)
    // The two non-answers, which are different facts from each other and the same answer here:
    // a control drawn for either would offer a method the engine never claimed.
    const unavailable = report({ status: 'unavailable', detail: 'no list' })
    const unverified = report({ status: 'unverified', detail: 'not measured' })
    expect(capabilityAvailable(unavailable, 'session-list')).toBe(false)
    expect(capabilityAvailable(unverified, 'session-list')).toBe(false)
    // And a report that does not mention the feature has, in the same sense, not reported it.
    expect(capabilityAvailable([], 'session-list')).toBe(false)
  })

  it('answers `null` — no report at all — the same way, which this question and no other may do', () => {
    // An engine that has not answered cannot license a control: the gate is an `available` finding,
    // and "nothing has answered" is not one. The collapse is asserted here so that it is a rule this
    // function owns rather than a `?? []` each call site writes for itself — and it is *this*
    // question's rule only. A surface that has to say **why** it refused a file owes a different
    // sentence per state, and `agent-composer-attachments.ts` keeps them apart
    // (`attachmentStanding`).
    expect(capabilityAvailable(null, 'session-list')).toBe(false)
    expect(capabilityAvailable(null, 'session-close')).toBe(false)
  })

  it('reads each feature on its own line, so the two controls cannot be drawn together', () => {
    // `session-list` available and `session-close` unverified is the state the pinned engine may
    // well be in: history is offered, and the free action is not.
    expect(capabilityAvailable(reportForClose({ status: 'unverified', detail: 'not measured' }), 'session-close')).toBe(false)
    expect(capabilityAvailable(reportForClose({ status: 'available' }), 'session-close')).toBe(true)
    // And the other way round, so the gate is per feature rather than one boolean for both.
    expect(capabilityAvailable(report({ status: 'available' }), 'session-close')).toBe(false)
    expect(capabilityAvailable(reportForClose({ status: 'available' }), 'session-list')).toBe(false)
  })
})

describe('the rows an engine’s answer draws', () => {
  it('keeps the engine’s order, its titles and its missing fields exactly as they arrived', () => {
    const rows = agentSessionHistoryRows(PAGE, { currentSessionId: 'session-1', cwd: '/notes/vault' })
    // The engine's order, not this app's: ACP has no creation time to sort by, and re-ranking the
    // list would be an opinion about an answer that is not this window's.
    expect(rows.map((row) => row.sessionId)).toEqual(['session-2', 'session-1'])
    expect(rows[0]?.title).toBe('New session - 2026-01-01T00:00:02Z')
    // No title and no stamp are kept as absences: a row that filled either in would be stating
    // something the engine did not.
    expect(rows[1]?.title).toBeNull()
    expect(rows[1]?.updatedAt).toBeNull()
  })

  it('marks the session that is open, and the one recorded in another folder', () => {
    const rows = agentSessionHistoryRows(PAGE, { currentSessionId: 'session-1', cwd: '/notes/vault' })
    const [open, elsewhere] = rows
    // The row the reader is already in: drawn and marked rather than hidden, and inert where it
    // is acted on (the engine refuses a load of a session it is serving).
    expect(open?.current).toBe(false)
    expect(open?.elsewhere).toBe(false)
    expect(elsewhere?.current).toBe(true)
    // The engine recorded this one in a different directory from the one this runtime works in.
    expect(elsewhere?.elsewhere).toBe(true)
  })
})

describe('the rows a query keeps', () => {
  const rows = (): ReturnType<typeof agentSessionHistoryRows> =>
    agentSessionHistoryRows(PAGE, { currentSessionId: 'session-1', cwd: '/notes/vault' })

  it('keeps the engine’s rows, in its order, when nothing has been asked for', () => {
    // A field the reader has opened and not typed in is not a query, and a whitespace-only one is
    // the same nothing: the list the engine answered with is what is drawn, unchanged.
    expect(filterSessionRows(rows(), '')).toEqual(rows())
    expect(filterSessionRows(rows(), '   ')).toEqual(rows())
  })

  it('matches the engine’s own title, wherever it falls and whatever its case', () => {
    expect(filterSessionRows(rows(), 'session - 2026-01-01T00:00:02Z').map(idOf)).toEqual([
      'session-2',
    ])
    expect(filterSessionRows(rows(), 'NEW SESSION').map(idOf)).toEqual(['session-2'])
  })

  it('matches the folder the engine recorded a row in', () => {
    // The one fact about a row that changes what picking it means, and the one a reader who is
    // looking for "the session I had open in that other folder" is actually searching for.
    expect(filterSessionRows(rows(), 'other').map(idOf)).toEqual(['session-1'])
  })

  it('answers with nothing at all when no row carries the query', () => {
    // Not the whole list: a field that appeared to do nothing is worse than one that says it found
    // nothing, and the popup has a sentence for the second.
    expect(filterSessionRows(rows(), 'no session says this')).toEqual([])
  })

  it('does not match a row on a word this app wrote about it', () => {
    // Two strings that sit on or beside a row and are **not** the engine's facts: the sentence this
    // app draws where the engine sent no title (`agent.panel.history.untitled`), and the session id
    // the row is keyed by. A row drawn for either would be a match the row itself does not explain
    // — the reader sees a row whose visible facts contain nothing they typed.
    expect(filterSessionRows(rows(), 'the engine sent no title')).toEqual([])
    expect(filterSessionRows(rows(), 'session-1')).toEqual([])
  })

  function idOf(row: { sessionId: string }): string {
    return row.sessionId
  }
})

describe('the age of a row', () => {
  const at = (iso: string): number => Date.parse(iso)

  it('reads the engine’s stamp as a count inside the recent window', () => {
    const now = at('2026-03-10T12:00:00Z')
    expect(describeSessionAge('2026-03-10T11:59:30Z', now)).toBe('just now')
    expect(describeSessionAge('2026-03-10T11:30:00Z', now)).toBe('30 min ago')
    expect(describeSessionAge('2026-03-10T09:00:00Z', now)).toBe('3 h ago')
    expect(describeSessionAge('2026-03-08T12:00:00Z', now)).toBe('2 d ago')
  })

  it('shows the engine’s own date when a count would stop meaning anything', () => {
    const now = at('2026-03-10T12:00:00Z')
    expect(describeSessionAge('2025-11-02T08:30:00Z', now)).toBe('2025-11-02')
    // A stamp in the future is two machines disagreeing about the clock, and no count of minutes
    // is true about it.
    expect(describeSessionAge('2026-03-11T12:00:00Z', now)).toBe('2026-03-11')
  })

  it('says nothing rather than guessing', () => {
    expect(describeSessionAge(null, at('2026-03-10T12:00:00Z'))).toBeNull()
    // A stamp this window cannot parse is shown as the engine sent it: it is still the engine's
    // own string, and a date this app computed from it would be this app's invention.
    expect(describeSessionAge('sometime last week', at('2026-03-10T12:00:00Z'))).toBe(
      'sometime last week',
    )
  })
})
