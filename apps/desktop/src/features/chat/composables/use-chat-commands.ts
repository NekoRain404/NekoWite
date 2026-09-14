/**
 * The commands the chat panel offers: send a question, stop the answer,
 * interrupt it when the panel goes away, clear the conversation, insert an
 * answer into the document and copy it.
 *
 * This is the `command` half of the feature (§13.4) - the state is
 * `useChatSession`, the pure prompt assembly is `services/chatLogic`. Each
 * command is handed what it acts on (the composer's draft, the working copy of
 * the conversation, the note context) rather than reaching for a mounted panel,
 * so the request path can be driven without one.
 *
 * The two AI settings the composer displays live here as well: they come from
 * the same settings store `send()` builds its request config from, and the
 * panel must not touch a store itself (§10.2).
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { aiService, startChatCompletion, usageTotal } from '../../ai'
import { notifyError } from '../../../services/errors'
import { insertMarkdownAtCursor } from '../../../services/editor-insert'
import { useSettingsStore, type ReasoningEffort } from '../../../stores/settings'
import { useTabsStore } from '../../../stores/tabs'
import { useChatSessionStore } from '../../../stores/chat-session'
import { useAiPermissionStore } from '../../../stores/ai-permission'
import { t } from '../../../i18n'
import { buildChatPrompt, type ChatImage, type ChatMessage } from '../services/chat-logic'
import type { ChatAttachment, PanelMessage } from '../types'
import { encodeAttachments } from './use-chat-attachments'

export interface UseChatCommandsOptions {
  /** The composer's question text. Cleared once the message goes out. */
  prompt: Ref<string>
  /** The panel's working copy of the active conversation. */
  messages: Ref<PanelMessage[]>
  /** The images attached to the question being sent. */
  attachments: Ref<ChatAttachment[]>
  /** Commit the working copy to the session store and persist it. */
  syncSession(): void
  /** Release the composer's attachments once they have been sent. */
  clearAttachments(): void
  /** Drop the parked draft of the session a message was just sent from. */
  forgetDraft(id: string): void
  /** The persisted "attach the current note" toggle (see `useChatContext`). */
  attachContext: Ref<boolean>
  /** Whether a document is open at all. */
  hasActiveTab: ComputedRef<boolean>
  /** The context block for the active note. */
  buildActiveContext(): Promise<string>
  /** Keep the transcript pinned to its newest turn. */
  scrollToBottom(): void
}

export interface ChatCommandsModel {
  /** The model label shown under the composer. */
  modelName: ComputedRef<string>
  /** The thinking depth the composer shows, and its write. */
  effort: ComputedRef<ReasoningEffort>
  setEffort(value: string): void
  /** False while a request is running, or when there is nothing to send. */
  canSend: ComputedRef<boolean>
  send(): Promise<void>
  stop(): void
  /** Stop only when this panel owns a live request: the app-level cancel is
   *  not a no-op, it cancels whatever the AI service is streaming. */
  stopIfStreaming(): void
  interruptStream(): void
  /** The unmount path's first half (see the comment on the panel's teardown). */
  dispose(): void
  clearAll(): void
  insertIntoDocument(msg: ChatMessage): Promise<void>
  copyMessage(msg: ChatMessage): Promise<void>
}

