/**
 * The run: which one a frame belongs to, what a stopped one may still say, and how a turn ends.
 *
 * After the envelope, the reducer's next judgement is the run a frame is attributed to, and most of
 * this file is the ways that can be refused: another run's content, content that names no run at
 * all, content for a run that was never started, and every frame of a run that is over. The
 * cancelled run is the case worth the most care, because the protocol tells a client to keep
 * accepting a cancelled run's final frames — so accepting them must not mean reviving it.
 *
 * Most frames are built by hand; the last describe drives the memory double instead, because the
 * behaviour that matters most here — a cancelled run's late text arriving after the cancel — is
 * only proved by frames a real producer emitted.
 */

import { describe, expect, it } from 'vitest'
import {
  AGENT_STOP_REASONS,
  type AgentEvent,
  type AgentEventKind,
  type AgentIdentity,
  type AgentPayloads,
  type AgentSession,
} from '../../../platform/gateways/agent-contracts'
import {
  createMemoryAgentGateway,
  type MemoryAgentGateway,
  type MemoryRunScript,
} from '../../../platform/gateways/memory-agent'
import { reduceAgentEvent, type AgentDropReason } from './agent-event-reducer'
import { adoptSnapshot } from './agent-session-snapshot'
import {
  endRun,
  initialAgentSessionView,
  resolvePermission,
  startAgentRun,
  type AgentSessionView,
} from './agent-session-view'

const IDENTITY: AgentIdentity = {
  agentId: 'agent-1',
  profileId: 'profile-1',
  runtimeEpoch: 'epoch-1',
  vaultId: 'vault-1',
  sessionId: 'session-1',
}

function fresh(options: { timelineLimit?: number } = {}): AgentSessionView {
  return initialAgentSessionView(IDENTITY, options)
}

/** One frame, as an adapter would deliver it. The assertion is the correlation between
 *  `kind` and `payload` that the generic parameter cannot carry through the spread. */
function frame<K extends AgentEventKind>(
  kind: K,
  payload: AgentPayloads[K],
  options: { sequence: number; runId?: string | null; identity?: Partial<AgentIdentity> },
): AgentEvent {
  return {
    ...IDENTITY,
    ...options.identity,
    runId: options.runId ?? null,
    sequence: options.sequence,
    kind,
    payload,
  } as AgentEvent
}

/** A view with a run started and not yet named: what the store has between `prompt` and
 *  the run's first frame. */
function startingRun(text = 'do the thing'): AgentSessionView {
  const started = startAgentRun(fresh(), text)
  expect(started.accepted).toBe(true)
  return started.view
}

/** A view with run-1 in flight, bound by its first frame. */
function liveRun(): AgentSessionView {
  const reduced = reduceAgentEvent(
    startingRun(),
    frame('text-delta', { text: 'working' }, { sequence: 1, runId: 'run-1' }),
  )
  expect(reduced.outcome.status).toBe('applied')
  return reduced.view
}

/** Cancel the run in a view, the way the engine reports it. */
function cancelled(view: AgentSessionView): AgentSessionView {
  const reduced = reduceAgentEvent(
    view,
    frame('run-finished', { stopReason: 'cancelled', usage: null }, { sequence: 2, runId: 'run-1' }),
  )
  expect(reduced.outcome.status).toBe('applied')
  expect(reduced.view.state).toBe('cancelled')
  return reduced.view
}

function dropReason(view: AgentSessionView, event: AgentEvent): AgentDropReason {
  const reduced = reduceAgentEvent(view, event)
  expect(reduced.outcome.status).toBe('dropped')
  // A refused event changes nothing at all, and the *same object* coming back is the
  // strongest form of that: not a copy that happens to be equal.
  expect(reduced.view).toBe(view)
  return (reduced.outcome as { reason: AgentDropReason }).reason
}

