/**
 * The types the chat panel and its composables share.
 *
 * `ChatMessage` / `ChatImage` - the shape a prompt is built from - stay in
 * `services/chatLogic.ts`, which is where the pure prompt code lives. What is
 * here is what a *panel instance* adds on top of them.
 */

import type { ChatMessage } from './services/chat-logic'

/** An image the composer is holding before it is sent: the picked `File` and
 *  the object URL the thumbnail renders from. That URL pins the whole file in
 *  memory, so it is released by `removeAttachment` / `clearAttachments` and
 *  never dropped on the floor. */
export interface ChatAttachment {
  id: string
  name: string
  file: File
  url: string
}

let messageSeq = 0

/**
 * Identity for a turn the panel is drawing.
 *
 * The transcript keys its rows by it, so it has to be created WITH the message
 * and never derived from one: a key computed in the template from the content
 * changes on every chunk of a streaming answer, and Vue answers a changed key by
 * throwing the row away and building a new one - which is the node the reader is
 * reading being destroyed and re-created mid-sentence, and any entrance
 * transition on it replayed per chunk. `role` cannot serve either: a
 * conversation is full of messages in the same role, and two rows sharing a key
 * is the other half of the same defect.
 *
 * It numbers rather than hashes: nothing outside a mounted panel ever sees it
 * (`toSessionMessage` does not persist it, and a reopened conversation is a new
 * set of objects with new ids, which is exactly right - the rows are new too).
 */
export function nextMessageId(): string {
  messageSeq += 1
  return `msg-${messageSeq}`
}

/** The panel's working copy of a turn: the shared chat type plus the markers
 * for an answer that was cut off mid-stream (see `interruptStream`), an image
 * the session store refused or evicted, and the token count the provider
 * reported. All of them are part of the session model, so they round-trip
 * through `toSessionMessage` - all but `id`, which belongs to this panel's copy
 * (see `nextMessageId`). */
export interface PanelMessage extends ChatMessage {
  /** This turn's identity while it is on screen. `nextMessageId` is the only
   *  thing that makes one, and it is made where the message is. */
  id: string
  interrupted?: boolean
  /** Short status about this message's images (refused by the size cap, or
   *  evicted by a storage budget). Shown under the bubble; without it the
   *  attachment simply disappears between one launch and the next. */
  imageNotice?: string
  /** Token total the provider reported for this answer (see AiTokenUsage).
   *  Shown under the bubble so the cost of a request is visible without a
   *  trip to the provider dashboard - and so an unexpectedly large one is
   *  noticed while it is still relevant. Omitted when the provider reported
   *  nothing, rather than shown as zero. */
  usageTotal?: number
}
