/**
 * A turn's liveness: how the latch on a session is released, and what a refusal is called.
 *
 * `tauri-agent.ts` holds one turn per session — the latch §6.2's "one active generation per
 * session" is enforced with — and a turn ends as an *event*: `prompt` waits for the
 * `run-finished` / `run-failed` frame that closes it. A turn whose ending is never published
 * therefore used to leave the latch closed for the life of the session, with nothing in this app
 * able to recover it. That state was reached by an instrument rather than reasoned about:
 * `e2e/webkit/probe-agent-scroll.mjs`'s own comment records it against the stand-in host ("its own
 * bookkeeping still holds one in flight while the snapshot it hands a re-subscription says the
 * session is ready; the adapter then refuses the next prompt with `buffer-conflict` BEFORE any
 * call goes out"), and the instrument's workaround was to end the stand-in's turn by hand.
 *
 * Three facts are asserted here, one group each:
 *
 *  - **Everything that proves no turn is in flight releases the latch.** The ending frame is
 *    covered in `tauri-agent.test.ts`; what is added here is a session the engine has let go
 *    (`closeSession`) and the runtime being over (`stop`). Deliberately *not* in that set is
 *    `cancel`: this repository's own ruling is that a cancel is a request and not an outcome
 *    (`features/agent/stores/agent-session.ts`: "Marking it locally would be the host claiming an
 *    ending it has not been told about"), so a cancel that returned cannot vouch for a session
 *    whose turn may still be live. The engine death the brief names is covered twice over — as the
 *    host's `run-failed` frame, and as a rejected `ipc.prompt` — and both already released; what a
 *    host that says *nothing* leaves behind is the last group below.
 *  - **A latch held past the runtime's own bound is reported rather than kept.** `runs.rs` bounds a
 *    generation (`PROMPT_BOUND`), so a turn outliving that bound by a delivery allowance is one the
 *    host is no longer going to end, and this window fails it with `timeout` instead of waiting
 *    forever. The two numbers are held together by a test that reads the Rust source, because the
 *    way this window could do harm is by firing *before* the host's own net — that would kill a
 *    live turn rather than report a dead one.
 *  - **The refusal names its condition.** `turn-in-flight`, not `buffer-conflict`, which is this
 *    contract's word for a buffering collision (`agent-event-reducer.ts` uses it for the capacity
 *    abort, `channel.ts` for an unreplayable sequence) and told every reader — the user, and the
 *    next person reading the source — the wrong thing.
 *
 * What does not change is the latch's *strength*: a second turn on one session is still refused,
 * and a stale turn cannot release the latch of the turn that replaced it. That last one is the
 * reason the latch is a map from a session to the turn holding it rather than a set of session ids:
 * a release that could free someone else's latch would be the protocol violation the latch exists
 * to prevent, so it would be a repair that imports a defect.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentFailure, type AgentSession } from '../agent-contracts'
import { createTauriAgentGateway } from '../tauri-agent'
import type { AgentHostSnapshot, AgentIpc } from './ipc'
import { HOST_TURN_BOUND_MS, TURN_LIVENESS_BOUND_MS } from './turn-bound'

const IDENTITY = {
  agentId: 'opencode',
  profileId: 'default',
  runtimeEpoch: 'epoch-1',
  vaultId: 'vault-1',
  sessionId: 'ses-1',
}

const OPEN_REQUEST = { vaultId: 'vault-1', cwd: '/vault' }

interface FakeIpc extends AgentIpc {
  /** Every call the adapter made, in order, by method name. */
  calls: string[]
  /** Push one envelope at the listener the adapter registered. */
  push(frame: Record<string, unknown>): void
  /**
   * How `agent_prompt` answers from here on.
   *
   * Separate from the call itself, because the two are different facts and a test needs them
   * apart: whether the send *reached the host* is what several of these assert, and a test that
   * replaced the method wholesale to change its answer would also be replacing the recorder —
   * leaving an assertion about a call that went out reading a list that never saw it.
   */
  answerPromptWith(answer: () => Promise<string>): void
}

/**
 * A host that stands for the case this file is about: it answers every call, and it ends the turn
 * it started **only if a test says so**. What it never does is invent an ending, which is the host
 * the latch was not surviving — the stand-in the instrument used behaves the same way
 * (`harness.html`: its `agent_prompt` answers a run id and its `agent_cancel_run` returns without
 * ending anything).
 */
