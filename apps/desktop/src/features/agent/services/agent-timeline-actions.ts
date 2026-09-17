/**
 * What the transcript's own controls act on: two questions asked of the rows the view already
 * holds, and nothing about how the answers are drawn.
 *
 * Both are the reader's *latest* something rather than a row the pointer happens to be over,
 * and that is a deliberate difference from Zed, which draws a control per message
 * (`render_thread_controls`, `thread_view.rs:6806`: copy *this* agent response, scroll to the
 * user message that prompted it). This panel's transcript has no per-row toolbar — the rows are
 * the answer, and a rail 220px wide cannot afford a control strip under every one of them — so
 * the two facts that survive the move are the ones a reader wants from a panel they have just
 * been reading: the newest answer, and their own last message. What each control copies or goes
 * to is therefore said in its own label rather than left to be discovered
 * (`agent.panel.timeline.copy`, `agent.panel.timeline.toUser`).
 *
 * Nothing here reads the DOM, the clock or the locale: a row in, a row or a string out, so the
 * choice of *which* row is testable without a browser.
 */

import type { AgentTimelineEntry, AgentUserEntry } from './agent-timeline'

/**
 * The newest reply, or null when the transcript holds none.
 *
 * "Reply" is the engine's own answer channel — `kind: 'text'` — and not the reasoning beside it:
 * a thought row is something the engine disclosed about how it got there, and a copy control that
 * silently included it would hand the reader words the answer does not contain. An empty string
 * counts as no reply: the row exists and there is nothing in it to hand over.
 */
export function newestReply(rows: readonly AgentTimelineEntry[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row.kind === 'text' && row.text !== '') return row.text
  }
  return null
}

/**
 * The newest thing the reader said, or null when they have not said anything.
 *
 * Both origins count — the host's own message and the engine's replay of it on a reopen are the
 * same act by the same person, and which one the transcript happens to hold depends on how the
 * session was opened, not on what the reader did. The reader's own newest message is what the
 * control goes to; the distinction between the two origins is for the transcript's rendering
 * (`data-origin`), not for this.
 */
export function newestUserRow(rows: readonly AgentTimelineEntry[]): AgentUserEntry | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row.kind === 'user') return row
  }
  return null
}
