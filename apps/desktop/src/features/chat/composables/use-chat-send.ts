/**
 * One send, from the press to the last chunk: the states it moves through, what
 * a second press may and may not do, and how an outcome is matched back to the
 * send that produced it.
 *
 * Its own module because that is one concern end to end (§13.3): a request the
 * panel starts and then has to keep straight - a composer that stays live while
 * it prepares, an answer that outlives the press, and two ways of giving it up
 * (stopped, or abandoned because the conversation moved). The panel's other
 * commands compose this one; see `use-chat-commands`.
 *
 * It is the `command` half of the feature (§13.4): it reaches the session store
 * (to clear a conversation and to forget a parked draft) and the network
 * through `startChatCompletion`. Nothing here renders, and the store is read
 * and written here rather than in a component (§10.2).
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { aiService, startChatCompletion, usageTotal } from '../../ai'
import { notifyError } from '../../../services/errors'
import { useSettingsStore } from '../../../stores/settings'
import { useChatSessionStore } from '../../../stores/chat-session'
import { t } from '../../../i18n'
import { buildChatPrompt, type ChatImage, type ChatMessage } from '../services/chat-logic'
import type { ChatAttachment, PanelMessage } from '../types'
import { encodeAttachments } from './use-chat-attachments'

export interface ChatSendOptions {
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
  /** The context block for the active note, and how much of it was left out. */
  buildActiveContext(): Promise<{ text: string; omitted: number }>
  /** Keep the transcript pinned to its newest turn. */
  scrollToBottom(): void
}

export interface ChatSendModel {
  /** False while a send is preparing or streaming, or when there is nothing to
   *  send. The button and the Enter key both read it. */
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
}

