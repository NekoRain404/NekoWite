/**
 * The chat session model: what a stored conversation is, plus the pure helpers
 * that create and label one.
 *
 * Split out of `stores/chatSession.ts` (503 lines, past the §13.1 hard stop).
 * Three concerns used to share that file and none of them needs the others: the
 * image budget evicts from a session, the storage sanitises one, the store holds
 * them. All three need this shape, so it lives alone and imports nothing.
 *
 * `ChatSessionMessage` is NOT the panel's `ChatMessage` (`services/chatLogic.ts`,
 * the prompt a request is built from): this is the persisted turn - the one that
 * has to survive a relaunch - and the panel projects one onto the other.
 */

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
  /** True when the answer was cut off mid-stream — the panel that owned the
   * request was destroyed — instead of reaching a normal end. Lets a reopened
   * panel show partial text as incomplete rather than as a finished answer. */
  interrupted?: boolean
  /** Token total the provider reported for this answer, when it reported one.
   *  It is part of what a request cost, so it is persisted with the turn: a
   *  figure that disappears on relaunch cannot be compared with anything. */
  usageTotal?: number
}

export interface ChatSession {
  id: string
  title: string
  created: number
  updated: number
  messages: ChatSessionMessage[]
}

export const TITLE_MAX_LENGTH = 20

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