describe("a cancelled run's late frames", () => {
  it("does not revive the run, and does not touch the transcript", () => {
    const after = cancelled(liveRun())
    const before = after.timeline.length
    const late = reduceAgentEvent(after, frame('text-delta', { text: ' still typing' }, { sequence: 3, runId: 'run-1' }))
    expect(late.outcome).toEqual({ status: 'dropped', reason: 'closed-run' })
    expect(late.view).toBe(after)
    expect(late.view.state).toBe('cancelled')
    expect(late.view.timeline).toHaveLength(before)
  })

  it('is refused even after the next prompt has started, when nothing is bound yet', () => {
    // The window the bound run alone cannot close: `startAgentRun` has cleared `runId` for
    // the run it just began, so a late frame of the dead run would be the first to name a
    // run and would bind itself if the closed-run list were not there.
    const next = startAgentRun(cancelled(liveRun()), 'again').view
    expect(next.runId).toBeNull()
    const late = reduceAgentEvent(next, frame('text-delta', { text: ' late' }, { sequence: 3, runId: 'run-1' }))
    expect(late.outcome).toEqual({ status: 'dropped', reason: 'closed-run' })
    expect(late.view).toBe(next)
  })

  it('still applies the frames that describe the session', () => {
    // "Drop everything after a cancel" is the wrong reading: these frames are not the dead
    // run's output, they are true statements about the session, and refusing them would
    // lose the command list, the plan and the cost along with the text.
    const after = cancelled(liveRun())
    const sessionKinds: { event: AgentEvent; assert: (view: AgentSessionView) => void }[] = [
      {
        event: frame('commands-changed', { commands: [{ name: '/review' }] }, { sequence: 3, runId: 'run-1' }),
        assert: (view) => expect(view.commands).toEqual([{ name: '/review' }]),
      },
      {
        event: frame('plan-changed', { entries: [{ content: 'step', status: 'pending', priority: 'low' }] }, { sequence: 3, runId: 'run-1' }),
        assert: (view) => expect(view.plan).toHaveLength(1),
      },
      {
        event: frame('mode-changed', { modeId: 'plan' }, { sequence: 3, runId: 'run-1' }),
        assert: (view) => expect(view.modeId).toBe('plan'),
      },
      {
        event: frame('usage-changed', { usedTokens: 10, contextTokens: 100, cost: null }, { sequence: 3, runId: 'run-1' }),
        assert: (view) => expect(view.usage?.usedTokens).toBe(10),
      },
      {
        event: frame('files-changed', { paths: ['notes/a.md'] }, { sequence: 3, runId: 'run-1' }),
        assert: (view) => expect(view.changedFiles).toEqual(['notes/a.md']),
      },
      {
        event: frame('session-changed', { title: 'Renamed' }, { sequence: 3, runId: 'run-1' }),
        assert: (view) => expect(view.title).toBe('Renamed'),
      },
    ]
    for (const { event, assert } of sessionKinds) {
      const reduced = reduceAgentEvent(after, event)
      expect(reduced.outcome).toEqual({ status: 'applied' })
      assert(reduced.view)
      // Applied, and still not revived.
      expect(reduced.view.state).toBe('cancelled')
    }
  })

  it('accepts the engine settling a call the panel already shows, and nothing else', () => {
    const running = reduceAgentEvent(
      liveRun(),
      frame(
        'tool-update',
        {
          toolCallId: 'call-1',
          title: 'Reading a.md',
          kind: 'read',
          status: 'in_progress',
          paths: [],
          content: [],
          input: { state: 'absent' },
          output: { state: 'absent' },
        },
        { sequence: 2, runId: 'run-1' },
      ),
    ).view

    // The run ends as cancelled: the call it left in progress is the host's to settle.
    const after = reduceAgentEvent(
      running,
      frame('run-finished', { stopReason: 'cancelled', usage: null }, { sequence: 3, runId: 'run-1' }),
    ).view
    const call = after.timeline.find((entry) => entry.kind === 'tool')
    expect(call).toMatchObject({ status: 'cancelled' })

    // The engine's last word about that call is information, not a revival.
    const settled = reduceAgentEvent(
      after,
      frame(
        'tool-update',
        {
          toolCallId: 'call-1',
          title: 'Read a.md',
          kind: 'read',
          status: 'completed',
          paths: [],
          content: [],
          input: { state: 'absent' },
          output: { state: 'text', json: 'ok' },
        },
        { sequence: 4, runId: 'run-1' },
      ),
    )
    expect(settled.outcome).toEqual({ status: 'applied' })
    expect(settled.view.timeline.find((entry) => entry.kind === 'tool')).toMatchObject({ status: 'completed' })
    expect(settled.view.state).toBe('cancelled')

    // An update that would put the call back into progress is the run coming back, and is
    // refused like the text.
    expect(
      dropReason(
        settled.view,
        frame(
          'tool-update',
          {
            toolCallId: 'call-1',
            title: 'Reading a.md',
            kind: 'read',
            status: 'in_progress',
            paths: [],
            content: [],
            input: { state: 'absent' },
            output: { state: 'absent' },
          },
          { sequence: 5, runId: 'run-1' },
        ),
      ),
    ).toBe('closed-run')

    // And a call the panel never showed cannot arrive with the dead run.
    expect(
      dropReason(
        settled.view,
        frame(
          'tool-update',
          {
            toolCallId: 'call-2',
            title: 'Writing b.md',
            kind: 'edit',
            status: 'completed',
            paths: [],
            content: [],
            input: { state: 'absent' },
            output: { state: 'absent' },
          },
          { sequence: 6, runId: 'run-1' },
        ),
      ),
    ).toBe('closed-run')
  })

  it('applies the next run normally after a cancel', () => {
    const next = startAgentRun(cancelled(liveRun()), 'again').view
    const bound = reduceAgentEvent(next, frame('text-delta', { text: 'second answer' }, { sequence: 4, runId: 'run-2' }))
    expect(bound.outcome).toEqual({ status: 'applied' })
    expect(bound.view.state).toBe('running')
    expect(bound.view.runId).toBe('run-2')
    // The user's own row followed the run: it was written before the run had a name.
    expect(bound.view.timeline.filter((entry) => entry.kind === 'user').at(-1)?.runId).toBe('run-2')
  })

  it('refuses the content of a run that is neither bound nor closed', () => {
    const frameOfRun = frame('text-delta', { text: 'x' }, { sequence: 2, runId: 'run-9' })
    expect(dropReason(liveRun(), frameOfRun)).toBe('other-run')
  })

  it('refuses turn content that names no turn', () => {
    const unattributed = frame('text-delta', { text: 'x' }, { sequence: 2, runId: null })
    expect(dropReason(liveRun(), unattributed)).toBe('unattributed-run')
  })

  it('refuses turn content for a run that was never started', () => {
    // A frame arriving while the view is ready has nothing that could have authorised it:
    // only the store opening a run is what lets one bind, which is what stops a stray frame
    // from beginning a run the user never asked for.
    const stray = frame('text-delta', { text: 'x' }, { sequence: 1, runId: 'run-1' })
    expect(dropReason(fresh(), stray)).toBe('illegal-transition')
  })
})