export function useChatSend(options: ChatSendOptions): ChatSendModel {
  const settings = useSettingsStore()
  const chatSessions = useChatSessionStore()

  /**
   * Where the panel's send is. `preparing` is a state of its own and not a
   * detail of `streaming`: it is the window in which the button has been
   * pressed but nothing is on the wire yet - the context build and the image
   * encode are both awaits - and it is the window a second press used to slip
   * through. One value rather than two booleans, because "may this press start
   * a send" is a single question (§13.7).
   */
  type SendPhase = 'idle' | 'preparing' | 'streaming'
  const phase = ref<SendPhase>('idle')
  /** Which send the panel is on. Every outcome a request reports back carries
   *  the send that started it, so an answer - or a failure - belonging to a
   *  request the user has already replaced cannot decide for the live one. */
  let sendSeq = 0
  /** The placeholder the live request streams into, held by IDENTITY and not by
   *  index: an index points into whatever conversation the panel happens to be
   *  showing by the time a late outcome arrives.
   *
   *  A `PanelMessage`, not the `ChatMessage` the prompt is built from: the
   *  markers this path writes - `streaming`, `interrupted`, the provider's
   *  token count - are the PANEL's, and the prompt type is deliberately the
   *  smaller one so none of them can leak into what the model is sent. */
  let live: PanelMessage | null = null
  let cancelFn: (() => void) | null = null
  /** Set on unmount: a `send()` still encoding context/images must not start a
   *  request the destroyed panel could never show, cancel or persist. */
  let disposed = false

  const canSend = computed(
    () =>
      phase.value === 'idle' &&
      (options.prompt.value.trim().length > 0 || options.attachments.value.length > 0),
  )

  async function send(): Promise<void> {
    // The lock, taken BEFORE the first await. Checked against `streaming` alone
    // it was too late: the context build and the image encode both await, and
    // until they finish nothing had claimed the panel — so a double-click, a
    // repeated Enter and a press on a button the browser had not repainted yet
    // each started a request of their own, and the user paid for every one.
    if (phase.value !== 'idle') return
    const text = options.prompt.value.trim()
    // Frozen here, for the same reason: the composer stays usable while this
    // prepares, and an image attached after the press belongs to the NEXT
    // question — a send that read the list later would carry it off with it.
    const images = [...options.attachments.value]
    if (!text && images.length === 0) return

    const mySend = ++sendSeq
    phase.value = 'preparing'

    /** The conversation this question was written for, read before the first
     *  await: both the panel's working copy and the store's active session move
     *  under a send that is still preparing. */
    const startedIn = chatSessions.activeId

    /** Give the composer back: this press is not becoming a send. Every refusal
     *  below leaves through here, because a refused send that kept the phase
     *  would leave the panel unable to send anything at all.
     *
     *  Only while this send still holds it, though — `stop`, `clearAll` and a
     *  newer send can each have taken the phase over while it was preparing,
     *  and handing it back then would unlock one of THEIRS. */
    function giveUp(): void {
      if (mySend === sendSeq) phase.value = 'idle'
    }

    /** Refuse a send whose conversation has moved under it, and say so.
     *
     *  `switchToSession` REPLACES the panel's working copy and moves the store's
     *  active session, so a send that resumes afterwards would append the
     *  question, the assistant placeholder and the streamed answer to a
     *  transcript the user is not looking at, persist that whole thing under the
     *  other conversation, and `forgetDraft` the OTHER conversation's parked
     *  draft while its own composer copy had already been cleared. The question
     *  is not lost by refusing: the switch parked it - with its images - under
     *  the conversation it was written for, so going back finds it in the
     *  composer, editable, and it is never filed anywhere else. */
    function abandoned(): boolean {
      if (chatSessions.activeId === startedIn) return false
      notifyError(t('chat.sessionMoved'))
      return true
    }

    let context = ''
    let imageDataUrls: ChatImage[]
    try {
      if (options.attachContext.value) {
        if (!options.hasActiveTab.value) {
          // No document at all: naming that is right, because the switch is on.
          notifyError(t('chat.emptyDocHint'))
          giveUp()
          return
        }
        const built = await options.buildActiveContext()
        context = built.text
        // The note was longer than the budget. The model is told (the block
        // carries the count), and until now it was the only one: the notice
        // rides inside the context, so the person who wrote the note never saw
        // it. This is the send that answer belongs to, not a settings screen
        // they would have to go and read.
        if (built.omitted > 0) {
          notifyError(t('aiSettings.contextTruncatedNotice', { omitted: built.omitted }))
        }
        // Before the images of the conversation the user moved to are encoded
        // for a question that is no longer going there.
        if (abandoned()) {
          giveUp()
          return
        }
        // An EMPTY note is not a missing document. Refusing to send here blocked
        // exactly the scenario the feature is for — "help me outline this" on a
        // note you just created — with a message claiming no document was open
        // while one plainly was. The message goes out without context, and the
        // user is told why it carries nothing.
        if (!context) notifyError(t('chat.emptyDocSent'))
      }
      imageDataUrls = await encodeAttachments(images)
    } catch {
      // Every caller is `void send()`, so a rejection here is an unhandled one:
      // the button would look alive while nothing happened at all. State is
      // untouched on this path, so the user can drop the image and retry.
      notifyError(t('chat.sendFailed'))
      giveUp()
      return
    }

    // The rail can close while the context/images above were still encoding;
    // starting now would leave a request running with no panel left to show or
    // cancel it (onBeforeUnmount has already made its own pass).
    if (disposed) {
      giveUp()
      return
    }
    // The user stopped a send that had not gone out yet (`stop` retires it by
    // bumping the counter, and has already given the composer back), or a newer
    // send has taken the panel. Either way this one has no request to start.
    if (mySend !== sendSeq) return
    // The last check before anything is written: every await above may have
    // carried the app into another conversation.
    if (abandoned()) {
      giveUp()
      return
    }

    const userMessage: ChatMessage = { role: 'user', content: text, images: imageDataUrls }
    const history = [...options.messages.value, userMessage]
    options.messages.value = [...options.messages.value, userMessage]
    options.syncSession()
    options.prompt.value = ''
    options.clearAttachments()
    // `startedIn`, not the store's active id: the two are equal here (that is
    // what the check above established), and naming the session the question
    // was written for is the one that cannot go wrong later.
    if (startedIn) options.forgetDraft(startedIn)

    const chatPrompt = buildChatPrompt(history.map((m) => ({ role: m.role, content: m.content })), { context })
    options.messages.value = [
      ...options.messages.value,
      { role: 'assistant', content: '', streaming: true },
    ]
    // The placeholder as the PANEL holds it, read back out of the list rather
    // than kept from the push above: `messages` is a reactive ref, so what went
    // in is wrapped, and only a write through the wrapper reaches the
    // transcript. It is also this send's identity - the same object the list
    // contains - which is what lets a stale outcome fail to find it.
    const reply = options.messages.value[options.messages.value.length - 1]!
    phase.value = 'streaming'
    live = reply
    cancelFn = null
    options.scrollToBottom()

    const config = settings.config()
    const imageUrls = imageDataUrls.map((img) => img.dataUrl)
    // Every handler below is handed the placeholder itself and the send it
    // belongs to: this answer is this send's, and the panel's state is only
    // touched when the send reporting it is still the live one.
    void startChatCompletion(config, chatPrompt, imageUrls, {
      onChunk: (chunk) => {
        reply.content = chunk
        options.scrollToBottom()
      },
      onDone: (full, usage) => {
        const total = usageTotal(usage)
        if (total !== null) reply.usageTotal = total
        reply.content = full || reply.content
        finalize(mySend, reply, true)
        options.scrollToBottom()
      },
      onError: (msg) => {
        // An answer that already streamed text before the connection died is a
        // PARTIAL answer, and must say so: presenting half a paragraph as the
        // finished reply is how a user quotes a sentence the model never
        // completed. (The panel-close path already marks this; the failure path
        // did not.)
        const partial = reply.content.length > 0
        finalize(mySend, reply, partial, partial)
        notifyError(t('chat.genFailed', { msg }))
      },
    })
      .then((stream) => {
        if (mySend === sendSeq && phase.value === 'streaming') cancelFn = stream.cancel
      })
      .catch(() => undefined)
  }

  /** End one send: mark or drop the placeholder it streamed into, and - when
   *  that send is still the live one - hand the panel back.
   *
   *  The placeholder is found by identity, so a late outcome can never mark a
   *  message of the conversation the user has moved to. The phase and the
   *  cancel handle belong to the LIVE send, and a request the user has already
   *  replaced owns neither: clearing them from a stale outcome killed the
   *  running answer's spinner and dropped its handle while it was still
   *  arriving.
   *
   *  `reply` is a `PanelMessage` because that is what the panel's working copy
   *  holds - and because `interrupted` is one of ITS fields. Widening the
   *  parameter to the prompt-shaped `ChatMessage` would leave that flag written
   *  through a type that does not declare it, which is a claim nothing checks. */
  function finalize(send: number, reply: PanelMessage, retainEmpty: boolean, interrupted = false): void {
    if (retainEmpty || reply.content) {
      reply.streaming = false
      if (interrupted) reply.interrupted = true
    } else {
      options.messages.value = options.messages.value.filter((m) => m !== reply)
    }
    if (send !== sendSeq) return
    if (live === reply) live = null
    phase.value = 'idle'
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
    if (phase.value === 'preparing') {
      // Nothing is on the wire yet, so stopping is refusing this send rather
      // than cancelling a request. Retiring it - the bump - is what makes it
      // give up as it resumes; the question stays in the composer, unsent and
      // editable, because none of it has been taken yet.
      sendSeq += 1
      phase.value = 'idle'
      return
    }
    if (!live) return
    cancelCompletion()
    finalize(sendSeq, live, false)
  }

  function stopIfStreaming(): void {
    if (phase.value === 'streaming') stop()
  }

  function interruptStream(): void {
    if (phase.value !== 'streaming' || !live) return
    cancelCompletion()
    // Retain an empty placeholder too: a bubble that says "interrupted" is more
    // honest than a question whose reply simply vanished.
    finalize(sendSeq, live, true, true)
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
    // The conversation the running answer belonged to is being thrown away, and
    // the send that started it is retired with it: a late outcome must not land
    // in the transcript that replaces this one.
    sendSeq += 1
    live = null
    phase.value = 'idle'
    options.messages.value = []
    chatSessions.clearMessages()
    options.clearAttachments()
    options.prompt.value = ''
    const id = chatSessions.activeId
    if (id) options.forgetDraft(id)
  }

  return {
    canSend,
    send,
    stop,
    stopIfStreaming,
    interruptStream,
    dispose,
    clearAll,
  }
}