function fakeIpc(): FakeIpc {
  const listeners = new Set<(frame: unknown) => void>()
  const calls: string[] = []
  let epoch = 0
  let answer: () => Promise<string> = async () => 'run-1'
  const session = {
    sessionId: IDENTITY.sessionId,
    configOptions: [],
    modelOptionId: null,
  }
  return {
    calls,
    push(frame) {
      for (const listener of [...listeners]) listener(frame)
    },
    answerPromptWith(next) {
      answer = next
    },
    async start() {
      calls.push('start')
      epoch += 1
      return {
        agentId: IDENTITY.agentId,
        profileId: IDENTITY.profileId,
        runtimeEpoch: `epoch-${epoch}`,
      }
    },
    async stop() {
      calls.push('stop')
    },
    async openSession() {
      calls.push('openSession')
      return session
    },
    async loadSession() {
      calls.push('loadSession')
      return session
    },
    async listSessions() {
      calls.push('listSessions')
      return { sessions: [], nextCursor: null }
    },
    async closeSession() {
      calls.push('closeSession')
    },
    async selectModel() {
      calls.push('selectModel')
    },
    async prompt() {
      calls.push('prompt')
      return answer()
    },
    async cancel() {
      calls.push('cancel')
    },
    async answerPermission() {
      calls.push('answerPermission')
    },
    async snapshot(): Promise<AgentHostSnapshot> {
      calls.push('snapshot')
      return {
        identity: IDENTITY,
        state: 'ready',
        runId: null,
        sequence: 0,
        events: [],
        permissions: [],
      }
    },
    async capabilities() {
      calls.push('capabilities')
      return []
    },
    async onEvent(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

async function openSessionOn(
  gateway: ReturnType<typeof createTauriAgentGateway>,
): Promise<AgentSession> {
  await gateway.start()
  return gateway.openSession(OPEN_REQUEST)
}

/** Let the adapter's own awaits finish — the channel registration, the prompt call — in a turn or
 *  two of the microtask queue, on a clock the bound below is driven by. */
async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
  for (let round = 0; round < 4; round += 1) await Promise.resolve()
}

function promptCount(ipc: FakeIpc): number {
  return ipc.calls.filter((call) => call === 'prompt').length
}

/** One promise a test settles by hand: how a host that answers nothing — for a while, or for good —
 *  looks from the adapter's side. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  // The bound is minutes long, so a test that leaves a turn open would otherwise leave a real
  // timer behind it. The clock is faked for the whole file and advanced where it means something.
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the refusal', () => {
  it('names the condition — a turn in flight — rather than a buffer collision', async () => {
    const ipc = fakeIpc()
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)

    const first = gateway.prompt(session, 'one')
    first.catch(() => {})
    await settle()

    // §6.2's one generation per session, and the reason the code matters: `buffer-conflict` is what
    // this contract says when a *stream* cannot be continued (`channel.ts`) or a view has outgrown
    // what the host will hold (`agent-event-reducer.ts`), so a reader told that a send was refused
    // for a buffering collision has been told the wrong fact about the wrong layer.
    await expect(gateway.prompt(session, 'two')).rejects.toMatchObject({
      code: 'turn-in-flight',
      message: expect.stringContaining('already has a turn in flight'),
    })
    // Nothing went out behind the refusal: the refused turn is the one that never reaches the host.
    expect(promptCount(ipc)).toBe(1)
  })
})

describe('the latch’s release', () => {
  it('frees a session the engine has let go, and ends the turn it was running', async () => {
    const ipc = fakeIpc()
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)

    const turn = gateway.prompt(session, 'one')
    await settle()

    // The ending this window was waiting for cannot arrive any more: `agent_close_session` drops
    // the host's session slot, and `runs.rs`'s `finish_run` emits nothing for a slot that is gone.
    // So the turn is ended here rather than abandoned, in the words `stop` uses for a runtime —
    // a turn that was stopped rather than finished. The expectation is taken before the close, so
    // the rejection has a handler the moment it happens (this suite fails on an unhandled one).
    const ended = expect(turn).rejects.toMatchObject({ code: 'cancelled' })
    await gateway.closeSession(session.sessionId)
    await settle()
    await ended

    // And the session itself is free: the reader can go back to the row they freed, reopen it and
    // send again — the whole of what a held latch was taking away.
    const reopened = await gateway.loadSession(session.sessionId, OPEN_REQUEST)
    const second = gateway.prompt(reopened, 'two')
    second.catch(() => {})
    await settle()
    expect(promptCount(ipc)).toBe(2)
  })

  it('frees every session a runtime held, including one whose prompt was never answered', async () => {
    // A host that never answers `agent_prompt` at all: the run has not reached the pending table
    // when the runtime goes down, so the path that ends the pending turns has nothing to end — and
    // the latch this turn took before that call is what a later session would be refused by.
    // `stop` is the proof that no turn from that runtime can be in flight, whatever the bookkeeping
    // was in the middle of: the runtime is over, and every turn it held is over with it.
    const ipc = fakeIpc()
    ipc.answerPromptWith(() => new Promise<string>(() => {}))
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)

    const wedged = gateway.prompt(session, 'one')
    wedged.catch(() => {})
    await settle()

    await gateway.stop()
    await gateway.start()
    const reopened = await gateway.loadSession(session.sessionId, OPEN_REQUEST)
    const second = gateway.prompt(reopened, 'two')
    second.catch(() => {})
    await settle()

    expect(promptCount(ipc)).toBe(2)
  })

  it('will not let a stale turn release the latch of the turn that replaced it', async () => {
    // Two turns on one session id, where the first one's failure lands *after* the second took the
    // latch: the runtime was stopped under it, its own call then failed. A release matched on the
    // session id alone would free a latch it no longer owns, and what that costs is the
    // interleaving §6.2 forbids — two runs' text in one stream with nothing to tell them apart.
    const first = deferred<string>()
    const second = deferred<string>()
    let calls = 0
    const ipc = fakeIpc()
    ipc.answerPromptWith(() => {
      calls += 1
      return calls === 1 ? first.promise : second.promise
    })
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)

    const stale = gateway.prompt(session, 'one')
    stale.catch(() => {})
    await settle()

    await gateway.stop()
    await gateway.start()
    const reopened = await gateway.loadSession(session.sessionId, OPEN_REQUEST)
    const live = gateway.prompt(reopened, 'two')
    live.catch(() => {})
    await settle()

    // The runtime the first turn was sent to is gone, so its call fails now — long after the latch
    // was handed to the second turn.
    first.reject(new AgentFailure('process-exited', 'the engine exited'))
    await settle()

    await expect(gateway.prompt(reopened, 'three')).rejects.toMatchObject({
      code: 'turn-in-flight',
    })
    expect(promptCount(ipc)).toBe(2)
  })
})

describe('the bound on a turn', () => {
  it('reports a turn whose ending never arrives as timed out, and frees the session', async () => {
    const ipc = fakeIpc()
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)

    const turn = gateway.prompt(session, 'one')
    await settle()

    // No frame, no stop, no close: nothing has been said about this turn since it started, and the
    // host's own bound on a generation has passed with its allowance on top. The turn is reported
    // rather than waited on — `timeout` is this vocabulary's word for exactly this condition
    // (`events.rs`: "no answer within the caller's bound"), and it is the code the host would have
    // used had its own net fired. The expectation is taken first, for the reason the close test
    // gives.
    const expired = expect(turn).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(TURN_LIVENESS_BOUND_MS)
    await expired

    const second = gateway.prompt(session, 'two')
    second.catch(() => {})
    await settle()
    expect(promptCount(ipc)).toBe(2)
  })

  it('covers a host that never answers the call, not only one that never ends the turn', async () => {
    // The bound has to hold over the whole of a turn, and a turn starts with a call: a host whose
    // `agent_prompt` never comes back has no run id yet, nothing in the pending table, and — from
    // the latch's side — a session held open by a turn that exists only as an outstanding promise.
    // That is the state `stop`'s own release exists for, and it is reachable without one: the
    // deadline has to end the turn *and* settle the promise a user is waiting on.
    const ipc = fakeIpc()
    const call = deferred<string>()
    ipc.answerPromptWith(() => call.promise)
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)

    const turn = gateway.prompt(session, 'one')
    await settle()

    const expired = expect(turn).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(TURN_LIVENESS_BOUND_MS)
    await settle()

    // The call comes back *after* the bound. The run it names is already over as far as this
    // window is concerned — and the turn is reported as the timeout it was, rather than as the
    // frame-less wait it would otherwise still be.
    call.resolve('run-1')
    await expired

    const second = gateway.prompt(session, 'two')
    second.catch(() => {})
    await settle()
    expect(promptCount(ipc)).toBe(2)
  })

  it('takes the bound away when the turn ends, so a finished turn leaves no timer behind', async () => {
    // The other side of the same number. A turn that *does* end must take its deadline with it: a
    // timer left armed would fire into a session that had long since gone idle and report a turn
    // that is not there — the failure a bound can cause by being merely undismantled.
    const ipc = fakeIpc()
    const gateway = createTauriAgentGateway({ vaultId: 'vault-1', ipc })
    const session = await openSessionOn(gateway)

    const turn = gateway.prompt(session, 'one')
    await settle()
    ipc.push({
      ...IDENTITY,
      runId: 'run-1',
      sequence: 1,
      kind: 'run-finished',
      payload: { stopReason: 'end-turn', usage: null },
    })
    await expect(turn).resolves.toMatchObject({ stopReason: 'end-turn' })

    // No timer survives the turn, so there is nothing left that could reach a session in its name.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps this window’s bound above the runtime’s own, where the number comes from', () => {
    // The one way this bound can do harm is by firing while the host's own net could still end the
    // turn: that would kill a live generation and report it as timed out. The number is therefore
    // the host's own plus an allowance for an ending to cross the channel — and the host's own is
    // `runs.rs`'s, read here rather than restated, so a change to it fails this test instead of
    // silently moving this window's deadline below it.
    const source = readFileSync(
      resolve(__dirname, '../../../../src-tauri/src/agent_runtime/runs.rs'),
      'utf8',
    )
    const declared = /const PROMPT_BOUND: Duration = Duration::from_secs\(([^)]+)\)/.exec(source)
    expect(declared, 'PROMPT_BOUND is not declared in runs.rs').not.toBeNull()
    const seconds = (declared?.[1] ?? '')
      .split('*')
      .map((part) => Number(part.trim()))
      .reduce((product, factor) => product * factor, 1)
    expect(seconds, 'PROMPT_BOUND is not a number of seconds').toBeGreaterThan(0)

    expect(HOST_TURN_BOUND_MS).toBe(seconds * 1000)
    expect(TURN_LIVENESS_BOUND_MS).toBeGreaterThan(HOST_TURN_BOUND_MS)
  })
})
