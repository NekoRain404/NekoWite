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
  AgentCapabilityFeature,
  AgentCapabilityFinding,
  AgentConfigChoice,
  AgentConfigOption,
  AgentEventKind,
  AgentIdentity,
  AgentModelOption,
  AgentPayloads,
  AgentPermissionOption,
  AgentStopReason,
  AgentToolContent,
  AgentToolInput,
  AgentUsage,
} from '../agent-contracts'

/**
 * The choices of the `model` option the double's engine publishes. Two of them, so a
 * test can make a real switch rather than set the only model to itself.
 */
const MEMORY_MODEL_CHOICES: AgentConfigChoice[] = [
  { value: 'memory-echo', name: 'Memory (echo)' },
  { value: 'memory-quiet', name: 'Memory (quiet)' },
]

/**
 * The config option the catalog below is projected from — what the engine returns
 * with a session (`configOptions[model]`, P0 §2.2).
 *
 * Exported so a test can hold the session's catalog to the option it projects: the
 * double derives one from the other instead of keeping two copies of one wire value
 * that could drift.
 */
export const MEMORY_MODEL_OPTION: AgentConfigOption = {
  id: 'model',
  name: 'Model',
  value: {
    kind: 'select',
    current: MEMORY_MODEL_CHOICES[0].value,
    choices: MEMORY_MODEL_CHOICES,
  },
}

/**
 * The catalog the session handle exposes: the option's choices, projected — a
 * choice's `value` is the model's id and its `name` is the label, which is the
 * projection an adapter makes of the same wire data.
 */
export const MEMORY_MODELS: AgentModelOption[] = MEMORY_MODEL_CHOICES.map((choice) => ({
  id: choice.value,
  name: choice.name,
}))

/** The option's current value when the session opens. */
export const MEMORY_INITIAL_MODEL_ID: string = MEMORY_MODEL_CHOICES[0].value

/** The engine's own id for the model option, so a call can name it without rebuilding it. */
export const MEMORY_MODEL_ID: string = MEMORY_MODEL_OPTION.id

/**
 * The second option the double's engine reports, in the shape the pinned engine's own second
 * option has: `{id: "mode", name: "Session Mode", currentValue: "build", options: [build,
 * plan]}` (measured against the real engine — `agent_session_lifecycle_test.rs`'s probe).
 *
 * It is here for the reason the model option is: the double stands for the engine this app
 * ships against, and the row it drives is built from what the engine reports. An engine with a
 * mode selector beside its model selector is the case the control row exists for, and a double
 * with one option would exercise half of it.
 */
export const MEMORY_MODE_OPTION: AgentConfigOption = {
  id: 'mode',
  name: 'Session Mode',
  value: {
    kind: 'select',
    current: 'build',
    choices: [
      { value: 'build', name: 'Build' },
      { value: 'plan', name: 'Plan' },
    ],
  },
}

/**
 * What a session opens with, in the engine's order — the list the handle carries and the list a
 * move publishes back.
 */
export const MEMORY_OPTIONS: readonly AgentConfigOption[] = [MEMORY_MODEL_OPTION, MEMORY_MODE_OPTION]

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
  /**
   * What the capability report says about a feature, for the features a test names.
   *
   * Empty by default, and the empty default is the truthful one: this double has
   * measured nothing — there is no engine behind it — so every feature is
   * `unverified` until a test says otherwise (§3.4's row: a capability nobody
   * observed is not one to report as available). The declaration half is always
   * `unverified` here for the same reason: a double has no installation to declare
   * anything.
   */
  capabilities?: Partial<Record<AgentCapabilityFeature, AgentCapabilityFinding>>
}

/**
 * The finding a feature gets when nothing declared one.
 *
 * Exported because the gateway composing this scenario is a different module: a default that a page
 * reads as a row belongs beside the table it comes from, not beside the loop that adds up the
 * report — the same split `memory-pet/scenario.ts` makes for its own findings.
 */
export function unverifiedCapability(feature: AgentCapabilityFeature): AgentCapabilityFinding {
  return {
    status: 'unverified',
    detail: `${feature} has not been measured: nothing in this double has talked to an engine`,
  }
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
  permission?: {
    title: string
    options: AgentPermissionOption[]
    input?: AgentToolInput
    /**
     * The content blocks the request itself carries, in the contract's shapes — a proposed
     * edit's diff among them. Default: none, which is what a request that proposes no
     * change says.
     *
     * It is a field of the *request* and not a row it is paired with on purpose: the two
     * can differ, and a script whose point is that the prompt draws the request's own
     * blocks (that the request is the first frame to carry them) has to be able to say so.
     */
    content?: AgentToolContent[]
    /**
     * The tool call this request is about. Optional so a script that does not
     * care still gets a paired id; a script that wants to test the pairing —
     * a prompt for a row the timeline already shows — sets it.
     */
    toolCallId?: string
  }
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
