/**
 * The stored chat-session document: its key, its sanitising reader and its
 * quota-aware writer. This is the only chat module that touches `persistence`.
 *
 * Two decisions are worth keeping in view, because both protect the user from a
 * loss they cannot see coming:
 *
 * - The stored document is untrusted. It is writable by hand and by any other
 *   build on the same origin, so every field is validated on read and a
 *   malformed session is dropped rather than handed to the panel - and
 *   `interrupted` only holds when it is exactly `true`, so a stray truthy value
 *   cannot mark old answers as cut off.
 * - A refused write sheds images before text. The text of a conversation is what
 *   the user cannot retype, so when the quota rejects the payload the writer
 *   retries without the images and reports what happened instead of losing the
 *   whole history silently.
 */

import { persistence } from '../../../services/persistence'
import { applyImageCaps, MAX_IMAGES_PER_MESSAGE } from './chat-image-budget'
import { createSession } from './chat-session-model'
import type {
  ChatSession,
  ChatSessionImage,
  ChatSessionMessage,
  ChatSessionRole,
} from './chat-session-model'

export const CHAT_SESSIONS_KEY = 'nekowite.chat.sessions'

interface StoredState {
  v: 1
  activeId: string | null
  sessions: ChatSession[]
}

function isChatSessionRole(value: unknown): value is ChatSessionRole {
  return value === 'user' || value === 'assistant'
}

function sanitizeImage(value: unknown): ChatSessionImage | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.name !== 'string' || typeof o.dataUrl !== 'string') {
    return null
  }
  return { id: o.id, name: o.name, dataUrl: o.dataUrl }
}

function sanitizeMessage(value: unknown): ChatSessionMessage | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  if (!isChatSessionRole(o.role) || typeof o.content !== 'string') return null
  const msg: ChatSessionMessage = { role: o.role, content: o.content }
  if (Array.isArray(o.images)) {
    const images = o.images.map(sanitizeImage).filter((v): v is ChatSessionImage => v !== null)
    if (images.length) msg.images = images.slice(0, MAX_IMAGES_PER_MESSAGE)
  }
  if (typeof o.imageNotice === 'string') msg.imageNotice = o.imageNotice
  // Only an exact boolean is trusted: any other truthy value from a hand-edited
  // or foreign store would mark old answers as cut off.
  if (o.interrupted === true) msg.interrupted = true
  // Same rule as interrupted: a hand-edited or foreign store must not be
  // able to put an impossible count on screen.
  if (typeof o.usageTotal === "number" && Number.isFinite(o.usageTotal) && o.usageTotal > 0) {
    msg.usageTotal = Math.round(o.usageTotal)
  }
  return msg
}

function toTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function sanitizeSession(value: unknown): ChatSession | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.title !== 'string') return null
  if (!Array.isArray(o.messages)) return null
  const messages = o.messages
    .map(sanitizeMessage)
    .filter((m): m is ChatSessionMessage => m !== null)
  return {
    id: o.id,
    title: o.title,
    created: toTimestamp(o.created, Date.now()),
    updated: toTimestamp(o.updated, Date.now()),
    messages,
  }
}

/** Strip transient fields (`streaming`) before anything reaches storage. */
export function toStoredMessage(message: ChatSessionMessage): ChatSessionMessage {
  const out: ChatSessionMessage = { role: message.role, content: message.content }
  if (message.images && message.images.length) out.images = message.images
  if (message.imageNotice) out.imageNotice = message.imageNotice
  if (message.interrupted) out.interrupted = true
  if (message.usageTotal) out.usageTotal = message.usageTotal
  return out
}

/** A restored document that is safe to hand to the store: at least one session,
 *  and an `activeId` that names one of them. */
export interface LoadedSessions {
  sessions: ChatSession[]
  activeId: string | null
}

/** Read, sanitise and re-assert the image budgets over the stored document.
 *  Never throws - a corrupted or unreadable store starts from a fresh session
 *  rather than from a panel that cannot open. */
export function loadSessions(): LoadedSessions {
  let sessions: ChatSession[] = []
  let activeId: string | null = null
  try {
    const raw = persistence.get(CHAT_SESSIONS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredState>
      if (Array.isArray(parsed.sessions)) {
        sessions = parsed.sessions
          .map(sanitizeSession)
          .filter((s): s is ChatSession => s !== null)
      }
      if (typeof parsed.activeId === 'string') activeId = parsed.activeId
    }
  } catch (err) {
    // Corrupted / private-mode storage: fall through to a fresh state.
    console.warn('[chatSession] load failed, starting fresh', err)
  }
  // Re-assert image budgets on load so legacy oversized/over-budget data
  // is pruned (and your images are evicted oldest-first / LRU) rather than
  // breaking JSON parsing or blow the quota on the next persist.
  applyImageCaps(sessions)
  if (!sessions.some((s) => s.id === activeId)) activeId = null
  if (sessions.length === 0) {
    const seeded = createSession()
    sessions = [seeded]
    activeId = seeded.id
  }
  return { sessions, activeId }
}

/** What a write did: `saved` landed in full, `text-only` means the payload was
 *  refused and only the text (no images) reached storage, `nothing` means even
 *  the text did not fit. The store turns this into the warning the panel shows;
 *  the images of a `text-only` write are still in memory but will not come back
 *  after a reload. */
export type SaveOutcome = 'saved' | 'text-only' | 'nothing'

/** Write the whole session set through `persistence`. */
export function saveSessions(sessions: ChatSession[], activeId: string | null): SaveOutcome {
  const payload: StoredState = {
    v: 1,
    activeId,
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      created: s.created,
      updated: s.updated,
      messages: s.messages.map(toStoredMessage),
    })),
  }
  if (persistence.set(CHAT_SESSIONS_KEY, JSON.stringify(payload))) return 'saved'

  // The write did not land — almost always the localStorage quota, which the
  // per-message and per-session image budgets failed to prevent (other apps
  // on the same origin, or a big text history, can eat the budget too). Shed
  // the images: the text of a conversation is what the user cannot retype.
  console.warn('[chatSession] persist failed, retrying without images')
  let droppedImages = 0
  const textOnly: StoredState = {
    ...payload,
    sessions: payload.sessions.map((s) => ({
      ...s,
      messages: s.messages.map((m) => {
        if (!m.images?.length) return { role: m.role, content: m.content }
        droppedImages += m.images.length
        return { role: m.role, content: m.content }
      }),
    })),
  }
  if (persistence.set(CHAT_SESSIONS_KEY, JSON.stringify(textOnly))) {
    // The in-memory copy keeps its images so the open panel still shows them;
    // the warning the store raises explains why a reopened panel will not.
    if (droppedImages > 0) console.warn(`[chatSession] dropped ${droppedImages} image(s) to fit storage`)
    return 'text-only'
  }
  // Even the text does not fit. Say so: silently reporting success here is
  // how a whole conversation disappears at the next launch.
  console.warn('[chatSession] persist failed even without images')
  return 'nothing'
}
