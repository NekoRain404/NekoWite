/**
 * One slash command the engine advertises.
 *
 * Its own module because the engine publishes the list rather than returning it with the session:
 * `commands-changed` carries the whole of it, so a field added to a command is a change to that one
 * announcement and to nothing else in the vocabulary.
 */

/** One slash command the engine currently advertises. */
export interface AgentCommand {
  name: string
  /**
   * Absent when the engine advertises a command without describing it; the menu
   * then shows the name alone instead of an empty description line.
   */
  description?: string
}
