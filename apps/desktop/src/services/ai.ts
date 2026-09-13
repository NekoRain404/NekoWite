import { ref } from 'vue'
import type { NekoEditor } from '@nekowite/editor-core'
import { editorSessionManager } from '../features/editor/sessionManager'
import { notifyError } from './errors'
import { getSharedGateways } from '../platform/runtime/gatewayRuntime'
import { useSettingsStore } from '../stores/settings'
import type { AIConfig } from '../stores/settings'
import { useAiPermissionStore } from '../stores/aiPermission'
import { decideAiWrite, isAiEnabled, type AiPermissionState } from './aiPermissions'
import { recordAiAudit } from './aiAudit'
import { t } from '../i18n'

interface PrefixView {
  state: {
    selection: { head: number }
    doc: {
      textBetween(from: number, to: number, blockSeparator: string, leafText: string): string
    }
  }
}

export function buildAIPrompt(prefix: string): string {
  return `Continue writing the following text. Only output the continuation, no preamble.\n\n${prefix.trimEnd()}\n`
}

export function getCursorPrefix(view: PrefixView | null, maxChars = 200): string {
  if (!view) return ''
  const head = view.state.selection.head
  const from = Math.max(0, head - maxChars)
  return view.state.doc.textBetween(from, head, '\n', ' ')
}

type ListenerCleanup = () => void

let cleanups: ListenerCleanup[] = []

/**
 * Ids of the requests this window has started and not yet finished.
 *
 * The FRONTEND picks these, before the request is sent, because the backend
 * cannot be cancelled by an id nobody knows yet: a reasoning model stays silent
 * for seconds (measured: ~27 reasoning deltas before the first answer), and
 * during that window a backend-chosen id meant Stop had nothing to cancel — the
 * abandoned request kept streaming, and its late chunks were then adopted by
 * the next request and shown as its answer. Owning the id up front also lets
 * every handler accept only its own events, so one stream can never write into
 * another.
 */
const activeIds = new Set<string>()
let requestSeq = 0

/** A fresh request id. Unique per request without depending on the clock alone. */
export function nextRequestId(): string {
  requestSeq += 1
  return `ai-${Date.now().toString(36)}-${requestSeq}`
}

/**
 * True while the running completion has reported reasoning progress but no
 * answer text yet.
 *
 * Reasoning models stream their thinking first — measured against the
 * `deepseek-flash` endpoint, 27 reasoning deltas arrived before the first
 * content delta — and the backend deliberately keeps that monologue out of the
 * document text. Without a visible state the editor simply looked frozen for
 * that whole phase, so the UI shows a "thinking" hint instead.
 */
export const aiThinking = ref(false)

function markThinking(on: boolean): void {
  aiThinking.value = on
}

/**
 * The permission state, or null when there is no Pinia instance (a bare unit
 * test, a plugin host). Same rule the ghost writer's settings lookup uses: a
 * state we cannot read is not evidence that AI is switched off, so the feature
 * keeps working rather than dying silently.
 */
function permissionState(): AiPermissionState | null {
  try {
    return useAiPermissionStore().state
  } catch {
    return null
  }
}

/** True when the user switched AI off outright: no request may leave the app,
 *  which is the only thing that also stops the document being sent away. */
function aiDisabled(): boolean {
  const state = permissionState()
  return state !== null && !isAiEnabled(state)
}

/** True when the user forbade AI writes. The ghost writer is a write path — the
 *  suggestion exists only to be accepted into the document — and it ships the
 *  text around the cursor to a provider, so under this policy there is nothing
 *  to offer and the request is not made at all. */
function aiWritesForbidden(): boolean {
  const state = permissionState()
  if (state === null) return false
  return decideAiWrite(state, { kind: 'insert', summary: '' }) === 'deny'
}

/** Reasons already reported to the user in this window. A blocked feature is
 *  worth explaining once; a toast on every Tab press is noise. */
const announcedBlocks = new Set<string>()

function announceBlock(reason: string, messageKey?: string): void {
  if (announcedBlocks.has(reason)) return
  announcedBlocks.add(reason)
  const key = messageKey ?? (reason === 'disabled' ? 'aiperm.blockedDisabled' : 'aiperm.blockedReadonly')
  notifyError(t(key))
}
// Incremented by every trigger/accept/reject; events and listener
// registrations from a superseded trigger are ignored, so a stale stream can
// never write into the current one.
let streamSeq = 0

