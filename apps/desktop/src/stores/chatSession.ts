import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export type ChatSessionRole = 'user' | 'assistant'

export interface ChatSessionImage {
  id: string
  name: string
  dataUrl: string
}

export interface ChatSessionMessage {
  role: ChatSessionRole
  content: string
  images?: ChatSessionImage[]
  /** Human-readable short status explaining images that were refused or
   * evicted by a storage cap (e.g. "image too large"). */
  imageNotice?: string
}

export interface ChatSession {
  id: string
  title: string
  created: number
  updated: number
  messages: ChatSessionMessage[]
}

export const CHAT_SESSIONS_KEY = 'nekowite.chat.sessions'
export const TITLE_MAX_LENGTH = 20
/** Cap images saved per message so a data-URL heavy chat cannot blow the
 * localStorage quota on its own. */
const MAX_IMAGES_PER_MESSAGE = 4

/** Max base64 length (≈ bytes on disk) of a single image Data URL. Images
 * larger than this are refused: the image is not stored and the message is
 * marked "image too large" instead of being silently dropped or overflowing
 * storage. Tune here. */
export const MAX_IMAGE_BASE64_LENGTH = 2 * 1024 * 1024 // ~2 MB of base64 text

/** Max aggregate base64 length of all image Data URLs in one session. When an
 * append would cross this, the session's OLDEST images are evicted first.
 * Tune here. */
export const MAX_IMAGE_BYTES_PER_SESSION = 16 * 1024 * 1024 // ~16 MB

/** Max aggregate base64 length of all image Data URLs across every session.
 * Beyond this the least-recently-updated sessions lose images first.
 * Tune here. */
export const MAX_IMAGE_BYTES_TOTAL = 32 * 1024 * 1024 // ~32 MB

/** Status notice attached to a message whose image was refused by the
 * per-image size cap. */
export const IMAGE_TOO_LARGE = 'image too large'

/** Status notice attached to a message whose images were evicted by a storage
 * budget. */
export const IMAGE_EVICTED_NOTICE = 'image(s) removed (storage limit)'

/** The three image budgets, split out so they can be overridden for tests or
 * tuned in one place. */
export interface ImageLimits {
  maxPerImage: number
  maxPerSession: number
  maxTotal: number
}

export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  maxPerImage: MAX_IMAGE_BASE64_LENGTH,
  maxPerSession: MAX_IMAGE_BYTES_PER_SESSION,
  maxTotal: MAX_IMAGE_BYTES_TOTAL,
}

interface StoredState {
  v: 1
  activeId: string | null
  sessions: ChatSession[]
}

/** Collapse whitespace and derive a short session label from the first user
 * message. `max` is in characters; a longer title gets an ellipsis. */