describe('the state machine', () => {
  it('waits on a permission and resumes on the answer', () => {
    const asked = reduceAgentEvent(
      liveRun(),
      frame(
        'permission-request',
        { requestId: 'req-1', toolCallId: 'call-1', title: 'Run a command?', input: { state: 'absent' }, content: [], options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }] },
        { sequence: 2, runId: 'run-1' },
      ),
    )
    expect(asked.view.state).toBe('waiting-permission')
    expect(asked.view.permissions).toHaveLength(1)

    const answered = resolvePermission(asked.view, 'req-1')
    expect(answered.accepted).toBe(true)
    expect(answered.view.state).toBe('running')
    expect(answered.view.permissions).toHaveLength(0)
  })

  it('refuses an answer for a request the view does not hold', () => {
    const answered = resolvePermission(liveRun(), 'req-unknown')
    expect(answered.accepted).toBe(false)
    expect(answered.view.runId).toBe('run-1')
  })

  it('refuses an answer for a request whose run is no longer the live one', () => {
    const asked = reduceAgentEvent(
      liveRun(),
      frame(
        'permission-request',
        { requestId: 'req-1', toolCallId: 'call-1', title: 'Run a command?', input: { state: 'absent' }, content: [], options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }] },
        { sequence: 2, runId: 'run-1' },
      ),
    ).view
    // The turn ended without an answer, so the request it left is dead — and so is the
    // button that would have answered it.
    const ended = endRun(asked, 'run-1', 'cancelled')
    expect(ended.permissions).toHaveLength(0)
  })

  it('stays waiting while another request of the same run is unanswered', () => {
    const ask = (view: AgentSessionView, requestId: string, sequence: number): AgentSessionView =>
      reduceAgentEvent(
        view,
        frame(
          'permission-request',
          { requestId, toolCallId: 'call-1', title: 'Run a command?', input: { state: 'absent' }, content: [], options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }] },
          { sequence, runId: 'run-1' },
        ),
      ).view
    const second = ask(ask(liveRun(), 'req-1', 2), 'req-2', 3)
    expect(second.permissions).toHaveLength(2)
    // A turn can ask about several calls. Resuming on the first answer would offer a send
    // button for a run that is still suspended on the second.
    const answered = resolvePermission(second, 'req-1')
    expect(answered.accepted).toBe(true)
    expect(answered.view.state).toBe('waiting-permission')
    expect(resolvePermission(answered.view, 'req-2').view.state).toBe('running')
  })

  it('refuses a second run while one is live, and allows one after it ended', () => {
    const live = liveRun()
    expect(startAgentRun(live, 'and another thing').accepted).toBe(false)
    expect(startAgentRun(live, 'and another thing').view).toBe(live)
    expect(startAgentRun(cancelled(live), 'again').accepted).toBe(true)
  })

  it("keeps the user's text when a run is refused", () => {
    // The store turns the refusal into the draft; the reducer's job is only that the text
    // is not in the timeline twice and the state did not move.
    const live = liveRun()
    const refused = startAgentRun(live, 'second')
    expect(refused.view.timeline.filter((entry) => entry.kind === 'user')).toHaveLength(1)
  })

  for (const stopReason of AGENT_STOP_REASONS) {
    it(`ends a run through run-finished for '${stopReason}', never as a failure`, () => {
      const ended = reduceAgentEvent(
        liveRun(),
        frame('run-finished', { stopReason, usage: null }, { sequence: 2, runId: 'run-1' }),
      )
      expect(ended.outcome).toEqual({ status: 'applied' })
      expect(ended.view.state).toBe(stopReason === 'cancelled' ? 'cancelled' : 'completed')
      // A token ceiling and a refusal are how a turn ends, not failures — and the reason is
      // kept, so "completed" does not flatten four different endings into one.
      expect(ended.view.state).not.toBe('failed')
      expect(ended.view.lastResult?.stopReason).toBe(stopReason)
      expect(ended.view.failure).toBeNull()
    })
  }

  it('ends the run as completed when the ending’s reason is one this version does not know', () => {
    // The arm `AGENT_STOP_REASONS` deliberately does not contain: the frame is a completed turn's
    // ending with a reason the contract has never seen, and the run is over either way. It is a
    // `completed` run and not a `failed` one — reporting a decode problem as a fault of the turn
    // is the outcome the whole arm exists to prevent — and the reason keeps its own state in
    // `lastResult`, so nothing here reads as an ordinary `end-turn`.
    const ended = reduceAgentEvent(
      liveRun(),
      frame(
        'run-finished',
        { stopReason: 'unrecognised', unrecognisedReason: 'budget_exceeded', usage: null },
        { sequence: 2, runId: 'run-1' },
      ),
    )

    expect(ended.outcome).toEqual({ status: 'applied' })
    expect(ended.view.state).toBe('completed')
    expect(ended.view.failure).toBeNull()
    expect(ended.view.lastResult).toEqual({
      stopReason: 'unrecognised',
      unrecognisedReason: 'budget_exceeded',
      usage: null,
    })
  })

  it('fails the run through run-failed, and drops the questions it left', () => {
    const asked = reduceAgentEvent(
      liveRun(),
      frame(
        'permission-request',
        { requestId: 'req-1', toolCallId: 'call-1', title: 'Run a command?', input: { state: 'absent' }, content: [], options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }] },
        { sequence: 2, runId: 'run-1' },
      ),
    ).view
    const failed = reduceAgentEvent(
      asked,
      frame('run-failed', { code: 'process-exited', message: 'the runtime exited' }, { sequence: 3, runId: 'run-1' }),
    )
    expect(failed.view.state).toBe('failed')
    expect(failed.view.failure).toEqual({ code: 'process-exited', message: 'the runtime exited' })
    expect(failed.view.permissions).toHaveLength(0)
  })

  it('refuses a second ending for the same run', () => {
    expect(
      dropReason(
        cancelled(liveRun()),
        frame('run-finished', { stopReason: 'end-turn', usage: null }, { sequence: 3, runId: 'run-1' }),
      ),
    ).toBe('closed-run')
  })

  it('clears the previous failure when the next run starts', () => {
    const failed = reduceAgentEvent(
      liveRun(),
      frame('run-failed', { code: 'timeout', message: 'no answer' }, { sequence: 2, runId: 'run-1' }),
    ).view
    expect(failed.failure).not.toBeNull()
    expect(startAgentRun(failed, 'again').view.failure).toBeNull()
  })
})

