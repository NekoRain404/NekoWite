/**
 * The types the chat panel and its composables share.
 *
 * `ChatMessage` / `ChatImage` - the shape a prompt is built from - stay in
 * `services/chatLogic.ts`, which is where the pure prompt code lives. What is
 * here is what a *panel instance* adds on top of them.
 */

import type { ChatMessage } from './services/chatLogic'

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

/** The panel's working copy of a turn: the shared chat type plus the markers
 * for an answer that was cut off mid-stream (see `interruptStream`), an image
 * the session store refused or evicted, and the token count the provider
 * reported. All of them are part of the session model, so they round-trip
 * through `toSessionMessage`. */
export interface PanelMessage extends ChatMessage {
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
