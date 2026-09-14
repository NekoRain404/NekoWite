/**
 * The chat-shaped completion: one prompt in, a streamed answer out, with the
 * provider's token accounting attached.
 *
 * This is the path the chat rail, the selection edits and the plugin adapter
 * all share, which is why the master switch is enforced here once rather than
 * in each caller. It is not a write path — what a caller does with the answer
 * is the caller's policy to enforce — so it checks `aiDisabled` and not
 * `aiWritesForbidden` (see `ai-gate.ts`).
 *
 * The token accounting lives here because this is its only producer: the wire
 * object arrives on the `ai-done` event, and `usageTotal` is the display rule
 * for exactly the shape this module normalises.
 */

import { getSharedGateways } from '../../../platform/runtime/gatewayRuntime'
import type { AIConfig } from '../../../stores/settings'
import { recordAiAudit } from '../../../services/aiAudit'
import { t } from '../../../i18n'
import { aiDisabled } from './ai-gate'
import { markThinking } from './ai-thinking'
import {
  bumpStreamGeneration,
  cancelStream,
  cleanupListeners,
  isSuperseded,
  nextRequestId,
  releaseRequest,
  trackListener,
  trackRequest,
} from './ai-stream'

/**
 * Token accounting a provider reported for one completion.
 *
 * Every field is `null` when that provider does not report it: Anthropic has no
 * total, OpenAI-compatible endpoints only send the object on the LAST chunk of
 * a stream (and only when the request asked for it), Gemini sends all three. A
 * consumer must render a missing count as unknown, never as 0; a completion the
 * provider never accounted for at all is `null` as a whole.
 */
export interface AiTokenUsage {
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
}

/**
 * The token total to show for a completion: the provider's own total when it
 * sent one (Gemini, OpenAI-compatible), otherwise the sum of the parts it did
 * report (Anthropic's input/output), otherwise `null`.
 *
 * The sum is arithmetic on two measured numbers, not an estimate - the
 * difference matters: a request whose cost is unknown must render nothing
 * rather than "0 tokens".
 */
export function usageTotal(usage: AiTokenUsage | null | undefined): number | null {
  if (!usage) return null
  if (usage.totalTokens !== null) return usage.totalTokens
  if (usage.promptTokens === null && usage.completionTokens === null) return null
  return (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)
}

/** The wire shape of `ai-done` (snake_case keys straight out of serde). */
interface AiDonePayload {
  id: string
  full: string
  /** Absent, null, or an empty object when the provider reported no counts. */
  usage?: {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    total_tokens?: unknown
  } | null
}

/** One reported count, or `null`. Anything that is not a finite, non-negative
 *  number was measured by nobody, so it must not become a displayed number. */
function tokenCount(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null
  return Math.floor(raw)
}

/** Normalise the backend's `usage` object; `null` when nothing was reported. */
function parseTokenUsage(raw: AiDonePayload['usage']): AiTokenUsage | null {
  if (raw === null || typeof raw !== 'object') return null
  const usage: AiTokenUsage = {
    promptTokens: tokenCount(raw.prompt_tokens),
    completionTokens: tokenCount(raw.completion_tokens),
    totalTokens: tokenCount(raw.total_tokens),
  }
  if (usage.promptTokens === null && usage.completionTokens === null && usage.totalTokens === null) {
    return null
  }
  return usage
}

export interface ChatStreamHandlers {
  onChunk(text: string): void
  /** The answer is complete. `usage` is what the provider reported for the
   *  request (render `usageTotal(usage)`); `null`/absent both mean the provider
   *  reported nothing, and it is optional so a caller that does not show cost
   *  (the ghost writer, the selection editor) keeps its one-argument handler.
   *  The chat panel has no per-message meta row to put it in yet, so it is
   *  handed to the caller instead of being dropped. */
  onDone(full: string, usage?: AiTokenUsage | null): void
  onError(msg: string): void
  /** Reasoning progress from a reasoning model. Optional: the monologue is
   *  never part of the answer, so a caller that does not display it can omit
   *  the handler entirely. */
  onReasoning?(text: string): void
}