function cleanupListeners(): void {
  cleanups.forEach((fn) => {
    try {
      fn()
    } catch {
      // ignore teardown failures
    }
  })
  cleanups = []
}

function cancelStream(): void {
  // Invalidate the running streams' handlers, not just unregister them: an
  // event already in flight can still be delivered to a callback that is about
  // to be detached, and a cancelled request must never write its answer into
  // the editor or the chat.
  streamSeq++
  for (const id of activeIds) {
    void Promise.resolve(getSharedGateways().ai.cancel(id)).catch(() => undefined)
  }
  activeIds.clear()
  cleanupListeners()
  markThinking(false)
}

function readPrefix(editor: NekoEditor): string {
  try {
    return getCursorPrefix(editor.getView() as unknown as PrefixView)
  } catch {
    return ''
  }
}

async function triggerSuggestion(
  editorArg?: NekoEditor | null,
  configArg?: AIConfig,
): Promise<void> {
  // Checked before anything is torn down or sent: the UI already declines to
  // call this (see GhostWriter.vue), and the service refuses on its own so a
  // caller that goes around the UI cannot turn "AI off" into a request.
  if (aiDisabled()) {
    recordAiAudit({
      source: 'ghost',
      outcome: 'blocked',
      kind: 'insert',
      reason: 'AI features are switched off',
    })
    announceBlock('disabled')
    return
  }
  if (aiWritesForbidden()) {
    recordAiAudit({
      source: 'ghost',
      outcome: 'blocked',
      kind: 'insert',
      reason: 'the write permission forbids this',
    })
    announceBlock('readonly')
    return
  }
  cancelStream()
  streamSeq++
  const mySeq = streamSeq

  const editor = editorArg ?? editorSessionManager.getActiveEditor()
  if (!editor) return

  const config = configArg ?? useSettingsStore().config()
  const prefix = readPrefix(editor)
  const prompt = buildAIPrompt(prefix)

  const myId = nextRequestId()
  activeIds.add(myId)

  let acc = ''
  let errorNotified = false

  const superseded = (): boolean => mySeq !== streamSeq

  try {
    const offChunk = await getSharedGateways().events.on<{ id: string; text: string }>('ai-chunk', (e) => {
      if (superseded() || e.id !== myId) return
      // The answer started, so the thinking phase is over.
      markThinking(false)
      acc += e.text
      editor.setSuggestion(acc)
    })
    if (superseded()) {
      offChunk()
      return
    }
    // Track each listener as it registers so a mid-registration rejection
    // (e.g. the event system failing on `ai-done`) still cleans up the ones
    // that already went in — no partially-registered listener leaks.
    cleanups.push(offChunk)
    // Only this stream's own id finalizes it: a done/error event from another
    // request (e.g. one that was cancelled while its chunks were still in
    // flight) must not tear down this stream's listeners.
    const offDone = await getSharedGateways().events.on<{ id: string; full: string }>('ai-done', (e) => {
      if (superseded() || e.id !== myId) return
      activeIds.delete(myId)
      cleanupListeners()
      markThinking(false)
    })
    if (superseded()) {
      offChunk()
      offDone()
      return
    }
    cleanups.push(offDone)
    const offError = await getSharedGateways().events.on<{ id: string; message: string }>('ai-error', (e) => {
      if (superseded() || e.id !== myId) return
      // If the raw invoke rejection was delivered before this event (and the
      // catch already toasted), skip the duplicate toast. Marked together with
      // the toast so a marked flag always means "an error was reported".
      if (!errorNotified) {
        errorNotified = true
        notifyError(t('error.aiGenFailed', { msg: e.message }))
      }
      activeIds.delete(myId)
      cleanupListeners()
      markThinking(false)
    })
    if (superseded()) {
      offChunk()
      offDone()
      offError()
      return
    }
    cleanups.push(offError)
    // Registered LAST on purpose: chunk/done/error are a stream's terminal
    // events and must never be missed, while reasoning is progress-only
    // (losing its first tick costs nothing, the next one shows it).
    const offReasoning = await getSharedGateways().events.on<{ id: string; text: string }>('ai-reasoning', (e) => {
      if (superseded() || e.id !== myId) return
      markThinking(true)
    })
    if (superseded()) {
      offReasoning()
      return
    }
    cleanups.push(offReasoning)
  } catch (e) {
    cleanupListeners()
    activeIds.delete(myId)
    notifyError(e instanceof Error ? e.message : String(e))
    return
  }

  if (superseded()) return

  try {
    await getSharedGateways().ai.complete(config, prompt, undefined, myId)
  } catch (e) {
    cleanupListeners()
    activeIds.delete(myId)
    // Rust emits ai-error AND rejects the invoke; the event handler owns the
    // toast, so swallow the raw rejection when an ai-error event was seen.
    // Mark errorNotified even here so a late-delivered ai-error event does not
    // toast a second time (defends the reject-first ordering).
    if (!errorNotified) {
      errorNotified = true
      notifyError(e instanceof Error ? e.message : String(e))
    }
  }
}

