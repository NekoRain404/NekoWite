/**
 * The chat panel's state: the turns of the active conversation, the composer
 * drafts parked under each conversation, and the switches between them.
 *
 * This is the `state` half of the feature (§13.4); the actions that change
 * disk or the network live in `useChatCommands`. The chat-session store is read
 * and written here and nowhere else in the feature (§10.2), which is why the
 * components receive refs and functions instead of the store.
 */

import { computed, onMounted, ref, type ComputedRef, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import {
  useChatSessionStore,
  type ChatSession,
  type ChatSessionMessage,
} from '../../../stores/chat-session'
import { t } from '../../../i18n'
import type { ChatAttachment, PanelMessage } from '../types'

export interface UseChatSessionOptions {
  /** The composer's half-written question. A draft parks it under the session
   *  it was written for and restores it with that session. */
  prompt: Ref<string>
  /** The composer's pending images, parked and restored with the question. */
  attachments: Ref<ChatAttachment[]>
  /** Release the object URLs a discarded draft held. The attachments module
   *  owns those URLs; this module must not revoke them behind its back. */
  releaseUrls(list: ChatAttachment[]): void
}

export interface ChatSessionModel {
  /** The panel's working copy of the active conversation's turns. */
  messages: Ref<PanelMessage[]>
  sessions: Ref<ChatSession[]>
  activeId: Ref<string | null>
  /** The store reports a write that could not store everything (see
   *  `chatSession.storageWarning`). Without this banner the user only finds out
   *  after a restart, when the images - or the whole conversation - are gone. */
  storageWarningText: ComputedRef<string>
  /** Commit the working copy to the active session and persist. */
  syncSession(): void
  /** Move the active conversation, parking the current draft and restoring the
   *  one belonging to `id` (`null` opens a new conversation). */
  switchToSession(id: string | null): void
  deleteActiveSession(): void
  /** Drop a stashed draft without releasing its URLs - for a caller that has
   *  just released them itself (a sent message, a cleared conversation). */
  forgetDraft(id: string): void
  /** Release the object URLs of every parked draft. Called on unmount: the
   *  drafts live only as long as this panel, so nothing must survive it. */
  releaseDrafts(): void
}

/** Strip transient `streaming` before persisting; keep images and the
 * interrupted marker as-is. */
function toSessionMessage(m: PanelMessage): ChatSessionMessage {
  const stored: ChatSessionMessage = { role: m.role, content: m.content }
  if (m.images && m.images.length) stored.images = m.images
  if (m.imageNotice) stored.imageNotice = m.imageNotice
  if (m.usageTotal) stored.usageTotal = m.usageTotal
  if (m.interrupted) stored.interrupted = true
  return stored
}

function fromSessionMessage(m: ChatSessionMessage): PanelMessage {
  const msg: PanelMessage = { role: m.role, content: m.content }
  if (m.images && m.images.length) msg.images = m.images
  // The store explains here why an image is missing ("too large", "removed,
  // storage limit"). Dropping the notice - which this did - turned a refused
  // attachment into a message that quietly sent without it.
  if (m.imageNotice) msg.imageNotice = m.imageNotice
  if (m.usageTotal) msg.usageTotal = m.usageTotal
  if (m.interrupted) msg.interrupted = true
  return msg
}

export function useChatSession(options: UseChatSessionOptions): ChatSessionModel {
  const chatSessions = useChatSessionStore()
  // The refs themselves, not the unwrapped values: the store replaces its
  // `sessions` array on every change, so a value captured once would go stale.
  const { sessions, activeId } = storeToRefs(chatSessions)
  const messages = ref<PanelMessage[]>([])

  /** Load the active session's messages (on mount and on session switch). */
  function loadActiveSession(): void {
    const session = chatSessions.activeSession
    messages.value = session ? session.messages.map(fromSessionMessage) : []
  }

  /** Commit the working copy to the active session and persist. */
  function syncSession(): void {
    chatSessions.setMessages(messages.value.map(toSessionMessage))
  }

  /**
   * Composer state per session: the half-written question and its attachments.
   *
   * Switching to another session to check something and coming back used to find
   * the composer empty - the text you were mid-way through was simply gone, and
   * with it the images you had attached. A draft belongs to the conversation it
   * was written for, so it is parked under that session and restored with it.
   */
  const drafts = new Map<string, { prompt: string; attachments: ChatAttachment[] }>()

  function stashDraft(): void {
    const id = chatSessions.activeId
    if (!id) return
    if (!options.prompt.value && options.attachments.value.length === 0) {
      drafts.delete(id)
      return
    }
    drafts.set(id, {
      prompt: options.prompt.value,
      attachments: [...options.attachments.value],
    })
  }

  /** Drop a stashed draft and release the object URLs it holds. */
  function discardDraft(id: string): void {
    const draft = drafts.get(id)
    if (!draft) return
    options.releaseUrls(draft.attachments)
    drafts.delete(id)
  }

  function restoreDraft(): void {
    const id = chatSessions.activeId
    const draft = id ? drafts.get(id) : undefined
    options.prompt.value = draft?.prompt ?? ''
    options.attachments.value = draft ? [...draft.attachments] : []
  }

  function switchToSession(id: string | null): void {
    stashDraft()
    if (id === null) chatSessions.newSession()
    else chatSessions.switchSession(id)
    loadActiveSession()
    restoreDraft()
  }

  function deleteActiveSession(): void {
    const removed = chatSessions.activeId
    // The draft goes with the conversation it belonged to: keeping it would
    // attach a question to whatever session happens to be next.
    if (removed) discardDraft(removed)
    chatSessions.deleteSession(removed ?? '')
    loadActiveSession()
    restoreDraft()
  }

  function forgetDraft(id: string): void {
    drafts.delete(id)
  }

  function releaseDrafts(): void {
    for (const id of [...drafts.keys()]) discardDraft(id)
  }

  const storageWarningText = computed(() => {
    const warning = chatSessions.storageWarning
    if (warning === 'images-not-persisted') return t('chat.storageImagesDropped')
    if (warning === 'history-not-persisted') return t('chat.storageFull')
    return ''
  })

  onMounted(() => {
    loadActiveSession()
  })

  return {
    messages,
    sessions,
    activeId,
    storageWarningText,
    syncSession,
    switchToSession,
    deleteActiveSession,
    forgetDraft,
    releaseDrafts,
  }
}
