import {
  AgentFailure,
  type AgentEvent,
  type AgentIdentity,
  type AgentPromptAttachment,
  type AgentRunResult,
} from '../agent-contracts'
import type { EventChannel } from './channel'
import { KEY_SEPARATOR } from './fields'
import type { AgentIpc } from './ipc'
import { expiredTurn, TURN_LIVENESS_BOUND_MS } from './turn-bound'

interface Turn {
  identity: AgentIdentity
  runId: string | null
  parked: AgentEvent[]
  settle(result: AgentRunResult): void
  fail(error: AgentFailure): void
}

function sessionKey(identity: AgentIdentity): string {
  return [identity.agentId, identity.profileId, identity.runtimeEpoch,
    identity.vaultId, identity.sessionId].join(KEY_SEPARATOR)
}

/** Each session owns its starting reply and early endings, including across runtime restarts. */
export function createAgentTurns(ipc: AgentIpc, channel: EventChannel) {
  const active = new Map<string, Turn>()
  let channelGeneration = 0

  function finish(turn: Turn, event: AgentEvent): void {
    if (event.kind === 'run-finished') {
      turn.settle({ stopReason: event.payload.stopReason, usage: event.payload.usage })
    } else if (event.kind === 'run-failed') {
      turn.fail(new AgentFailure(event.payload.code, event.payload.message))
    }
  }

  return {
    settle(event: AgentEvent): void {
      if (event.runId === null) return
      const turn = active.get(sessionKey(event))
      if (!turn) return
      if (turn.runId === null) turn.parked.push(event)
      else if (turn.runId === event.runId) finish(turn, event)
    },

    closeSession(sessionId: string): void {
      for (const [key, turn] of active) {
        if (turn.identity.sessionId !== sessionId) continue
        active.delete(key)
        turn.fail(new AgentFailure('cancelled', `session ${sessionId} was closed while the turn was running`))
      }
    },

    stop(): void {
      // closeAll releases the old channel's registrations; late continuations must not release
      // a registration subsequently acquired by the next runtime.
      channelGeneration += 1
      for (const turn of active.values()) {
        turn.fail(new AgentFailure('cancelled', 'the runtime stopped while the turn was running'))
      }
      active.clear()
    },

    async prompt(
      identity: AgentIdentity,
      text: string,
      attachments: readonly AgentPromptAttachment[],
    ): Promise<AgentRunResult> {
      const key = sessionKey(identity)
      if (active.has(key)) {
        throw new AgentFailure('turn-in-flight', `session ${identity.sessionId} already has a turn in flight`)
      }
      let settle!: Turn['settle']
      let fail!: Turn['fail']
      const ended = new Promise<AgentRunResult>((resolve, reject) => { settle = resolve; fail = reject })
      // Cancellation or timeout may reject before the listener registration finishes.
      void ended.catch(() => {})
      const turn: Turn = { identity, runId: null, parked: [], settle, fail }
      active.set(key, turn)
      const mine = channelGeneration
      const bound = setTimeout(() => {
        if (active.get(key) === turn) active.delete(key)
        fail(expiredTurn())
      }, TURN_LIVENESS_BOUND_MS)
      let registered = false
      try {
        await Promise.race([
          channel.handle().then(() => { registered = true }),
          ended,
        ])
        if (active.get(key) !== turn) return await ended
        // A stopped session or expired turn must settle even if its IPC reply never arrives.
        const runId = await Promise.race([
          ipc.prompt(identity.sessionId, text, attachments),
          ended.then(() => null),
        ])
        if (runId === null) return await ended
        turn.runId = runId
        for (const event of turn.parked) {
          if (event.runId === runId) finish(turn, event)
        }
        turn.parked = []
        return await ended
      } finally {
        clearTimeout(bound)
        // Object identity protects a replacement turn from the old call's late cleanup.
        if (active.get(key) === turn) active.delete(key)
        if (mine === channelGeneration) {
          const release = channel.release()
          if (registered) await release
          // Releasing a pending registration must not hold cancellation hostage. The channel
          // relinquishes ownership immediately and unlistens when registration eventually lands.
          else void release.catch((error: unknown) => {
            console.error('[NekoWite] the pending agent listener could not be released', error)
          })
        }
      }
    },
  }
}
