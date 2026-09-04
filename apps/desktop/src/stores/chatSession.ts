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
  if (message.images && message.images.length) {
    return { role: message.role, content: message.content, images: message.images }
  }
  return { role: message.role, content: message.content }
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
    } catch {
      // Corrupted / private-mode storage: fall through to a fresh state.
    }
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
    } catch {
      // Quota exceeded because of image data-URLs: retry text-only, otherwise
      // give up quietly — an in-memory session is better than a thrown error.
      const textOnly: StoredState = {
        ...payload,
        sessions: payload.sessions.map((s) => ({
          ...s,
          messages: s.messages.map((m) => ({ role: m.role, content: m.content })),
        })),
      }
      try {
        localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(textOnly))
      } catch {
        /* ignore */
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
  }

  /** Patch the newest message of the active session (used while streaming).
   * In-memory only — callers persist at message boundaries. */
  function updateLast(patch: Partial<ChatSessionMessage>): void {
    const session = activeSession.value
    if (!session || session.messages.length === 0) return
    const index = session.messages.length - 1
    session.messages = session.messages.map((m, i) => (i === index ? { ...m, ...patch } : m))
    session.updated = Date.now()
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