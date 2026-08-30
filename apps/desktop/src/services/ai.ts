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
  return `Continue writing the following text. Only output the continuation, no preamble.\n\n${prefix}`
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
  const adopt = (id: string): void => {
    if (cancelledIds.has(id)) return
    if (activeId === null) activeId = id
  }
  const isStale = (id: string): boolean => cancelledIds.has(id) || (activeId !== null && activeId !== id)

  const offChunk = await listen<{ id: string; text: string }>('ai-chunk', (e) => {
    if (isStale(e.payload.id)) return
    adopt(e.payload.id)
    acc += e.payload.text
    editor.setSuggestion(acc)
  })
  const offDone = await listen<{ id: string; full: string }>('ai-done', (e) => {
    if (isStale(e.payload.id)) return
    adopt(e.payload.id)
    cleanupListeners()
    activeId = null
  })
  const offError = await listen<{ id: string; message: string }>('ai-error', (e) => {
    if (isStale(e.payload.id)) return
    adopt(e.payload.id)
    cleanupListeners()
    activeId = null
    notifyError(`AI 生成失败：${e.payload.message}`)
  })
  cleanups = [offChunk, offDone, offError]

  try {
    await invoke('ai_complete', { config, prompt })
  } catch (e) {
    cleanupListeners()
    activeId = null
    notifyError(e instanceof Error ? e.message : String(e))
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