describe('frames the memory double actually produced', () => {
  /**
   * Everything the double hands a subscriber, reduced in the order it arrived — the whole
   * pipeline the store runs, without the store. The three steps that matter are the store's:
   * snapshot, subscribe from it, and then open the run *before* asking for it, so the
   * turn's opening frames land in a view that already knows a run is in flight.
   */
  async function runThroughDouble(
    text: string,
    script: MemoryRunScript,
    act: (gateway: MemoryAgentGateway, session: AgentSession) => Promise<void>,
  ): Promise<AgentSessionView> {
    const gateway = createMemoryAgentGateway({ agentId: IDENTITY.agentId, profileId: IDENTITY.profileId })
    await gateway.start()
    const session = await gateway.openSession({ vaultId: IDENTITY.vaultId, cwd: '/tmp/vault' })
    gateway.script(script)
    const from = await gateway.snapshot(session)
    const adopted = adoptSnapshot(fresh(), from)
    expect(adopted.outcome).toEqual({ status: 'adopted' })
    let view = startAgentRun(adopted.view, text).view
    const unsubscribe = await gateway.subscribe(from, (event) => {
      view = reduceAgentEvent(view, event).view
    })
    await act(gateway, session)
    unsubscribe()
    return view
  }

  it("does not revive a run the user cancelled, even though its late frames arrive", async () => {
    const view = await runThroughDouble('start something long', { hang: true }, async (gateway, session) => {
      const run = gateway.prompt(session, 'start something long')
      // The double holds the turn open until it is cancelled.
      await gateway.cancel(session)
      await run
      // The protocol says a client SHOULD keep accepting a cancelled run's final frames, and
      // the double delivers one, tagged with the dead run's id.
      gateway.emit(session, { kind: 'text-delta', payload: { text: ' still typing' }, runId: 'run-1' })
    })
    expect(view.state).toBe('cancelled')
    // The late chunk is not in the transcript, and the run did not come back.
    expect(view.timeline.some((entry) => 'text' in entry && entry.text.includes('still typing'))).toBe(false)
  })

  it('drops nothing a running turn legitimately produced', async () => {
    const view = await runThroughDouble('hello', { chunks: ['a', 'b', 'c'] }, async (gateway, session) => {
      await gateway.prompt(session, 'hello')
    })
    expect(view.state).toBe('completed')
    expect(view.timeline.filter((entry) => entry.kind === 'text')).toHaveLength(1)
    expect(view.timeline.filter((entry) => 'text' in entry).at(-1)?.text).toBe('abc')
    expect(view.lastResult?.stopReason).toBe('end-turn')
  })
})
