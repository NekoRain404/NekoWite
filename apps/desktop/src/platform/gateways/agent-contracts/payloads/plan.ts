/**
 * One task in the engine's execution plan.
 *
 * The plan is the engine's own statement about a complex turn, replaced whole by `plan-changed`
 * (`readers/stream.ts` reads it), so an entry here is apart from the session's own configuration and
 * from the tool rows a turn produces.
 */

/** One task in the engine's execution plan. */
export interface AgentPlanEntry {
  /** What the task is for, in the engine's wording. */
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
}
