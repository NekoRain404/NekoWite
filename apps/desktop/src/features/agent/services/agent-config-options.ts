/**
 * The session's own configuration options: the controls the composer's row draws, and the call
 * a choice travels on.
 *
 * ## Where the options come from, and why there are two reports of them
 *
 * ACP hands a session its options in two places, and this app receives both:
 *
 *  - **with `session/new`**, as that response's `configOptions` — the list the session opened
 *    with, in the engine's order, under the engine's names. The host answers it to the window
 *    (`agent_open_session`), and the adapter reads it into `AgentSession.options`, with the model
 *    catalog projected out of the same read (`tauri-agent/session.ts`).
 *  - **as a `config_option_update` notification**, whenever the engine changes its own options —
 *    measured on the pinned engine after every `session/set_config_option`, and the route a
 *    change the host never asked for travels on. That one reaches the window as a `config-changed`
 *    frame and lands in `AgentSessionView.config` whole, with every option's id, name, kind and
 *    current value (`agent_runtime/events.rs`'s `normalize_update`).
 *
 * The row draws the frames when there are any and the session's own opening list otherwise, and
 * that order is the point rather than a convenience: a frame is the engine's *later* word, and a
 * list that never arrived as a frame is still the engine's. Neither is a default this app chose —
 * the pinned engine reports two options (`{id: "model", name: "Model", currentValue:
 * "opencode/big-pickle"}` and `{id: "mode", name: "Session Mode", currentValue: "build"}`, read
 * off a real session), and a row drawn from only one of the two reports would show half of what
 * the engine says.
 *
 * ## What is movable, and what is not
 *
 * `AgentGateway.setConfigOption(session, configId, value)` moves any option the engine names, by
 * the engine's own id — one protocol call (`session/set_config_option`) behind one boundary
 * (§6.1's handle check), with no per-option branch above it. An engine that reports a third
 * option therefore needs nothing new here.
 *
 * **A boolean option is not movable in this build**, and that is a boundary rather than a
 * preference: the transport wraps every value as a `SessionConfigValueId`
 * (`agent_runtime/acp_transport/calls.rs`), which is a *select* value, so a whether-or-not has no
 * shape to travel in. Such an option is reported as `movable: false` and drawn as a control that
 * is plainly unavailable rather than as one that looks usable and fails when it is pressed (the
 * plan's §7.2 and the maintainer's 「不能让按钮看起来可用、点击后才发现不支持」). It is still
 * drawn, because the session reported it and a row that hid it would be denying a fact about the
 * session.
 */

import type {
  AgentConfigChoice,
  AgentConfigOption,
  AgentFailureCode,
  AgentGateway,
  AgentSession,
} from '../../../platform/gateways/agent-contracts'
import { describeFailure } from './agent-session-subscription'

/**
 * How many choices an option needs before its popup carries a filter box.
 *
 * Zed's own threshold (`zed-main/crates/agent_ui/src/config_options.rs:31`, `PICKER_THRESHOLD`,
 * applied at `:321`), and the reason it is a threshold rather than a rule: a searchable picker
 * for three values asks the reader to type before they may point. The pinned engine's model
 * option reports eighty-nine and its mode option two.
 */
export const AGENT_CONFIG_FILTER_THRESHOLD = 5

/** One control the row draws, whatever the engine called it. */
interface AgentConfigControlFields {
  /** The engine's own id for the option — what a choice addresses on the wire. */
  key: string
  /** The engine's own name for it. */
  name: string
  /** The engine's description, when it sent one. Absent and empty differ. */
  description?: string
  /**
   * Whether this build can move it. False is not "the engine refused": it is "the value has no
   * shape this app's transport can send", and the row draws such a control as unavailable.
   */
  movable: boolean
}

/** A select: one of the engine's own values, or none of them yet. */
export interface AgentConfigSelectControl extends AgentConfigControlFields {
  kind: 'select'
  /** The value the engine says is current — the id, not the name. */
  current: string
  /** What to draw for {@link current}: the current choice's own name, or the raw value when the
   *  engine named no choice for it. Empty when the engine reported no current value at all. */
  currentName: string
  /** The engine's choices, in the engine's order. */
  choices: readonly AgentConfigChoice[]
  /** Whether the popup carries a filter box: {@link AGENT_CONFIG_FILTER_THRESHOLD}. */
  filterable: boolean
}

