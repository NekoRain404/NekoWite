/**
 * What an accepted event does to the view.
 *
 * This is the effect half of the reducer. `agent-event-reducer.ts` decides whether an
 * event may change the state at all and owns the vocabulary of refusals; by the time an
 * event reaches this module it has already been checked against the composite identity,
 * the host's sequence and the run it claims, and the run it belongs to has been bound.
 * Nothing here refuses anything — which is what keeps the two halves readable: the rules
 * are all in one file, and the effects in the other.
 *
 * Two effects are worth knowing about, because they are choices rather than transcription:
 *
 *  - **text is coalesced.** Consecutive chunks of one answer, one thought or one writer's
 *    message become one timeline row (§6.2: 「文本可合并」). A row per chunk would be a
 *    timeline of tokens, and §5.2 forbids doing per-token work on the UI side.
 *  - **a tool call is its own row.** The engine sends `tool_call` and then any number of
 *    `tool_call_update` frames for the same id; they are one row whose fields are
 *    replaced, because the contract folds the two into one kind for exactly that reason.
 */

import type { AgentEvent, AgentStopReason } from '../../../platform/gateways/agent-contracts'
import {
  appendTimelineEntry,
  continuesLast,
  mergeLastText,
  replaceToolEntry,
  toolEntryIndex,
  toolRow,
  type AgentTextEntryInput,
} from './agent-timeline'
import { endRun, type AgentSessionView } from './agent-session-view'

/** The view after the event, and whether writing it crossed the timeline's entry bound.
 *  What crossing it *means* is the reducer's business; this only reports that it did. */
export interface AgentApplication {
  view: AgentSessionView
  overLimit: boolean
}

/** Write one text row, merging it into the row before it when that row is the same
 *  writer's continuation. */
function writeText(view: AgentSessionView, entry: AgentTextEntryInput): AgentApplication {
  if (continuesLast(view, entry)) return { view: mergeLastText(view, entry.text), overLimit: false }
  const written = appendTimelineEntry(view, entry)
  return { view: written.view, overLimit: written.overLimit }
}

/** How a finished run's stop reason shows in the state machine.
 *
 *  Only `cancelled` is anything other than an ordinary end. The other four — including a
 *  token ceiling and a refusal — ended the way the turn was always going to end, and
 *  `run-finished` never produces `failed`: a run is failed only when the runtime could not
 *  carry it out at all, which is `run-failed`. The reason itself is kept in `lastResult`,
 *  so "completed" does not flatten them into one thing. */
function endStateFor(stopReason: AgentStopReason): 'completed' | 'cancelled' {
  return stopReason === 'cancelled' ? 'cancelled' : 'completed'
}

/** Apply one accepted event. */
export function applyAgentEvent(view: AgentSessionView, event: AgentEvent): AgentApplication {
  switch (event.kind) {
    case 'text-delta':
      return writeText(view, { kind: 'text', runId: event.runId, text: event.payload.text })
    case 'thought-delta':
      // The engine's own disclosed reasoning. Kept rather than dropped: §5.1 forbids
      // showing reasoning the model never exposed, not reasoning the engine chose to
      // disclose, and that decision belongs to the layer that can render it — collapsed,
      // or not at all.
      return writeText(view, { kind: 'thought', runId: event.runId, text: event.payload.text })
    case 'user-delta':
      // The engine's copy of the user's half, which is what it sends when a session is
      // restored. Kept apart from the host's own row for the same message: they are two
      // statements about the conversation rather than two halves of one.
      return writeText(view, { kind: 'user', runId: event.runId, text: event.payload.text, origin: 'engine' })
    case 'tool-update': {
      const call = event.payload
      const index = toolEntryIndex(view, call.toolCallId)
      if (index !== -1) return { view: replaceToolEntry(view, index, call), overLimit: false }
      const written = appendTimelineEntry(view, toolRow(event.runId, call))
      return { view: written.view, overLimit: written.overLimit }
    }
    case 'permission-request':
      // Held as whole events so the run that asked travels with the question (§6.3 binds
      // an answer to its turn). Never dropped to stay inside a bound: §6.2 forbids losing
      // a permission request, so this is the one append no limit ever refuses.
      return {
        view: { ...view, permissions: [...view.permissions, event], state: 'waiting-permission' },
        overLimit: false,
      }
    case 'commands-changed':
      // Replaced wholesale: the engine publishes the complete list, so merging would keep
      // a command it has withdrawn.
      return { view: { ...view, commands: [...event.payload.commands] }, overLimit: false }
    case 'plan-changed':
      return { view: { ...view, plan: [...event.payload.entries] }, overLimit: false }
    case 'mode-changed':
      return { view: { ...view, modeId: event.payload.modeId }, overLimit: false }
    case 'config-changed':
      return { view: { ...view, config: [...event.payload.options] }, overLimit: false }
    case 'usage-changed':
      return { view: { ...view, usage: event.payload }, overLimit: false }
    case 'files-changed': {
      const known = new Set(view.changedFiles)
      const added = event.payload.paths.filter((path) => !known.has(path))
      return { view: { ...view, changedFiles: [...view.changedFiles, ...added] }, overLimit: false }
    }
    case 'session-changed': {
      // Absent and null differ: an update that does not mention the title leaves it alone,
      // and one that sends null clears it. The validator keeps the two apart so this layer
      // can honour the difference instead of guessing which one arrived.
      const { title, updatedAt } = event.payload
      return {
        view: {
          ...view,
          title: title === undefined ? view.title : title,
          updatedAt: updatedAt === undefined ? view.updatedAt : updatedAt,
        },
        overLimit: false,
      }
    }
    case 'run-finished':
      return {
        view: {
          ...endRun(view, event.runId, endStateFor(event.payload.stopReason)),
          // Kept whole, not only the state: the reason is what tells a token ceiling from
          // a finished answer, and a run that hit a limit is neither a success nor a
          // failure that the state machine could show.
          lastResult: event.payload,
        },
        overLimit: false,
      }
    case 'run-failed':
      return {
        view: {
          ...endRun(view, event.runId, 'failed'),
          failure: { code: event.payload.code, message: event.payload.message },
        },
        overLimit: false,
      }
  }
}
