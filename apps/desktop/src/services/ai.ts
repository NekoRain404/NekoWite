import type { NekoEditor } from '@nekowite/editor-core'
import { editorBridge } from './editorBridge'
import { notifyError } from './errors'
import { getGateways } from './gateways/index'
import { useSettingsStore } from '../stores/settings'
import type { AIConfig } from '../stores/settings'
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

let activeId: string | null = null
let cleanups: ListenerCleanup[] = []
const cancelledIds = new Set<string>()
// Incremented by every trigger/accept/reject; events and listener
// registrations from a superseded trigger are ignored, so a stale stream can
// never be adopted (its first chunk previously won the activeId race).
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
  const id = activeId
  if (id) {
    // Only the most-recently-cancelled stream can still be emitting stray
    // events (its done/error hasn't necessarily been received yet); older
    // cancelled ids were superseded by subsequent streams and filtered by the
    // activeId check, so drop them here to keep cancelledIds bounded.
    cancelledIds.clear()
    cancelledIds.add(id)
    void Promise.resolve(getGateways().ai.cancel(id)).catch(() => undefined)
  }
  cleanupListeners()
  activeId = null
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
  streamSeq++
  const mySeq = streamSeq
  cancelStream()

  const editor = editorArg ?? editorBridge.getEditor()
  if (!editor) return

  const config = configArg ?? useSettingsStore().config()
  const prefix = readPrefix(editor)
  const prompt = buildAIPrompt(prefix)

  let acc = ''
  let errorNotified = false

  const superseded = (): boolean => mySeq !== streamSeq

  try {
    const offChunk = await getGateways().events.on<{ id: string; text: string }>('ai-chunk', (e) => {
      if (superseded()) return
      if (cancelledIds.has(e.id)) return
      if (activeId !== null && activeId !== e.id) return
      if (activeId === null) activeId = e.id
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
    // Cleanup only for the stream we actually own. done/error for a stale id
    // (or an id we never adopted, e.g. a cancelled stream's lingering event)
    // must NOT wipe the current request's listeners.
    const offDone = await getGateways().events.on<{ id: string; full: string }>('ai-done', (e) => {
      const id = e.id
      // Never adopt a cancelled/expired id: a stale done from a stream that
      // was cancelled before a newer one registered could otherwise be
      // adopted here (activeId is still null) and tear down the newer
      // stream's listeners. Prune the marker and drain the stray event.
      if (cancelledIds.has(id)) {
        cancelledIds.delete(id)
        return
      }
      if (superseded()) return
      // Adopt the id even when no chunk arrived yet (a provider that answers
      // with zero deltas, e.g. only [DONE], still finalizes here); without
      // this the guard below would bail and leak the listeners forever.
      if (activeId === null) activeId = id
      if (activeId !== id) return
      cleanupListeners()
      activeId = null
    })
    if (superseded()) {
      offChunk()
      offDone()
      return
    }
    cleanups.push(offDone)
    const offError = await getGateways().events.on<{ id: string; message: string }>('ai-error', (e) => {
      const id = e.id
      if (cancelledIds.has(id)) {
        cancelledIds.delete(id)
        return
      }
      if (superseded()) return
      // Adopt the id (zero-chunk error responses) so the guard below does not
      // bail, leaving the listeners registered and the toast suppressed.
      if (activeId === null) activeId = id
      if (activeId !== id) return
      // If the raw invoke rejection was delivered before this event (and the
      // catch already toasted), skip the duplicate toast. Marked together with
      // the toast so a marked flag always means "an error was reported".
      if (!errorNotified) {
        errorNotified = true
        notifyError(t('error.aiGenFailed', { msg: e.message }))
      }
      cleanupListeners()
      activeId = null
    })
    if (superseded()) {
      offChunk()
      offDone()
      offError()
      return
    }
    cleanups.push(offError)
  } catch (e) {
    cleanupListeners()
    activeId = null
    notifyError(e instanceof Error ? e.message : String(e))
    return
  }

  if (superseded()) return

  try {
    await getGateways().ai.complete(config, prompt)
  } catch (e) {
    cleanupListeners()
    activeId = null
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
  editorBridge.getEditor()?.acceptSuggestion()
  cancelStream()
}

function reject(): void {
  streamSeq++
  editorBridge.getEditor()?.rejectSuggestion()
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
  streamSeq++
  const mySeq = streamSeq
  cancelStream()

  let acc = ''
  let errorNotified = false

  const superseded = (): boolean => mySeq !== streamSeq

  const cancel = (): void => {
    if (superseded()) return
    const id = activeId
    if (id) {
      cancelledIds.add(id)
      void Promise.resolve(getGateways().ai.cancel(id)).catch(() => undefined)
    }
    cleanupListeners()
    activeId = null
  }

  const setupListeners = async (): Promise<boolean> => {
    try {
      const offChunk = await getGateways().events.on<{ id: string; text: string }>('ai-chunk', (e) => {
        if (superseded()) return
        if (cancelledIds.has(e.id)) return
        if (activeId !== null && activeId !== e.id) return
        if (activeId === null) activeId = e.id
        acc += e.text
        handlers.onChunk(acc)
      })
      if (superseded()) {
        offChunk()
        return false
      }
      cleanups.push(offChunk)
      const offDone = await getGateways().events.on<{ id: string; full: string }>('ai-done', (e) => {
        const id = e.id
        if (cancelledIds.has(id)) {
          cancelledIds.delete(id)
          return
        }
        if (superseded()) return
        // Adopt the id even when no chunk arrived yet (zero-delta providers)
        // so the guard below does not bail and leak the listeners.
        if (activeId === null) activeId = id
        if (activeId !== id) return
        cleanupListeners()
        activeId = null
        handlers.onDone(e.full)
      })
      if (superseded()) {
        offChunk()
        offDone()
        return false
      }
      cleanups.push(offDone)
      const offError = await getGateways().events.on<{ id: string; message: string }>('ai-error', (e) => {
        const id = e.id
        if (cancelledIds.has(id)) {
          cancelledIds.delete(id)
          return
        }
        if (superseded()) return
        // Adopt the id (zero-chunk error responses) so the guard does not bail.
        if (activeId === null) activeId = id
        if (activeId !== id) return
        // Skip a duplicate onError if the raw rejection already handled it
        // (defends against the invoke rejection arriving before this event).
        if (!errorNotified) {
          errorNotified = true
          handlers.onError(e.message)
        }
        cleanupListeners()
        activeId = null
      })
      if (superseded()) {
        offChunk()
        offDone()
        offError()
        return false
      }
      cleanups.push(offError)
      return true
    } catch (e) {
      cleanupListeners()
      activeId = null
      handlers.onError(e instanceof Error ? e.message : String(e))
      return false
    }
  }

  return (async () => {
    if (!(await setupListeners())) return { cancel }
    if (superseded()) return { cancel }
    try {
      await getGateways().ai.complete(config, prompt, images)
    } catch (e) {
      cleanupListeners()
      activeId = null
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