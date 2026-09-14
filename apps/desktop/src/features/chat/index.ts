/**
 * The chat feature's public API.
 *
 * Nothing outside this feature imports one of its files by path (§13.11): a
 * caller goes through this entry point, so the internal layout
 * (components / composables / services) can change without touching a call
 * site, and two features cannot reach into each other's internals.
 *
 * The composables are deliberately absent. Unlike the notes and settings
 * features - where a second consumer already exists inside the feature and the
 * panel's sections are wired by the panel - the chat panel is this feature's
 * only caller, so its state, context and commands stay internal until
 * something else genuinely needs them (§13.11: shared code needs two real
 * callers).
 *
 * The session services are the exception: they are exported rather than kept
 * internal. They were split out of `stores/chatSession.ts`, which is now a
 * one-stage compatibility surface (§10.1.5) whose callers - the panel's
 * composables, the attachment intake, the session bar - still import them by the
 * old path. New callers reach the same names here, so the shim can be deleted
 * without touching a call site. The store itself is not here: it is app state,
 * and it composes these services (§10.2).
 */

export { default as ChatPanel } from './components/ChatPanel.vue'

export type { ChatAttachment, PanelMessage } from './types'

/* The session model: what a stored conversation is, plus its pure constructors
 * and the label rule the session bar renders. */
export { createSession, createSessionId, titleFromText, TITLE_MAX_LENGTH } from './services/chat-session-model'
export type {
  ChatSession,
  ChatSessionImage,
  ChatSessionMessage,
  ChatSessionRole,
} from './services/chat-session-model'

/* The image budget: the caps that keep a conversation off the storage quota,
 * the notices they raise on a message, and the eviction that enforces them. */
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
} from './services/chat-image-budget'
export type { ImageLimits } from './services/chat-image-budget'

/* The stored document: its key, the sanitising read that re-asserts the image
 * budgets, and the write that sheds images before text when the quota bites. */
export { CHAT_SESSIONS_KEY, loadSessions, saveSessions, toStoredMessage } from './services/chat-session-storage'
export type { LoadedSessions, SaveOutcome } from './services/chat-session-storage'
