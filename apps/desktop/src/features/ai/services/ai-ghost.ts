/**
 * The inline-suggestion lifecycle: the ghost writer's request and the two
 * keystrokes that finish it.
 *
 * Its own module, separate from `ai-chat.ts`, because the two differ in what
 * they are allowed to do, not only in how they stream: this one is a WRITE path
 * — the suggestion's whole purpose is to be accepted into the document — so it
 * is gated twice, once before the request is made and again before the text is
 * inserted. A change to that policy must not be able to drift into the chat
 * path's copy of the plumbing.
 *
 * It shares the stream registry, the gate and the thinking flag with the chat
 * lifecycle through their modules; it does not own any of them.
 */

import type { NekoEditor } from '@nekowite/editor-core'
import { editorSessionManager } from '../../editor/sessionManager'
import { notifyError } from '../../../services/errors'
import { getSharedGateways } from '../../../platform/runtime/gatewayRuntime'
import { useSettingsStore } from '../../../stores/settings'
import type { AIConfig } from '../../../stores/settings'
import { recordAiAudit } from '../../../services/aiAudit'
import { t } from '../../../i18n'
import { buildAIPrompt, getCursorPrefix, type PrefixView } from './ai-prompt'
import { aiDisabled, aiWritesForbidden, announceBlock } from './ai-gate'
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
  const mySeq = bumpStreamGeneration()

  const editor = editorArg ?? editorSessionManager.getActiveEditor()
  if (!editor) return

  const config = configArg ?? useSettingsStore().config()
  const prefix = readPrefix(editor)
  const prompt = buildAIPrompt(prefix)

  const myId = nextRequestId()
  trackRequest(myId)

  let acc = ''
  let errorNotified = false

  const superseded = (): boolean => isSuperseded(mySeq)

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
    trackListener(offChunk)
    // Only this stream's own id finalizes it: a done/error event from another
    // request (e.g. one that was cancelled while its chunks were still in
    // flight) must not tear down this stream's listeners.
    const offDone = await getSharedGateways().events.on<{ id: string; full: string }>('ai-done', (e) => {
      if (superseded() || e.id !== myId) return
      releaseRequest(myId)
      cleanupListeners()
      markThinking(false)
    })
    if (superseded()) {
      offChunk()
      offDone()
      return
    }
    trackListener(offDone)
    const offError = await getSharedGateways().events.on<{ id: string; message: string }>('ai-error', (e) => {
      if (superseded() || e.id !== myId) return
      // If the raw invoke rejection was delivered before this event (and the
      // catch already toasted), skip the duplicate toast. Marked together with
      // the toast so a marked flag always means "an error was reported".
      if (!errorNotified) {
        errorNotified = true
        notifyError(t('error.aiGenFailed', { msg: e.message }))
      }
      releaseRequest(myId)
      cleanupListeners()
      markThinking(false)
    })
    if (superseded()) {
      offChunk()
      offDone()
      offError()
      return
    }
    trackListener(offError)
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
    trackListener(offReasoning)
  } catch (e) {
    cleanupListeners()
    releaseRequest(myId)
    notifyError(e instanceof Error ? e.message : String(e))
    return
  }

  if (superseded()) return

  try {
    await getSharedGateways().ai.complete(config, prompt, undefined, myId)
  } catch (e) {
    cleanupListeners()
    releaseRequest(myId)
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
  bumpStreamGeneration()
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
  bumpStreamGeneration()
  editorSessionManager.getActiveEditor()?.rejectSuggestion()
  cancelStream()
}

export const aiService = {
  triggerSuggestion,
  accept,
  reject,
  cancelStream,
}
