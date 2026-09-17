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
import { AGENT_CAPABILITY_FEATURES } from '../../../platform/gateways/agent-contracts'
import type {
  AgentCapabilityFinding,
  AgentCapabilityReport,
  AgentSessionHistory,
} from '../../../platform/gateways/agent-contracts'
import {
  agentSessionHistoryRows,
  capabilityAvailable,
  describeSessionAge,
} from './agent-session-history'

/** A whole report — one row per feature the contract knows — with `session-list` set to what the
 *  case is about. A short report would not be one this window could read at all
 *  (`readCapabilityReports`), so a test that built one would be testing a shape the contract
 *  refuses. */
function report(finding: AgentCapabilityFinding): AgentCapabilityReport[] {
  return AGENT_CAPABILITY_FEATURES.map((feature) => ({
    feature,
    declared: 'unverified' as const,
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
    },
    {
      sessionId: 'session-1',
      cwd: '/notes/other',
      title: null,
      updatedAt: null,
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
