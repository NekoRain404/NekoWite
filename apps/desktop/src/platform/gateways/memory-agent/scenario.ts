/**
 * What a test asks the double for: how the runtime is set up, what its turns do,
 * and which frames it injects by hand.
 *
 * Kept apart from the machinery that carries these out (`session.ts`) and from
 * the gateway that exposes them (`memory-agent.ts`) because this file is the part
 * a test author reads first, and the part that has to stay complete: an event a
 * test cannot inject is an event no reducer can be written against.
 */

import type {
  AgentEventKind,
  AgentIdentity,
  AgentPayloads,
  AgentPermissionOption,
  AgentStopReason,
  AgentToolInput,
  AgentUsage,
} from '../agent-contracts'

/**
 * The catalog the double publishes. Two entries, so a test can make a real switch
 * rather than set the only model to itself.
 */
export const MEMORY_MODELS = [
  { id: 'memory-echo', name: 'Memory (echo)' },
  { id: 'memory-quiet', name: 'Memory (quiet)' },
]

/** How many events stay replayable by default. */
export const DEFAULT_REPLAY_LIMIT = 64

export interface MemoryAgentOptions {
  /**
   * Which agent and profile this runtime belongs to. Required rather than
   * defaulted because they are half of the event identity: a double that picked
   * them quietly could not stand for two agents whose same-named sessions must not
   * be confused (§6.1).
   */
  agentId: string
  profileId: string
  /**
   * How many events stay replayable. A small value lets a test drive the
   * `buffer-conflict` path, which is the one case where the host has to admit it
   * cannot fill a gap.
   */
  replayLimit?: number
}

/**
 * What the turns after this call do. The default turn answers with the prompt text
 * and ends normally, which is what most tests want; everything else is asked for
 * explicitly.
 */
export interface MemoryRunScript {
  /** Text chunks to stream, in order. Default: one chunk, the prompt text. */
  chunks?: string[]
  /**
   * Ask for permission mid-turn: the turn emits these options and stays in
   * `waiting-permission` until it is answered, so the answer path is exercised
   * against a genuinely suspended turn rather than a canned payload.
   *
   * `input` defaults to `{ state: 'absent' }` and exists so a test can drive the
   * other two states the contract keeps apart — arguments to show, and arguments the
   * host could not read — because §6.3's prompt has to say which of the two it is.
   */
  permission?: { title: string; options: AgentPermissionOption[]; input?: AgentToolInput }
  /**
   * Keep the turn open until it is cancelled, crashed or stopped. This is the only
   * window a scripted turn is interruptible in: without it the turn emits its
   * chunks and finishes in one synchronous burst, and a cancel would arrive after
   * there was anything left to cancel.
   */
  hang?: boolean
  stopReason?: AgentStopReason
  usage?: AgentUsage | null
}

/**
 * The fields a test overrides to make an emitted event late, duplicated or
 * foreign. They exist because the runtime is not the only place events come from:
 * a queued frame, a replay after a restart or a frame that crossed a vault switch
 * arrives with an identity that is not the current session's — and the events a
 * window must reject are exactly as important to test as the ones it must render.
 */
export interface MemoryEventPatches {
  /**
   * The run the event claims. Set it to a run that has already ended to model a
   * chunk arriving after the cancel it must not revive (§6.2).
   */
  runId?: string | null
  /**
   * Reuse a sequence to model a duplicate frame, or skip one to model a frame lost
   * between the runtime and the host.
   */
  sequence?: number
  /**
   * Carry the rest of the identity as another runtime instance, agent, profile or
   * vault would. The session id is excluded because `emit` already addresses one
   * session: an event about a different session is one a subscriber must never see
   * through this one.
   */
  identity?: Partial<Omit<AgentIdentity, 'sessionId'>>
}

/**
 * An event to emit out of band, with the correlation between kind and payload that
 * the patches cannot break.
 */
export type MemoryEvent = {
  [K in AgentEventKind]: { kind: K; payload: AgentPayloads[K] } & MemoryEventPatches
}[AgentEventKind]
