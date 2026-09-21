/**
 * How a turn ended, and what it spent.
 *
 * One subject with two halves that arrive together: the prompt response carries both the stop reason
 * and the usage (P0 §2.3), so a change to the protocol's `StopReason` and a change to the counters
 * beside it are one protocol event read twice. The session's own context window and cumulative cost
 * are deliberately *not* here — those are `payloads/context-usage.ts`, a different frame answering a
 * different question.
 */

/**
 * Why a turn ended.
 *
 * The set is the protocol's (ACP `StopReason`), and the last four are *not errors*:
 * a turn that hit a token ceiling, ran out of agent requests, refused to continue,
 * or was cancelled ended the way it was always going to end. They belong to
 * `run-finished`; a run is only `run-failed` when the runtime could not carry it
 * out at all.
 */
export type AgentStopReason =
  | 'end-turn'
  | 'max-tokens'
  | 'max-turn-requests'
  | 'refusal'
  | 'cancelled'

/**
 * Every stop reason above: exported for the adapter that maps them and for the
 * tests that hold the validator to each of them.
 *
 * It is the set the *wire* may spell, which is why {@link AgentRunEnding}'s extra arm is not in
 * it: a frame that literally says `unrecognised` is a word this window does not know like any
 * other, and admitting that spelling here would read the engine's own word as this window's
 * statement about it.
 */
export const AGENT_STOP_REASONS = [
  'end-turn',
  'max-tokens',
  'max-turn-requests',
  'refusal',
  'cancelled',
] as const

/**
 * Why a turn ended, as far as this window can say: the protocol's five reasons, or one arm for an
 * ending whose reason is not among them.
 *
 * The protocol's `StopReason` is `#[non_exhaustive]`, and the engine this app runs against is not
 * a fixed protocol surface (P0 §6.3 measured the usage field set changing between two identical
 * turns), so "the engine ended a turn for a reason this version has never heard of" is a normal
 * frame rather than a corrupt one. It must not be a refusal: this payload is a *completed turn's*
 * ending, and a frame this window cannot read here becomes a failure reported on the turn the
 * engine just finished — the outcome `readers/session.ts` names in the same words about usage.
 * So the *reading* degrades rather than the frame: the ending is accepted and marked as one this
 * version does not know, which is a state a surface renders as neither a success nor a failure.
 *
 * It is deliberately wider than {@link AgentStopReason}, which stays the protocol's own set —
 * the same shape, and for the same reason, as the event kinds being wider than the Rust
 * `AgentEventKind`: a producer states a fact it knows, and only a reader has to admit it does
 * not know one.
 */
export type AgentRunEnding = AgentStopReason | 'unrecognised'

/**
 * What one turn spent, with a field for every counter the engine can report and **no field
 * required**.
 *
 * P0 §6.3 measured the same engine, the same model and the same script twice and got two
 * different sets: `{inputTokens, outputTokens, totalTokens, thoughtTokens}` in one turn, and
 * `{inputTokens, outputTokens, totalTokens, cachedReadTokens}` in the next. `totalTokens` is
 * not the sum either time (1721 + 6 ≠ 8895). So a fixed struct here would be wrong in one of
 * the two directions: filled in, it invents a number the engine never sent (§5.1: an unknown
 * cost is not zero); discarded whole, it throws away the numbers it did send.
 *
 * Each field is therefore optional and independent. **Absent means "not provided"**, which is
 * what a surface has to render — a `?? 0`, or any default, turns a field nobody reported into
 * a zero shown as fact. A reported `0` is kept and is a different thing.
 *
 * `totalTokens` is the engine's own count and is never computed from the other two; that is
 * why it is a field rather than something a caller derives.
 */
export interface AgentUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  /** `thoughtTokens`, `cachedReadTokens` and `cachedWriteTokens` are the counters the wire's
   *  own schema marks optional, and the ones P0 §6.3 measured appearing and disappearing. */
  thoughtTokens?: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
}

export interface AgentRunResult {
  stopReason: AgentRunEnding
  /**
   * The reason's own wording, kept when — and only when — `stopReason` is `unrecognised`: the arm
   * exists so the value behind it is recorded rather than thrown away. It is absent when the
   * reason is one of the five, because there the spelling above *is* the reason.
   *
   * What is kept is the reason as the frame spelled it, which is the engine's own wording in the
   * contract's letters — a node that respells the wire's `_` for a `-` does it before the reader
   * sees the value, and this field must not be read as a verbatim copy of the engine's bytes.
   *
   * The condition is recorded rather than merely visible: a reason which arrives once will arrive
   * again, and the word is what the next arm is written from. Carrying it is also what keeps the
   * two facts apart — "the engine ended this turn and this version does not know why" is not the
   * same statement as "some string arrived", and a container that held only the latter would be
   * the catch-all §6.2 forbids handing to a component.
   */
  unrecognisedReason?: string
  /**
   * null when the engine reported nothing at all. §5.1 allows usage to be shown only when its
   * source is reliable, and an unknown cost has to stay unknown — a zero here would read as a
   * free turn. An object means the engine did report usage, and each of its fields stands on
   * its own: see {@link AgentUsage}.
   */
  usage: AgentUsage | null
}
