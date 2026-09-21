/**
 * The in-memory agent gateway: a runtime a test drives by hand.
 *
 * It exists so the feature layer can be written and tested with no process, no
 * network call and no credential — and, more to the point, so the awkward cases are
 * *representable*: a turn that refuses, a turn cancelled while it waits for an
 * answer, a runtime that dies mid-turn, and frames that arrive late — from a runtime
 * instance that is over, from a run that already ended, with a sequence already
 * used, or for the vault the user just left. A reducer can only be written against
 * states a double can actually produce.
 *
 * The frames it hands out pass `readAgentEvent` on the way out, so the double cannot
 * invent an event the contract does not allow. What it *can* do, deliberately, is
 * stamp a foreign identity on one: that is the late-frame case, and refusing to
 * model it would be refusing to model the race.
 *
 * What it deliberately does not produce: `timeout`, `authentication-required` and
 * `protocol-incompatible` are failures of a real runtime's startup and transport
 * (T2/T4 report them), and nothing here models a process that is slow to answer,
 * unauthenticated or speaking a different protocol version.
 */

import type { AgentGateway, AgentSession } from '../agent-contracts'
import type { MemoryAgentOptions, MemoryEvent, MemoryRunScript } from './scenario'
import { createLiveRuntime, crashRuntime, startRuntime, stopRuntime } from './runtime'
import { closeSession, listSessions, loadSession, openSession } from './session-lifecycle'
import { selectModel, setConfigOption } from './session-options'
import { answerPermission, cancel, emit, prompt, setScript } from './turn-flow'
import { capabilities, recoverChange, snapshot, subscribe } from './session-reads'

export {
  MEMORY_MODE_OPTION,
  MEMORY_MODEL_ID,
  MEMORY_MODEL_OPTION,
  MEMORY_OPTIONS,
} from './scenario'
export type {
  MemoryAgentOptions,
  MemoryEvent,
  MemoryEventPatches,
  MemoryRunScript,
} from './scenario'

export interface MemoryAgentGateway extends AgentGateway {
  /** Set what subsequent turns do; see {@link MemoryRunScript}. */
  script(script: MemoryRunScript): void
  /**
   * Emit one event out of band, as the runtime would if the frame had been queued,
   * replayed or misdelivered. The frame still has to be a valid event — only its
   * identity, run and sequence may be foreign.
   */
  emit(session: AgentSession, event: MemoryEvent): void
  /**
   * The runtime died. Turns in flight fail with `process-exited` and everything that
   * needs the engine rejects until `start` brings a new runtime up; reads of a
   * session still work, because the session's last known state outlives the process
   * that produced it.
   */
  crash(message?: string): void
}

/**
 * The one factory, and it decides nothing: it boxes the runtime's state and hands each of
 * the contract's calls to the module that is about it. Which failures a call may answer
 * with, and when, lives beside the state that condition is read from — `runtime.ts` for the
 * epoch and the handle rules, `session-lifecycle.ts` for the engine's table,
 * `session-options.ts` for the published options, `turn-flow.ts` for a turn,
 * `session-reads.ts` for what may be answered without changing one.
 */
export function createMemoryAgentGateway(options: MemoryAgentOptions): MemoryAgentGateway {
  const runtime = createLiveRuntime(options)
  return {
    start: () => startRuntime(runtime),
    stop: () => stopRuntime(runtime),
    openSession: (request) => openSession(runtime, request),
    listSessions: (cursor) => listSessions(runtime, cursor),
    loadSession: (sessionId, request) => loadSession(runtime, sessionId, request),
    closeSession: (sessionId) => closeSession(runtime, sessionId),
    setConfigOption: (session, configId, value) =>
      setConfigOption(runtime, session, configId, value),
    selectModel: (session, modelId) => selectModel(runtime, session, modelId),
    prompt: (session, text, attachments) => prompt(runtime, session, text, attachments),
    recoverChange: (session, path) => recoverChange(runtime, session, path),
    cancel: (session) => cancel(runtime, session),
    answerPermission: (session, requestId, optionId) =>
      answerPermission(runtime, session, requestId, optionId),
    capabilities: (session) => capabilities(runtime, session),
    snapshot: (session) => snapshot(runtime, session),
    subscribe: (from, onEvent) => subscribe(runtime, from, onEvent),
    script: (next) => setScript(runtime, next),
    emit: (session, event) => emit(runtime, session, event),
    crash: (message) => crashRuntime(runtime, message),
  }
}
