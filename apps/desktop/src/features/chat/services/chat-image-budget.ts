/**
 * The chat image budget: the caps that keep a data-URL-heavy conversation from
 * eating the storage quota, the notices that explain to the user what the caps
 * did to their images, and `applyImageCaps`, which enforces them.
 *
 * This is a policy with real numbers in it, and one with consequences: when it
 * bites it evicts images the user attached. It is therefore readable on its own,
 * with every cap beside the reason for its value - a number separated from its
 * rationale is the thing that gets "simplified" later.
 *
 * `applyImageCaps` lives here rather than with the store that calls it: the rule
 * and the limits it enforces have to be read together, and the limits are the
 * only reason the store imports this module at all.
 */

import type { ChatSession, ChatSessionImage, ChatSessionMessage } from './chat-session-model'

/**
 * Cap images saved per message so a data-URL heavy chat cannot blow the
 * localStorage quota on its own.
 *
 * Exported, and used by the chat composer as its own attachment limit: a panel
 * that let the user attach more than the session can keep would show an
 * attachment that disappears from the conversation the moment it is sent - the
 * store would trim it and the user would never know which one they lost.
 */
export const MAX_IMAGES_PER_MESSAGE = 4

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

/** Storage warning shown when the session history had to be written without
 * its images to fit the storage budget: the images are still in the open panel,
 * but a reload will not bring them back. */
export const STORAGE_WARNING_IMAGES = 'images-not-persisted'

/** Storage warning shown when nothing could be written at all - the history on
 * screen exists only in memory and will be gone after a reload. */
export const STORAGE_WARNING_FULL = 'history-not-persisted'

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

/** Set the eviction notice on a message that actually lost images. */
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