export interface ChatStream {
  cancel(): void
}

export function startChatCompletion(
  config: AIConfig,
  prompt: string,
  images: string[],
  handlers: ChatStreamHandlers,
): Promise<ChatStream> {
  // The one path every chat-shaped feature shares (chat rail, selection edits,
  // the plugin AI adapter), so the master switch is enforced here once. The
  // caller is told through its own error handler: a silent no-op would look
  // like a model that never answers.
  if (aiDisabled()) {
    recordAiAudit({
      source: 'chat',
      outcome: 'blocked',
      reason: 'AI features are switched off',
    })
    handlers.onError(t('aiperm.blockedDisabled'))
    return Promise.resolve({ cancel: () => undefined })
  }
  cancelStream()
  const mySeq = bumpStreamGeneration()

  // Owned here, before the request goes out, so Stop works during the silent
  // phase and this stream only ever accepts its own events.
  const myId = nextRequestId()
  trackRequest(myId)

  let acc = ''
  let errorNotified = false

  const superseded = (): boolean => isSuperseded(mySeq)

  const cancel = (): void => {
    if (superseded()) return
    // Supersede this stream too: its listeners are unregistered below, and any
    // handler that is already running stops acting on its id.
    bumpStreamGeneration()
    releaseRequest(myId)
    void Promise.resolve(getSharedGateways().ai.cancel(myId)).catch(() => undefined)
    cleanupListeners()
    markThinking(false)
  }

  const setupListeners = async (): Promise<boolean> => {
    try {
      const offChunk = await getSharedGateways().events.on<{ id: string; text: string }>('ai-chunk', (e) => {
        if (superseded() || e.id !== myId) return
        markThinking(false)
        acc += e.text
        handlers.onChunk(acc)
      })
      if (superseded()) {
        offChunk()
        return false
      }
      trackListener(offChunk)
      const offDone = await getSharedGateways().events.on<AiDonePayload>('ai-done', (e) => {
        if (superseded() || e.id !== myId) return
        releaseRequest(myId)
        cleanupListeners()
        markThinking(false)
        handlers.onDone(e.full, parseTokenUsage(e.usage))
      })
      if (superseded()) {
        offChunk()
        offDone()
        return false
      }
      trackListener(offDone)
      const offError = await getSharedGateways().events.on<{ id: string; message: string }>('ai-error', (e) => {
        if (superseded() || e.id !== myId) return
        // Skip a duplicate onError if the raw rejection already handled it
        // (defends against the invoke rejection arriving before this event).
        if (!errorNotified) {
          errorNotified = true
          handlers.onError(e.message)
        }
        releaseRequest(myId)
        cleanupListeners()
        markThinking(false)
      })
      if (superseded()) {
        offChunk()
        offDone()
        offError()
        return false
      }
      trackListener(offError)
      // Same ordering rule as the ghost writer: progress last.
      const offReasoning = await getSharedGateways().events.on<{ id: string; text: string }>('ai-reasoning', (e) => {
        if (superseded() || e.id !== myId) return
        markThinking(true)
        handlers.onReasoning?.(e.text)
      })
      if (superseded()) {
        offReasoning()
        return false
      }
      trackListener(offReasoning)
      return true
    } catch (e) {
      cleanupListeners()
      releaseRequest(myId)
      handlers.onError(e instanceof Error ? e.message : String(e))
      return false
    }
  }

  return (async () => {
    if (!(await setupListeners())) return { cancel }
    if (superseded()) return { cancel }
    try {
      await getSharedGateways().ai.complete(config, prompt, images, myId)
    } catch (e) {
      cleanupListeners()
      releaseRequest(myId)
      // Mark errorNotified even here so a late ai-error event does not call
      // onError a second time (reject arriving before the event).
      if (!errorNotified) {
        errorNotified = true
        handlers.onError(e instanceof Error ? e.message : String(e))
      }
    }
    return { cancel }
  })()
}