function accept(): void {
  // Bump the generation so a trigger that is still awaiting listener
  // registration cannot attach after the suggestion was accepted/rejected.
  streamSeq++
  const editor = editorSessionManager.getActiveEditor()
  // Accepting inserts text into the document, so it is a write like any other.
  // The second Tab is the user's own approval, which is why a prompting policy
  // does not ask again - but a policy that forbids writes outright, or the
  // master switch, must not be undone by a keystroke. Found on a real run: a
  // suggestion fetched before the switch was turned off could still be accepted
  // (and autosaved) afterwards. The text is discarded instead.
  if (aiDisabled() || aiWritesForbidden()) {
    // The discarded suggestion is a write that did NOT happen, which is exactly
    // the kind of thing the user should be able to find later: the autosave
    // used to put it on disk.
    recordAiAudit({
      source: 'ghost',
      outcome: 'blocked',
      kind: 'insert',
      reason: 'the suggestion was discarded, not inserted',
    })
    announceBlock('accept-blocked', 'aiperm.acceptBlocked')
    editor?.rejectSuggestion()
    cancelStream()
    return
  }
  editor?.acceptSuggestion()
  cancelStream()
}

function reject(): void {
  streamSeq++
  editorSessionManager.getActiveEditor()?.rejectSuggestion()
  cancelStream()
}

export const aiService = {
  triggerSuggestion,
  accept,
  reject,
  cancelStream,
}

export interface ChatStreamHandlers {
  onChunk(text: string): void
  onDone(full: string): void
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
  streamSeq++
  const mySeq = streamSeq

  // Owned here, before the request goes out, so Stop works during the silent
  // phase and this stream only ever accepts its own events.
  const myId = nextRequestId()
  activeIds.add(myId)

  let acc = ''
  let errorNotified = false

  const superseded = (): boolean => mySeq !== streamSeq

  const cancel = (): void => {
    if (superseded()) return
    // Supersede this stream too: its listeners are unregistered below, and any
    // handler that is already running stops acting on its id.
    streamSeq++
    activeIds.delete(myId)
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
      cleanups.push(offChunk)
      const offDone = await getSharedGateways().events.on<{ id: string; full: string }>('ai-done', (e) => {
        if (superseded() || e.id !== myId) return
        activeIds.delete(myId)
        cleanupListeners()
        markThinking(false)
        handlers.onDone(e.full)
      })
      if (superseded()) {
        offChunk()
        offDone()
        return false
      }
      cleanups.push(offDone)
      const offError = await getSharedGateways().events.on<{ id: string; message: string }>('ai-error', (e) => {
        if (superseded() || e.id !== myId) return
        // Skip a duplicate onError if the raw rejection already handled it
        // (defends against the invoke rejection arriving before this event).
        if (!errorNotified) {
          errorNotified = true
          handlers.onError(e.message)
        }
        activeIds.delete(myId)
        cleanupListeners()
        markThinking(false)
      })
      if (superseded()) {
        offChunk()
        offDone()
        offError()
        return false
      }
      cleanups.push(offError)
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
      cleanups.push(offReasoning)
      return true
    } catch (e) {
      cleanupListeners()
      activeIds.delete(myId)
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
      activeIds.delete(myId)
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