/** A boolean option: ACP's second kind (`SessionConfigKind::Boolean`). */
export interface AgentConfigToggleControl extends AgentConfigControlFields {
  kind: 'toggle'
  current: boolean
}

export type AgentConfigControl = AgentConfigSelectControl | AgentConfigToggleControl

/** Whether an engine-reported option's current value names one of its own choices. */
function currentChoiceName(choices: readonly AgentConfigChoice[], current: string): string {
  // The raw value when no choice matches, rather than a word for "unknown": the value is the
  // engine's own report and it is still true, even when the list it came with has moved on.
  return choices.find((choice) => choice.value === current)?.name ?? current
}

function toControl(option: AgentConfigOption): AgentConfigControl | null {
  // Every `select` is movable: it carries the engine's own id, and that id is what the call
  // takes. A boolean is not — see the header for the transport's reason.
  const movable = option.value.kind === 'select'
  const shared = {
    key: option.id,
    name: option.name,
    movable,
    ...(option.description === undefined ? {} : { description: option.description }),
  }
  if (option.value.kind === 'select') {
    const { current, choices } = option.value
    return {
      ...shared,
      kind: 'select',
      current,
      currentName: currentChoiceName(choices, current),
      choices,
      filterable: choices.length >= AGENT_CONFIG_FILTER_THRESHOLD,
    }
  }
  if (option.value.kind === 'toggle') {
    return { ...shared, kind: 'toggle', current: option.value.current }
  }
  // Every arm of the contract's `AgentConfigValue` is handled above, so this is unreachable
  // rather than a floor — but a switch over a foreign union written out rather than defaulted is
  // what makes a third kind a compile error here instead of a control that silently vanishes.
  return null
}

/**
 * The controls to draw, in the order to draw them.
 *
 * `reported` is `AgentSessionView.config` — the engine's own frames, in the order the engine sent
 * them — and `session.options` is what the session opened with. The frames win once there are
 * any, because they are the later word: a `config-changed` payload is the full set with its
 * current values, so it replaces rather than merges, and one engine option added mid-session
 * arrives as a control without anything here knowing its name in advance.
 *
 * Nothing is reordered, renamed, filtered or added. What the engine did not report is not drawn:
 * a control this app invented would be an option the session does not have.
 */
export function configControls(
  session: AgentSession,
  reported: readonly AgentConfigOption[],
): AgentConfigControl[] {
  const source = reported.length > 0 ? reported : session.options
  return source
    .map((option) => toControl(option))
    .filter((control): control is AgentConfigControl => control !== null)
}

/** What became of a value the reader chose. */
export type AgentConfigSetOutcome =
  | { accepted: true }
  /** The value has no shape this build can send — an engine's boolean option; see the header.
   *  The row draws such a control as unavailable, so this is the second line of defence rather
   *  than the first. */
  | { accepted: false; reason: 'not-movable' }
  | { accepted: false; reason: 'refused'; code: AgentFailureCode; message: string }

/**
 * Move one of the session's options.
 *
 * A refusal is returned rather than thrown: the caller is a control's choice, and what it has to
 * do with a failed set is show it — the row keeps drawing the engine's current value, because a
 * set that did not happen leaves that value true. Nothing is written optimistically either: the
 * value on the trigger moves when the engine says it has, which is the same path whether this
 * call moved it or the engine did.
 */
export async function setConfigOption(
  gateway: AgentGateway,
  session: AgentSession,
  control: AgentConfigControl,
  value: string | boolean,
): Promise<AgentConfigSetOutcome> {
  if (!control.movable) return { accepted: false, reason: 'not-movable' }
  // A boolean has no shape to travel in — see the header — and the type is checked here rather
  // than cast below, so the refusal is one statement instead of two spellings of it.
  if (control.kind !== 'select' || typeof value !== 'string') {
    return { accepted: false, reason: 'not-movable' }
  }
  try {
    await gateway.setConfigOption(session, control.key, value)
    return { accepted: true }
  } catch (error) {
    return { accepted: false, reason: 'refused', ...describeFailure(error) }
  }
}