export function useChatCommands(options: UseChatCommandsOptions): ChatCommandsModel {
  const settings = useSettingsStore()
  const tabs = useTabsStore()
  const chatSessions = useChatSessionStore()

  const streaming = ref(false)
  let cancelFn: (() => void) | null = null
  /** Set on unmount: a `send()` still encoding context/images must not start a
   * request the destroyed panel could never show, cancel or persist. */
  let disposed = false

  const modelName = computed(() => settings.model)
  const effort = computed(() => settings.reasoningEffort)
  const canSend = computed(
    () =>
      !streaming.value &&
      (options.prompt.value.trim().length > 0 || options.attachments.value.length > 0),
  )

  /** The thinking-depth select writes straight through to the setting it shows:
   *  its options come from `EFFORT_OPTIONS`, so a value that arrives here is one
   *  of those. */
  function setEffort(value: string): void {
    settings.reasoningEffort = value as ReasoningEffort
  }

  async function send(): Promise<void> {
    if (streaming.value) return
    const text = options.prompt.value.trim()
    if (!text && options.attachments.value.length === 0) return

    let context = ''
    let imageDataUrls: ChatImage[]
    try {
      if (options.attachContext.value) {
        if (!options.hasActiveTab.value) {
          // No document at all: naming that is right, because the switch is on.
          notifyError(t('chat.emptyDocHint'))
          return
        }
        context = await options.buildActiveContext()
        // An EMPTY note is not a missing document. Refusing to send here blocked
        // exactly the scenario the feature is for — "help me outline this" on a
        // note you just created — with a message claiming no document was open
        // while one plainly was. The message goes out without context, and the
        // user is told why it carries nothing.
        if (!context) notifyError(t('chat.emptyDocSent'))
      }
      imageDataUrls = await encodeAttachments(options.attachments.value)
    } catch {
      // Every caller is `void send()`, so a rejection here is an unhandled one:
      // the button would look alive while nothing happened at all. State is
      // untouched on this path, so the user can drop the image and retry.
      notifyError(t('chat.sendFailed'))
      return
    }

    // The rail can close while the context/images above were still encoding;
    // starting now would leave a request running with no panel left to show or
    // cancel it (onBeforeUnmount has already made its own pass).
    if (disposed) return

    const userMessage: ChatMessage = { role: 'user', content: text, images: imageDataUrls }
    const history = [...options.messages.value, userMessage]
    options.messages.value = [...options.messages.value, userMessage]
    options.syncSession()
    options.prompt.value = ''
    options.clearAttachments()
    const sentFrom = chatSessions.activeId
    if (sentFrom) options.forgetDraft(sentFrom)

    const chatPrompt = buildChatPrompt(history.map((m) => ({ role: m.role, content: m.content })), { context })
    const assistant: ChatMessage = { role: 'assistant', content: '', streaming: true }
    options.messages.value = [...options.messages.value, assistant]
    const index = options.messages.value.length - 1
    streaming.value = true
    cancelFn = null
    options.scrollToBottom()

    const config = settings.config()
    const imageUrls = imageDataUrls.map((img) => img.dataUrl)
    void startChatCompletion(config, chatPrompt, imageUrls, {
      onChunk: (chunk) => {
        const m = options.messages.value[index]
        if (m) m.content = chunk
        options.scrollToBottom()
      },
      onDone: (full, usage) => {
        const m = options.messages.value[index]
        if (m) {
          const total = usageTotal(usage)
          if (total !== null) m.usageTotal = total
        }
        if (m) m.content = full || m.content
        finalize(index, true)
        options.scrollToBottom()
      },
      onError: (msg) => {
        // An answer that already streamed text before the connection died is a
        // PARTIAL answer, and must say so: presenting half a paragraph as the
        // finished reply is how a user quotes a sentence the model never
        // completed. (The panel-close path already marks this; the failure path
        // did not.)
        const partial = (options.messages.value[index]?.content ?? '').length > 0
        finalize(index, partial, partial)
        notifyError(t('chat.genFailed', { msg }))
      },
    })
      .then((stream) => {
        if (streaming.value) cancelFn = stream.cancel
      })
      .catch(() => undefined)
  }

  function finalize(index: number, retainEmpty: boolean, interrupted = false): void {
    const m = options.messages.value[index]
    if (m) {
      if (retainEmpty || m.content) {
        m.streaming = false
        if (interrupted) m.interrupted = true
      } else {
        options.messages.value = options.messages.value.filter((_, i) => i !== index)
      }
    }
    streaming.value = false
    cancelFn = null
    options.syncSession()
  }

  /** Cancel through both levels: this panel's own stream handle AND the app-level
   * registry. The handle is null until the start promise settles, so the registry
   * is what covers the "cancelled before it was cancellable" window. */
  function cancelCompletion(): void {
    const fn = cancelFn
    cancelFn = null
    fn?.()
    aiService.cancelStream()
  }

  function stop(): void {
    cancelCompletion()
    finalize(options.messages.value.length - 1, false)
  }

  function stopIfStreaming(): void {
    if (streaming.value) stop()
  }

  function interruptStream(): void {
    if (!streaming.value) return
    cancelCompletion()
    // Retain an empty placeholder too: a bubble that says "interrupted" is more
    // honest than a question whose reply simply vanished.
    finalize(options.messages.value.length - 1, true, true)
  }

  /** Unmount path. Closing the info rail destroys this panel, but the request is
   * owned by the app-level AI service and would keep streaming — and keep being
   * billed — into a component nobody can see. Cancel it and persist the turns
   * received so far, flagging the answer so a reopened panel shows it as cut off
   * instead of leaving the user's question looking unanswered. */
  function dispose(): void {
    disposed = true
    interruptStream()
  }

  function clearAll(): void {
    cancelCompletion()
    streaming.value = false
    options.messages.value = []
    chatSessions.clearMessages()
    options.clearAttachments()
    options.prompt.value = ''
    const id = chatSessions.activeId
    if (id) options.forgetDraft(id)
  }

  async function insertIntoDocument(msg: ChatMessage): Promise<void> {
    // Permission first: an insert the user declines must not touch the editor at
    // all (and must not half-apply before the question is answered).
    const approved = await useAiPermissionStore().ask({
      kind: 'insert',
      summary: t('aiperm.action.insert'),
      target: msg.content.trim().slice(0, 120),
    })
    if (!approved) {
      notifyError(t('aiperm.denied'))
      return
    }
    if (!tabs.activeTab) return
    try {
      // Mode-aware: in source mode the message has to land in the CodeMirror
      // text rather than in the hidden rendered model.
      const inserted = await insertMarkdownAtCursor(`\n\n${msg.content}\n\n`)
      if (inserted === false) notifyError(t('chat.editorNotReady'))
    } catch {
      notifyError(t('chat.insertFailed'))
    }
  }

  async function copyMessage(msg: ChatMessage): Promise<void> {
    try {
      await navigator.clipboard.writeText(msg.content)
    } catch {
      notifyError(t('chat.copyFailed'))
    }
  }

  return {
    modelName,
    effort,
    setEffort,
    canSend,
    send,
    stop,
    stopIfStreaming,
    interruptStream,
    dispose,
    clearAll,
    insertIntoDocument,
    copyMessage,
  }
}
