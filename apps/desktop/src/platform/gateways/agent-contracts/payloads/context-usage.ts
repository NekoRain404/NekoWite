/**
 * The session's context window and its cumulative cost, as ACP's `usage_update` reports them.
 *
 * Separate from a run's own usage (`payloads/run-outcome.ts`) because folding the two would make one
 * of them unrepresentable — a turn's token counts are not a window occupancy, and the window has no
 * input/output split. It changes when that frame changes.
 */

/** A monetary amount the engine reported (ACP `Cost`): an ISO 4217 currency and
 *  the cumulative amount for the session. */
export interface AgentCost {
  amount: number
  currency: string
}

/**
 * The session's context window and cost, as ACP's `usage_update` reports them.
 *
 * Deliberately not {@link AgentUsage}: these are the session's context occupancy
 * and its cumulative cost, while a run's usage is what one turn spent. Folding the
 * two would make one of them unrepresentable — a turn's token counts are not a
 * window occupancy, and the window has no input/output split.
 */
export interface AgentContextUsage {
  /** Tokens currently in context (the wire's `used`). */
  usedTokens: number
  /** The whole context window, in tokens (the wire's `size`). Without it the
   *  occupancy is a number with no scale, and a percentage would be invented. */
  contextTokens: number
  /** Cumulative session cost, or null when the engine reported none (§5.1: shown
   *  only when its source is reliable, and a missing cost is not zero). */
  cost: AgentCost | null
}
