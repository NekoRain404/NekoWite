import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { NekoEditor } from '@nekowite/editor-core'
import { editorBridge } from './editorBridge'
import { notifyError } from './errors'
import { useSettingsStore } from '../stores/settings'
import type { AIConfig } from '../stores/settings'

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
    void Promise.resolve(invoke('ai_cancel', { id })).catch(() => undefined)
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
  cancelStream()

  const editor = editorArg ?? editorBridge.getEditor()
  if (!editor) return

  const config = configArg ?? useSettingsStore().config()
  const prefix = readPrefix(editor)
  const prompt = buildAIPrompt(prefix)

  let acc = ''
  let errorNotified = false

  try {
    const offChunk = await listen<{ id: string; text: string }>('ai-chunk', (e) => {
      if (cancelledIds.has(e.payload.id)) return
      if (activeId !== null && activeId !== e.payload.id) return
      if (activeId === null) activeId = e.payload.id
      acc += e.payload.text
      editor.setSuggestion(acc)
    })
    // Track each listener as it registers so a mid-registration rejection
    // (e.g. the event system failing on `ai-done`) still cleans up the ones
    // that already went in — no partially-registered listener leaks.
    cleanups.push(offChunk)
    // Cleanup only for the stream we actually own. done/error for a stale id
    // (or an id we never adopted, e.g. a cancelled stream's lingering event)
    // must NOT wipe the current request's listeners.
    const offDone = await listen<{ id: string; full: string }>('ai-done', (e) => {
      // A done/error for ANY id proves that stream has completed, so its
      // cancelled-set entry (if it was cancelled) is no longer needed — prune it
      // to keep cancelledIds bounded.
      cancelledIds.delete(e.payload.id)
      if (activeId === null || e.payload.id !== activeId) return
      cleanupListeners()
      activeId = null
    })
    cleanups.push(offDone)
    const offError = await listen<{ id: string; message: string }>('ai-error', (e) => {
      cancelledIds.delete(e.payload.id)
      if (activeId === null || e.payload.id !== activeId) return
      errorNotified = true
      cleanupListeners()
      activeId = null
      notifyError(`AI 生成失败：${e.payload.message}`)
    })
    cleanups.push(offError)
  } catch (e) {
    cleanupListeners()
    activeId = null
    notifyError(e instanceof Error ? e.message : String(e))
    return
  }

  try {
    await invoke('ai_complete', { config, prompt })
  } catch (e) {
    cleanupListeners()
    activeId = null
    // Rust emits ai-error AND rejects the invoke; the event handler owns the
    // toast, so swallow the raw rejection when an ai-error event was seen.
    if (!errorNotified) {
      notifyError(e instanceof Error ? e.message : String(e))
    }
  }
}

function accept(): void {
  editorBridge.getEditor()?.acceptSuggestion()
  cancelStream()
}

function reject(): void {
  editorBridge.getEditor()?.rejectSuggestion()
  cancelStream()
}

export const aiService = {
  triggerSuggestion,
  accept,
  reject,
  cancelStream,
}