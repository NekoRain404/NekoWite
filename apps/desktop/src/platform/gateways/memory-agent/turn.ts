/**
 * The scripted turn: everything the double does between a `prompt` and its result.
 *
 * One turn's whole life is here on purpose. The endings — answered, cancelled,
 * crashed, stopped — differ only in what is set on the run while it is suspended,
 * so a single continuation reads that state and decides, instead of four endings
 * each finishing the turn in their own way and drifting apart.
 */

import type { AgentRunResult } from '../agent-contracts'
import { pushEvent, suspend, type LiveRun, type LiveSession } from './session'
import type { MemoryRunScript } from './scenario'

export async function runTurn(
  record: LiveSession,
  text: string,
  run: LiveRun,
  script: MemoryRunScript,
): Promise<AgentRunResult> {
  // **Recorded, not published.** The engine's own store holds the user's turn from the moment it
  // accepts the prompt, and its *stream* says nothing about it: the replay probe measured zero
  // user chunks across a whole live turn, and one — the prompt verbatim — arriving first on the
  // `session/load` that restored the conversation. So this goes into the record's stored turns
  // (`LiveSession.prompts`) and is replayed by `loadSession`, rather than through `pushEvent`,
  // which would put a frame on the live stream that no engine ever sends.
  record.prompts.push({ runId: run.runId, text })

  for (const chunk of script.chunks ?? [text]) {
    pushEvent(record, 'text-delta', { text: chunk }, run.runId)
  }

  if (script.permission) {
    const request = pushEvent(
      record,
      'permission-request',
      {
        requestId: `${run.runId}:permission`,
        // The double pairs the prompt with a tool row the same way the engine
        // does, so a consumer that relates the two has something real to relate.
        toolCallId: script.permission.toolCallId ?? `${run.runId}:tool`,
        title: script.permission.title,
        input: script.permission.input ?? { state: 'absent' },
        // The blocks the request itself carries, which is where the engine puts them (the
        // measured frame's own `toolCall` holds the diff) — and `[]` is the double's own,
        // explicit "this request carried none", so a scripted prompt with no diff draws none
        // rather than borrowing the row's.
        content: script.permission.content ?? [],
        options: script.permission.options,
      },
      run.runId,
    )
    record.permissions.push(request)
    record.state = 'waiting-permission'
    await suspend(run)
  }

  if (script.hang && !run.cancelled && !run.failure) {
    record.state = 'running'
    await suspend(run)
  }

  if (run.failure) {
    // The runtime is gone, so the host is the one that has to say why the turn
    // ended: there is no engine left to report it.
    const failure = run.failure
    pushEvent(record, 'run-failed', { code: failure.code, message: failure.message }, run.runId)
    record.state = 'failed'
    throw failure
  }

  const result: AgentRunResult = run.cancelled
    ? { stopReason: 'cancelled', usage: null }
    : { stopReason: script.stopReason ?? 'end-turn', usage: script.usage ?? null }
  pushEvent(record, 'run-finished', result, run.runId)
  record.state = run.cancelled ? 'cancelled' : 'completed'
  return result
}
