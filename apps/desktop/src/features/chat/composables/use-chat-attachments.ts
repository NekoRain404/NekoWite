/**
 * The images the composer is holding for the question being written: what gets
 * attached, what gets refused, and the object URLs that have to be released
 * with them.
 *
 * The caps live here rather than on the send path, because this is where the
 * user can still act on them: a refusal at pick time leaves the draft intact
 * and names the limit, while the same refusal inside `send()` used to vanish -
 * the thumbnail stayed, nothing was sent, and no error explained why.
 *
 * The paste / drop / dragover handlers are here too, as functions the template
 * binds by name: whether a dragged thing is acceptable is attachment policy,
 * not markup (§10.2).
 */

import { ref, type Ref } from 'vue'
import { notifyError } from '../../../services/errors'
import {
  collectClipboardImages,
  formatAttachmentBytes,
  isImageFile,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENTS_PER_MESSAGE_BYTES,
} from '../../../services/attachments'
import { t } from '../../../i18n'
import { fileToDataURL, nextImageId, type ChatImage } from '../services/chat-logic'
import type { ChatAttachment } from '../types'

export interface ChatAttachmentsModel {
  /** The composer's pending images, in the order they were picked. */
  attachments: Ref<ChatAttachment[]>
  addFiles(files: File[]): void
  removeAttachment(id: string): void
  /** Release every object URL this module holds. Called on unmount. */
  clearAttachments(): void
  /** Release the object URLs of attachments held elsewhere (the drafts parked
   *  by `useChatSession`): the URLs are this module's to revoke, and a draft
   *  dropped by another module would otherwise pin its files forever. */
  releaseUrls(list: ChatAttachment[]): void
  onPaste(e: ClipboardEvent): void
  onDrop(e: DragEvent): void
  onDragOver(e: DragEvent): void
}

/** Encode the attached files into the `data:` URLs a request carries, in the
 *  order the user attached them. Rejects on an unreadable blob - the caller
 *  reports that and leaves the draft untouched. */
export async function encodeAttachments(list: ChatAttachment[]): Promise<ChatImage[]> {
  const images: ChatImage[] = []
  for (const a of list) {
    images.push({ id: a.id, name: a.name, dataUrl: await fileToDataURL(a.file) })
  }
  return images
}

export function useChatAttachments(): ChatAttachmentsModel {
  const attachments = ref<ChatAttachment[]>([])

  function addFiles(files: File[]): void {
    const seen = new Set(attachments.value.map((a) => `${a.name}:${a.file.size}:${a.file.type}`))
    // The running total for this message, not for this call: the size budget has
    // to hold across separate picks, which is how the count cap gets evaded.
    let totalBytes = attachments.value.reduce((sum, a) => sum + a.file.size, 0)
    for (const file of files) {
      if (!isImageFile(file)) continue
      if (attachments.value.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
        // Every attachment is base64-encoded into one request: past this cap the
        // send would spike memory on both processes and be refused by the model.
        notifyError(t('chat.tooManyImages', { max: MAX_ATTACHMENTS_PER_MESSAGE }))
        break
      }
      // Refuse an oversize image HERE, while the user can still act on it: the
      // send path (`fileToBase64`) enforces the same cap, and a rejection from
      // inside `send()` used to vanish — the draft and the thumbnail stayed,
      // nothing was sent, and no error explained why.
      if (file.size > MAX_ATTACHMENT_BYTES) {
        notifyError(t('chat.imageTooLarge', { max: formatAttachmentBytes(MAX_ATTACHMENT_BYTES) }))
        continue
      }
      // Refused per image, like the two caps above: the images that already fit
      // stay put and only this one is left out, so the user can drop one file
      // instead of starting the message over.
      if (totalBytes + file.size > MAX_ATTACHMENTS_PER_MESSAGE_BYTES) {
        notifyError(
          t('chat.attachmentsTotalTooLarge', {
            max: formatAttachmentBytes(MAX_ATTACHMENTS_PER_MESSAGE_BYTES),
          }),
        )
        continue
      }
      const key = `${file.name}:${file.size}:${file.type}`
      if (seen.has(key)) continue
      seen.add(key)
      totalBytes += file.size
      attachments.value.push({
        id: nextImageId(),
        name: file.name,
        file,
        url: URL.createObjectURL(file),
      })
    }
  }

  function removeAttachment(id: string): void {
    const index = attachments.value.findIndex((a) => a.id === id)
    if (index < 0) return
    const [removed] = attachments.value.splice(index, 1)
    if (removed) URL.revokeObjectURL(removed.url)
  }

  function clearAttachments(): void {
    for (const a of attachments.value) URL.revokeObjectURL(a.url)
    attachments.value = []
  }

  function releaseUrls(list: ChatAttachment[]): void {
    for (const a of list) URL.revokeObjectURL(a.url)
  }

  function onPaste(e: ClipboardEvent): void {
    const files = collectClipboardImages(e.clipboardData ?? null)
    if (files.length) addFiles(files)
  }

  function onDrop(e: DragEvent): void {
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length) {
      addFiles(files)
      e.preventDefault()
    }
  }

  function onDragOver(e: DragEvent): void {
    if (Array.from(e.dataTransfer?.items ?? []).some((i) => i.type.startsWith('image/'))) {
      e.preventDefault()
    }
  }

  return {
    attachments,
    addFiles,
    removeAttachment,
    clearAttachments,
    releaseUrls,
    onPaste,
    onDrop,
    onDragOver,
  }
}
