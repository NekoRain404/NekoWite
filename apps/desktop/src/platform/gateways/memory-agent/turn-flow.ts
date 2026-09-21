/**
 * The turn as the gateway's calls see it: the one that starts it, the ones that answer it or
 * end it early, the script the next one follows, and the frame a test pushes in beside it.
 *
 * It is apart from `turn.ts` because that file is the machinery *inside* one turn — the
 * chunks, the permission it suspends on, the ending it reaches — while this one is the
 * gateway's side of it: which session may be prompted, what a second concurrent turn is
 * answered with, and what the runtime's death does to a turn already in flight. The frames a
 * test injects go through here too, since they are the same stream a real turn writes to.
 */

import {
  AgentFailure,
  type AgentPromptAttachment,
  type AgentRunResult,
  type AgentSession,
} from '../agent-contracts'
import type { MemoryEvent, MemoryRunScript } from './scenario'
import { answerPermissionOn, dropRunPermissions, pushEvent, wake, type LiveRun } from './session'
import { anyRecord, engineCall, type LiveRuntime } from './runtime'
import { runTurn } from './turn'

export async function prompt(
  runtime: LiveRuntime,
  session: AgentSession,
  text: string,
  attachments: readonly AgentPromptAttachment[] = [],
): Promise<AgentRunResult> {
  const record = engineCall(runtime, session)
  // One turn at a time per session (§6.2). A second turn would interleave two runs
  // into one stream with no way to tell which text belongs to which, so it is
  // refused here rather than run quietly — the host's own queue, not the gateway,
  // is where the next input waits.
  //
  // The code is the condition's own name, and the same one the real adapter answers with
  // (`tauri-agent.ts`): §9 makes the two interchangeable, so a code that differed between
  // them would be a way for `features/agent` to tell which one it was handed. It used to be
  // `buffer-conflict`, which says a stream cannot be continued — a different fact about a
  // different layer.
  if (record.run) {
    throw new AgentFailure(
      'turn-in-flight',
      `session ${session.sessionId} already has a turn in flight`,
    )
  }
  runtime.runCount += 1
  const run: LiveRun = {
    runId: `run-${runtime.runCount}`,
    cancelled: false,
    failure: null,
    wake: null,
  }
  record.run = run
  record.state = 'running'
  try {
    return await runTurn(record, text, attachments, run, runtime.script)
  } finally {
    record.run = null
    dropRunPermissions(record, run.runId)
  }
}

export async function cancel(runtime: LiveRuntime, session: AgentSession): Promise<void> {
  const record = engineCall(runtime, session)
  const run = record.run
  // Cancelling a session with nothing in flight is a no-op, not a failure: the
  // user can press stop in the same instant the turn ends, and that race must not
  // surface as an error the UI would have to explain.
  if (!run) return
  run.cancelled = true
  wake(run)
}

export async function answerPermission(
  runtime: LiveRuntime,
  session: AgentSession,
  requestId: string,
  optionId: string,
): Promise<void> {
  answerPermissionOn(engineCall(runtime, session), requestId, optionId, runtime.sessions.values())
}

export function setScript(runtime: LiveRuntime, next: MemoryRunScript): void {
  runtime.script = next
}

export function emit(runtime: LiveRuntime, session: AgentSession, event: MemoryEvent): void {
  const record = anyRecord(runtime, session.sessionId)
  // `null` is a value here: an event that belongs to no run must stay that way,
  // which is why the default only applies when the field was left out.
  const runId = event.runId === undefined ? record.lastRunId : event.runId
  pushEvent(record, event.kind, event.payload, runId, {
    sequence: event.sequence,
    identity: event.identity,
  })
}
