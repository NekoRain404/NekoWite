/**
 * The attachments a message is holding: what a paste, a drop and a picked file do to them, and
 * what the reader is told when one is refused.
 *
 * A composable rather than state on `AgentComposer.vue`, for the reason `use-agent-commands.ts` is
 * one: the rules are testable without mounting a textarea, and the component is left with the
 * parts only an element can do — where the caret is, which clipboard event arrived, whether a drag
 * is over it.
 *
 * **The gate is read here and nowhere else.** One control is offered per attachment kind and it is
 * offered only where the engine's own report says `available`; a `refused` or `unreported` report
 * draws no control at all, and the chip strip's own sentence says which of the two it is. The host
 * reads the same report at send time and refuses a block it does not license, so a report that went
 * stale between the two is a refusal rather than a protocol violation.
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type {
  AgentCapabilityReport,
  AgentPromptAttachment,
} from '../../../platform/gateways/agent-contracts'
import { promptAttachmentLabel } from '../../../platform/gateways/agent-contracts'
import { notifyError } from '../../../services/errors'
import { t } from '../../../i18n'
import { fsService } from '../../../platform/gateways/fs'
import { collectClipboardImages, isImagePath, readVaultImageBase64 } from '../../attachments'
import { baseName } from '../../../services/paths'
import {
  attachmentKey,
  attachmentStanding,
  imageAttachment,
  imagesFromDataTransfer,
  mediaTypeOf,
  mergeAttachments,
  resourceAttachment,
  roomFor,
  describeRefusal,
  type AgentAttachmentRefusal,
  type AgentAttachmentStanding,
} from '../services/agent-composer-attachments'

export interface UseAgentComposerAttachmentsOptions {
  /**
   * The engine's own report for this session, or null while it has not arrived.
   *
   * `null` is not an empty report: nothing has answered yet, so every standing is `unreported` and
   * no control is drawn. A window that drew them anyway would be offering something nobody has
   * said the engine reads.
   */
  capabilities: () => readonly AgentCapabilityReport[] | null
  /** The workspace the reader is in, for the file's text. `null` before a session is on screen. */
  vault: () => string | null
}

/**
 * What became of a file the reader picked.
 *
 * Three outcomes and not two, because the third is the one the *caller* still has to act on: the
 * composable owns the message's contents, and it does not own the composer's text, so "this file
 * travels as its path in the message instead" is a decision only the field can carry out. Keeping
 * it here is what stops the component from having to know which capability licenses which kind of
 * file — the question the whole of `attachFile` exists to answer in one place.
 */
export type AgentPickOutcome =
  /** It is in the message, as the block its kind and the engine's report agree on. */
  | 'attached'
  /** The engine's report does not license that block, so the file's *path* goes into the message
   *  instead. Silent: the reader can see the path arrive, and this is what the `+`'s rows have
   *  always done for a file the engine will not take whole. */
  | 'path-in-message'
  /** Nothing was added and the reader has been told why, named after the file. */
  | 'refused'

/** What a refusal is shown as: the catalogue's sentence, in the reader's language. */
function reportRefusal(refusal: AgentAttachmentRefusal): void {
  const { key, params } = describeRefusal(refusal)
  notifyError(t(`agent.panel.composer.attach.${key}`, params))
}

export interface AgentComposerAttachments {
  /** What the turn will carry, in the order the reader attached them. */
  held: Ref<AgentPromptAttachment[]>
  /** Whether there is anything to draw. The strip is drawn on this and nothing else, so an empty
   *  message has no frame pretending to hold something. */
  hasAny: ComputedRef<boolean>
  /** What the engine's report says about images, and about embedded files. */
  imageStanding: ComputedRef<AgentAttachmentStanding>
  resourceStanding: ComputedRef<AgentAttachmentStanding>
  /** The two counts the strip's own sentence uses. */
  addFromTransfer(data: DataTransfer | null): Promise<void>
  /** Attach a file of the workspace. Which of the two blocks it becomes is decided by the file —
   *  an image is read as bytes, anything else as text — and either way it is refused with the
   *  file's own name when the workspace will not hand it over. */
  attachFile(path: string): Promise<AgentPickOutcome>
  remove(key: string): void
  clear(): void
}

