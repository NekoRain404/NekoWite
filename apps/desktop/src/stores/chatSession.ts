/**
 * The chat session store: the reactive state (the sessions, which one is
 * active, the storage warning) and the actions the panel drives.
 *
 * The other concerns this file used to carry in 503 lines now live in the chat
 * feature, one module each, and it composes them:
 *
 *   features/chat/services/chat-session-model.ts    the stored shape and its
 *                                                   pure constructors/label rule
 *   features/chat/services/chat-image-budget.ts     the image caps, the notices
 *                                                   they raise, and the eviction
 *                                                   that enforces them
 *   features/chat/services/chat-session-storage.ts  the keyed document: sanitise
 *                                                   on read, shed images before
 *                                                   text on a refused write
 *
 * The wiring below is also the module graph: the store depends on all three and
 * none of them depends on the store, so each is testable on its own.
 *
 * What stays here is the state and the actions over it (§10.2). The names at the
 * bottom are the compatibility surface (§10.1.5), not a second implementation.
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  applyImageCaps,
  STORAGE_WARNING_FULL,
  STORAGE_WARNING_IMAGES,
} from '../features/chat/services/chat-image-budget'
import { createSession, titleFromText } from '../features/chat/services/chat-session-model'
import type { ChatSession, ChatSessionMessage } from '../features/chat/services/chat-session-model'
import {
  loadSessions,
  saveSessions,
  toStoredMessage,
} from '../features/chat/services/chat-session-storage'
import type { SaveOutcome } from '../features/chat/services/chat-session-storage'

/** The warning a write leaves on screen, by what it managed to store. A write
 *  that lands in full clears it. */
const WARNING_FOR_SAVE: Record<SaveOutcome, string | null> = {
  saved: null,
  'text-only': STORAGE_WARNING_IMAGES,
  nothing: STORAGE_WARNING_FULL,
}

export const useChatSessionStore = defineStore('chatSession', () => {
  const sessions = ref<ChatSession[]>([])
  const activeId = ref<string | null>(null)
  /** Set when the last persist could not store everything (see the
   *  STORAGE_WARNING_* constants in the feature's image-budget module).
   *  Cleared as soon as a write lands in full. */
  const storageWarning = ref<string | null>(null)

  function loadAll(): void {
    const restored = loadSessions()
    sessions.value = restored.sessions
    activeId.value = restored.activeId
    persist()
  }

  function persist(): void {
    storageWarning.value = WARNING_FOR_SAVE[saveSessions(sessions.value, activeId.value)]
  }

  const activeSession = computed<ChatSession | null>(
    () => sessions.value.find((s) => s.id === activeId.value) ?? null,
  )

  function newSession(): ChatSession {
    const session = createSession()
    sessions.value = [...sessions.value, session]
    activeId.value = session.id
    persist()
    return session
  }

  function switchSession(id: string | null): void {
    if (id !== null && !sessions.value.some((s) => s.id === id)) return
    activeId.value = id
    persist()
  }

  function deleteSession(id: string): void {
    if (!sessions.value.some((s) => s.id === id)) return
    sessions.value = sessions.value.filter((s) => s.id !== id)
    if (activeId.value === id) {
      if (sessions.value.length === 0) {
        const seeded = createSession()
        sessions.value = [seeded]
        activeId.value = seeded.id
      } else {
        activeId.value = sessions.value[0].id
      }
    }
    persist()
  }

  function renameSession(id: string, title: string): void {
    const session = sessions.value.find((s) => s.id === id)
    if (!session) return
    session.title = title
    persist()
  }

  /** Append a message to the active session. The session title is derived from
   * the first non-empty user message when it has none yet. In-memory only. */
  function appendMessage(message: ChatSessionMessage): void {
    const session = activeSession.value
    if (!session) return
    if (!session.title && message.role === 'user' && message.content) {
      session.title = titleFromText(message.content)
    }
    session.messages = [...session.messages, message]
    session.updated = Date.now()
    applyImageCaps(sessions.value)
  }

  /** Patch the newest message of the active session (used while streaming).
   * In-memory only — callers persist at message boundaries. */
  function updateLast(patch: Partial<ChatSessionMessage>): void {
    const session = activeSession.value
    if (!session || session.messages.length === 0) return
    const index = session.messages.length - 1
    session.messages = session.messages.map((m, i) => (i === index ? { ...m, ...patch } : m))
    session.updated = Date.now()
    applyImageCaps(sessions.value)
  }

  /** Replace the active session's messages, deriving the title from the first
   * user message when it is still untitled. Persists immediately. */
  function setMessages(messages: ChatSessionMessage[]): void {
    const session = activeSession.value
    if (!session) return
    session.messages = messages.map(toStoredMessage)
    session.updated = Date.now()
    if (!session.title) {
      const first = session.messages.find((m) => m.role === 'user' && m.content)
      if (first) session.title = titleFromText(first.content)
    }
    applyImageCaps(sessions.value)
    persist()
  }

  /** Clear the active session's messages and title. */
  function clearMessages(): void {
    const session = activeSession.value
    if (!session) return
    session.messages = []
    session.title = ''
    session.updated = Date.now()
    persist()
  }

  loadAll()

  return {
    sessions,
    activeId,
    activeSession,
    storageWarning,
    newSession,
    switchSession,
    deleteSession,
    renameSession,
    appendMessage,
    updateLast,
    setMessages,
    clearMessages,
    persist,
  }
})

/* ---------------------------------------------------------------------------
 * Compatibility surface (§10.1.5), ONE stage only.
 *
 * The names this module exported before the split, kept resolvable from
 * `stores/chatSession` so that every existing importer - the panel's
 * composables, the attachment intake, the session bar - keeps working without
 * being edited. New code imports them from `features/chat` (§13.11), which
 * re-exports the same names.
 *
 * The names are listed explicitly rather than `export *`ed from the modules.
 * This is the compatibility contract, not a copy of it: a helper the new modules
 * share internally (the storage module's own reader/writer, say) cannot leak
 * onto this surface by accident, and a name dropped here is a failing typecheck
 * rather than a silent absence.
 * ------------------------------------------------------------------------- */

/* The session model (`chat-session-model.ts`). */
export { createSession, createSessionId, titleFromText, TITLE_MAX_LENGTH } from '../features/chat/services/chat-session-model'
export type {
  ChatSession,
  ChatSessionImage,
  ChatSessionMessage,
  ChatSessionRole,
} from '../features/chat/services/chat-session-model'

/* The image budget and its enforcement (`chat-image-budget.ts`). */
export {
  applyImageCaps,
  DEFAULT_IMAGE_LIMITS,
  IMAGE_EVICTED_NOTICE,
  IMAGE_TOO_LARGE,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BASE64_LENGTH,
  MAX_IMAGE_BYTES_PER_SESSION,
  MAX_IMAGE_BYTES_TOTAL,
  STORAGE_WARNING_FULL,
  STORAGE_WARNING_IMAGES,
} from '../features/chat/services/chat-image-budget'
export type { ImageLimits } from '../features/chat/services/chat-image-budget'

/* The storage key (`chat-session-storage.ts`). */
export { CHAT_SESSIONS_KEY } from '../features/chat/services/chat-session-storage'