export function titleFromText(text: string, max = TITLE_MAX_LENGTH): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (!collapsed) return ''
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max)}…`
}

let idSeq = 0

/** Unique id for a session: crypto UUID when available, a time-based fallback
 * for older webviews/tests. */
export function createSessionId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    /* fall through */
  }
  idSeq += 1
  return `sess-${Date.now().toString(36)}-${idSeq}`
}

export function createSession(partial?: Partial<ChatSession>): ChatSession {
  const now = Date.now()
  return {
    id: createSessionId(),
    title: '',
    created: now,
    updated: now,
    messages: [],
    ...partial,
  }
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
function toStoredMessage(message: ChatSessionMessage): ChatSessionMessage {
  const out: ChatSessionMessage = { role: message.role, content: message.content }
  if (message.images && message.images.length) out.images = message.images
  if (message.imageNotice) out.imageNotice = message.imageNotice
  return out
}

function imageBytesOf(msg: ChatSessionMessage): number {
  return (msg.images ?? []).reduce((sum, img) => sum + img.dataUrl.length, 0)
}

function sessionImageBytes(session: ChatSession): number {
  return session.messages.reduce((sum, msg) => sum + imageBytesOf(msg), 0)
}

function totalImageBytes(sessions: ChatSession[]): number {
  return sessions.reduce((sum, s) => sum + sessionImageBytes(s), 0)
}

/** Append an explanation to a message's existing notice, or set it. */
function markNotice(msg: ChatSessionMessage, notice: string): void {
  msg.imageNotice = msg.imageNotice ? `${msg.imageNotice}; ${notice}` : notice
}

/** Render an eviction summary (for tests) and set a notice on every message
 * that actually lost images. */
function noticeEviction(msg: ChatSessionMessage, before: number): void {
  if (before !== (msg.images?.length ?? 0)) markNotice(msg, IMAGE_EVICTED_NOTICE)
}

/** Enforce image storage caps over a list of sessions, mutating in place:
 *  1. drop images over `maxPerImage` and beyond `MAX_IMAGES_PER_MESSAGE`;
 *  2. keep each session under `maxPerSession`, evicting oldest images first;
 *  3. keep the cross-session total under `maxTotal`, evicting from the
 *     least-recently-updated session first.
 * Affected messages get an `imageNotice` so the UI can explain what happened.
 * Returns the number of images dropped/evicted. */
export function applyImageCaps(
  sessions: ChatSession[],
  limits: ImageLimits = DEFAULT_IMAGE_LIMITS,
): number {
  let dropped = 0

  // 1. Per-image size cap + per-message count cap.
  for (const session of sessions) {
    for (const msg of session.messages) {
      if (!msg.images || msg.images.length === 0) continue
      const kept: ChatSessionImage[] = []
      let notice: string | undefined
      for (const img of msg.images) {
        if (img.dataUrl.length > limits.maxPerImage) {
          if (!notice) notice = IMAGE_TOO_LARGE
          dropped += 1
          continue
        }
        if (kept.length >= MAX_IMAGES_PER_MESSAGE) {
          if (!notice) notice = IMAGE_EVICTED_NOTICE
          dropped += 1
          continue
        }
        kept.push(img)
      }
      if (kept.length === 0) msg.images = undefined
      else msg.images = kept
      if (notice) msg.imageNotice = notice
    }
  }

  // 2. Per-session budget, evicting the session's oldest images first.
  for (const session of sessions) {
    let budget = sessionImageBytes(session)
    if (budget <= limits.maxPerSession) continue
    for (const msg of session.messages) {
      if (budget <= limits.maxPerSession) break
      const images = msg.images
      if (!images || images.length === 0) continue
      const before = images.length
      while (images.length > 0 && budget > limits.maxPerSession) {
        budget -= images.shift()!.dataUrl.length
        dropped += 1
      }
      if (images.length === 0) msg.images = undefined
      noticeEviction(msg, before)
    }
  }

  // 3. Cross-session budget, evicting from least-recently-updated sessions.
  let total = totalImageBytes(sessions)
  if (total > limits.maxTotal) {
    const lru = [...sessions].sort((a, b) => a.updated - b.updated)
    for (const session of lru) {
      if (total <= limits.maxTotal) break
      for (const msg of session.messages) {
        if (total <= limits.maxTotal) break
        const images = msg.images
        if (!images || images.length === 0) continue
        const before = images.length
        while (images.length > 0 && total > limits.maxTotal) {
          total -= images.shift()!.dataUrl.length
          dropped += 1
        }
        if (images.length === 0) msg.images = undefined
        noticeEviction(msg, before)
      }
    }
  }

  if (dropped > 0) {
    console.warn(`[chatSession] image caps: dropped/evicted ${dropped} image(s)`)
  }
  return dropped
}

export const useChatSessionStore = defineStore('chatSession', () => {
  const sessions = ref<ChatSession[]>([])
  const activeId = ref<string | null>(null)

  function loadAll(): void {
    let next: ChatSession[] = []
    let nextActive: string | null = null
    try {
      const raw = localStorage.getItem(CHAT_SESSIONS_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<StoredState>
        if (Array.isArray(parsed.sessions)) {
          next = parsed.sessions
            .map(sanitizeSession)
            .filter((s): s is ChatSession => s !== null)
        }
        if (typeof parsed.activeId === 'string') nextActive = parsed.activeId
      }
    } catch (err) {
      // Corrupted / private-mode storage: fall through to a fresh state.
      console.warn('[chatSession] load failed, starting fresh', err)
    }
    // Re-assert image budgets on load so legacy oversized/over-budget data
    // is pruned (and your images are evicted oldest-first / LRU) rather than
    // breaking JSON parsing or blow the quota on the next persist.
    applyImageCaps(next)
    if (!next.some((s) => s.id === nextActive)) nextActive = null
    if (next.length === 0) {
      const seeded = createSession()
      next = [seeded]
      nextActive = seeded.id
    }
    sessions.value = next
    activeId.value = nextActive
    persist()
  }

  function persist(): void {
    const payload: StoredState = {
      v: 1,
      activeId: activeId.value,
      sessions: sessions.value.map((s) => ({
        id: s.id,
        title: s.title,
        created: s.created,
        updated: s.updated,
        messages: s.messages.map(toStoredMessage),
      })),
    }
    try {
      localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(payload))
    } catch (err) {
      // Quota exceeded because of image data-URLs: retry text-only, otherwise
      // give up quietly — an in-memory session is better than a thrown error.
      console.warn('[chatSession] persist failed, retrying without images', err)
      const textOnly: StoredState = {
        ...payload,
        sessions: payload.sessions.map((s) => ({
          ...s,
          messages: s.messages.map((m) => ({ role: m.role, content: m.content })),
        })),
      }
      try {
        localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(textOnly))
      } catch (innerErr) {
        console.warn('[chatSession] persist failed even without images', innerErr)
      }
    }
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