export function useAgentComposerAttachments(
  options: UseAgentComposerAttachmentsOptions,
): AgentComposerAttachments {
  const held = ref<AgentPromptAttachment[]>([])

  const imageStanding = computed(() =>
    attachmentStanding(options.capabilities() ?? [], 'image-attachments'),
  )
  const resourceStanding = computed(() =>
    attachmentStanding(options.capabilities() ?? [], 'embedded-context'),
  )

  /** What the engine's report says about one kind of attachment. Taken by kind rather than by
   *  value, so the read a decision is made on cannot be a different attachment's. */
  function standingFor(kind: AgentPromptAttachment['kind']): AgentAttachmentStanding {
    return kind === 'image' ? imageStanding.value : resourceStanding.value
  }

  /**
   * Add what an intake produced, refusing anything the engine's report does not license.
   *
   * The gate is applied here rather than at the intake, because the report is a fact about the
   * engine and an intake is a fact about the clipboard: a screenshot is a screenshot whether or
   * not this engine reads one. What the reader is told is the engine's own detail sentence, so the
   * refusal says what the engine said rather than what this window concluded.
   */
  function accept(incoming: readonly AgentPromptAttachment[]): void {
    const allowed: AgentPromptAttachment[] = []
    for (const attachment of incoming) {
      const standing = standingFor(attachment.kind)
      if (standing.kind === 'allowed') {
        allowed.push(attachment)
        continue
      }
      // The label, then the engine's own words: what was left out, and why. Reported rather than
      // dropped silently — an attachment that vanished between the gesture and the chip would be
      // the reader believing the model was shown something it never saw.
      const sentence =
        standing.kind === 'refused'
          ? t('agent.panel.composer.attach.refused', {
              name: promptAttachmentLabel(attachment),
              detail: standing.detail,
            })
          : t('agent.panel.composer.attach.unreported', {
              name: promptAttachmentLabel(attachment),
              detail: standing.detail,
            })
      notifyError(sentence)
    }
    if (allowed.length === 0) return
    held.value = mergeAttachments(held.value, allowed)
  }

  async function addFromTransfer(data: DataTransfer | null): Promise<void> {
    // The gate is read **before** the bytes are, and that ordering is the whole of this branch: an
    // engine that does not read images must not make this window base64-encode one to find out,
    // and the reader must still be told. Reporting is what `accept` would have done with the same
    // attachments had the encode happened; what is skipped is the encode.
    const standing = imageStanding.value
    if (standing.kind !== 'allowed') {
      const carried = collectClipboardImages(data).accepted
      if (carried.length === 0) return
      for (const file of carried) {
        notifyError(
          t(
            standing.kind === 'refused'
              ? 'agent.panel.composer.attach.refused'
              : 'agent.panel.composer.attach.unreported',
            { name: file.name.length > 0 ? file.name : 'pasted-image', detail: standing.detail },
          ),
        )
      }
      return
    }
    const { accepted, refused } = await imagesFromDataTransfer(data, held.value)
    for (const refusal of refused) reportRefusal(refusal)
    accept(accepted)
  }

  /**
   * A file of the workspace, and the one question that decides everything else: **is it an image?**
   *
   * The window has two readers and neither can answer for the other's files. A note is read as a
   * *string* (`fsService.read`, the host's `read_to_string`), which is what a `resource` block is
   * built from and what refuses every image, because an image is not valid UTF-8. An image is read
   * as *bytes* through the media channel (`readVaultImageBase64`), which is the host granting the
   * `asset://` protocol exactly that file and the window fetching it — the same read the editor
   * displays an attachment through and the export inlines one with.
   *
   * So the decision is taken from the path, by the app's own attachment predicate, and taken
   * **before either read**: the gate that licenses the block is per attachment *kind*, and which
   * gate applies is only knowable once the kind is. This is the module's stated ordering — the
   * engine's answer before the bytes — one step earlier, and it is what keeps an engine that reads
   * no images from making this window encode one to find out.
   *
   * The third kind of file is refused honestly: a `.pdf`, an archive, anything that is neither an
   * image nor text fails the text read and is named as unreadable. That is not an oversight — the
   * media channel serves only files on the app's own image allowlist, deliberately (see
   * `readVaultImageBase64`), so there is no reader here for a binary and none is invented.
   */
  async function attachFile(path: string): Promise<AgentPickOutcome> {
    const vault = options.vault()
    if (vault === null) return 'refused'
    return isImagePath(path) ? await attachImage(vault, path) : await attachText(vault, path)
  }

  async function attachImage(vault: string, path: string): Promise<AgentPickOutcome> {
    // The engine's answer first, and the read after it: a file this engine cannot be sent has no
    // reason to be read at all, and reading it would put its contents in memory for nothing.
    if (standingFor('image').kind !== 'allowed') return 'path-in-message'
    // The size is asked for before the bytes are, so an image the message cannot take is refused
    // as too large rather than fetched, encoded and then thrown away. It is the file's raw byte
    // size, the same quantity the paste path hands `roomFor` as `File.size`.
    let size: number
    try {
      size = (await fsService.stat(vault, path)).size
    } catch {
      reportRefusal({ reason: 'unreadable', name: path })
      return 'refused'
    }
    const room = roomFor(held.value, size, path)
    if (room !== null) {
      reportRefusal(room)
      return 'refused'
    }
    let data: string
    try {
      data = await readVaultImageBase64(fsService, vault, path)
    } catch {
      // The media channel refused it — a path outside the vault, a file the host will not serve,
      // or bytes past the shared cap. Either way there is nothing to send.
      reportRefusal({ reason: 'unreadable', name: path })
      return 'refused'
    }
    // The media type comes from the extension and not from the response, so the `mimeType` the
    // engine receives is this app's own answer about a file it just read, rather than whatever
    // the protocol guessed when it served it.
    accept([imageAttachment(baseName(path) || path, mediaTypeOf(path), data)])
    return 'attached'
  }

  async function attachText(vault: string, path: string): Promise<AgentPickOutcome> {
    if (standingFor('resource').kind !== 'allowed') return 'path-in-message'
    let text: string
    try {
      text = await fsService.read(vault, path)
    } catch {
      // A file the workspace cannot serve as text — a binary, a file that is gone. The read is
      // where it is found out, and the refusal names the file rather than reporting the reader's
      // own choice as a backend fault.
      reportRefusal({ reason: 'unreadable', name: path })
      return 'refused'
    }
    // Measured against the text that will actually travel, not against a `File` this path never
    // had: the block's payload is the bytes of `text`.
    const room = roomFor(held.value, new TextEncoder().encode(text).length, path)
    if (room !== null) {
      reportRefusal(room)
      return 'refused'
    }
    accept([resourceAttachment(path, text)])
    return 'attached'
  }

  function remove(key: string): void {
    held.value = held.value.filter((attachment) => attachmentKey(attachment) !== key)
  }

  function clear(): void {
    held.value = []
  }

  return {
    held,
    hasAny: computed(() => held.value.length > 0),
    imageStanding,
    resourceStanding,
    addFromTransfer,
    attachFile,
    remove,
    clear,
  }
}
