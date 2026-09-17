/**
 * What a message can carry beside its words: the rules, and the three intakes that produce it.
 *
 * A **refusal is a code, not a sentence** — the same rule `agent-context-snapshot.ts` states for
 * its own refusals, and for the same reason: a service that returned text would be inventing the
 * wording of two languages, and the surface that shows the refusal is the one that knows which
 * language the reader is in.
 *
 * **Everything here is in memory.** Nothing is written to the vault: a screenshot pasted into a
 * question is not a note, and an agent's message is not a place to leave files behind. That is the
 * whole difference from the editor's own paste (`features/attachments`), which stores what it
 * takes because the note it was pasted into has to keep pointing at it.
 *
 * **The limits are the editor's own**, imported rather than restated (`MAX_ATTACHMENT_BYTES`,
 * `MAX_ATTACHMENTS_PER_MESSAGE`, `MAX_ATTACHMENTS_PER_MESSAGE_BYTES`, `collectClipboardImages`,
 * `fileToBase64`). A second set of numbers for the same question — how big may one file be, how
 * many may ride along — is how two surfaces come to disagree about a limit the user experiences as
 * one. What this module adds is only what is true of a *prompt*: the two arms ACP defines, and the
 * fact that a text file has to be read before it can be embedded.
 */

import {
  ATTACHMENT_EXTENSIONS,
  collectClipboardImages,
  fileToBase64,
  formatAttachmentBytes,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENTS_PER_MESSAGE_BYTES,
  mimeFromExtension,
} from '../../attachments'
import type { AttachmentRejection } from '../../attachments'
import type {
  AgentCapabilityReport,
  AgentPromptAttachment,
} from '../../../platform/gateways/agent-contracts'

/**
 * What the engine's own report says about one kind of attachment — the three arms, not a boolean.
 *
 * `allowed` is the only arm a control is drawn in, and it is the only one that comes from the
 * engine saying so. `refused` is the engine's own answer of no, and `unreported` is the third
 * state a two-armed predicate cannot carry: nothing has been negotiated, so nothing has said either
 * way. The two are different facts and a surface that showed them alike would be telling a reader
 * their engine cannot do something nobody asked it.
 *
 * A missing row is `unreported` and not `refused`, for the same reason: a report this window cannot
 * find the feature in has not reported it absent — it has not reported it at all.
 */
export type AgentAttachmentStanding =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'refused'; readonly detail: string }
  | { readonly kind: 'unreported'; readonly detail: string }

/** What to say when the report has no row for the feature at all. Not a sentence about the engine,
 *  because the engine is not what is missing. */
const NO_ROW =
  'this engine’s report names no such feature, so nothing has said whether a prompt may carry one'

/** The two features an attachment is gated on, named as the report names them. */
export type AgentAttachmentFeature = 'image-attachments' | 'embedded-context'

/** Whether a `resource` attachment is what a given feature licenses, so the two call sites that
 *  have to agree about which arm needs which capability agree by reading this rather than by
 *  remembering. */
export function featureFor(attachment: AgentPromptAttachment): AgentAttachmentFeature {
  return attachment.kind === 'image' ? 'image-attachments' : 'embedded-context'
}

/**
 * Read one feature out of the engine's report.
 *
 * The report is what `AgentGateway.capabilities` answers, and this reads it rather than a boolean a
 * caller collapsed it into — the whole point of the three arms is that the surface can say *why*.
 */
export function attachmentStanding(
  reports: readonly AgentCapabilityReport[],
  feature: AgentAttachmentFeature,
): AgentAttachmentStanding {
  const row = reports.find((report) => report.feature === feature)
  if (row === undefined) return { kind: 'unreported', detail: NO_ROW }
  switch (row.finding.status) {
    case 'available':
      return { kind: 'allowed' }
    case 'unavailable':
      return { kind: 'refused', detail: row.finding.detail }
    case 'unverified':
      return { kind: 'unreported', detail: row.finding.detail }
  }
}

/**
 * Why something the reader offered is not in the message.
 *
 * One arm per reason, because each is a different thing to do about it: drop a file, save for
 * later, or give up on this one and send without it.
 */
export type AgentAttachmentRefusal =
  | { reason: 'too-many'; limit: number }
  | { reason: 'too-large'; name: string; limit: number }
  | { reason: 'no-room'; limit: number }
  | { reason: 'unreadable'; name: string }
  /**
   * An image of a format this build has no reader for (`.tiff`, `.tif`, `.ico`): a file the app's
   * own importer copies into a vault, because the vault's allowlist and this build's reader list
   * answer two different questions.
   *
   * Its own arm rather than `unreadable`, and that is the whole of why it exists. The bytes were
   * never in doubt — the file is in the reader's own folder and the host would serve it — and the
   * old route asked the *text* reader about an image, which refuses every one of them, so the
   * reader was told a file the app had imported itself "could not be read". A refusal that names a
   * reason is only worth having if the reason is the reason.
   */
  | { reason: 'unsupported-image'; name: string }
  /**
   * The shared intake's own gesture budgets refused it, before this module ever weighed it: more
   * files than one paste may bring, more bytes than one paste may weigh, or the session's running
   * total spent.
   *
   * One arm rather than one per cap, because the reader's next move is the same for all of them and
   * the sentence says the one true thing about all of them. Deliberately NOT `too-many`: that
   * arm's sentence names how many *this message* may hold, and borrowing it here would tell the
   * reader a wrong number about the wrong limit. `too-large` keeps its own arm because it is
   * exactly the same fact as this module's own per-file cap, with the same number.
   */
  | { reason: 'intake'; name: string }

/**
 * The types the app's own workspace is made of, for the files the shared image table above does not
 * know (`features/attachments`' `mimeFromExtension` covers images only — it exists for the
 * attachment library, and every image is what that feature stores).
 *
 * A table rather than a probe: the window has no MIME sniffer, and the browser's own guess is made
 * from the same extension (`File.type`) so it would be the same fact twice.
 */
const TEXT_MEDIA_TYPES: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  mdx: 'text/mdx',
  txt: 'text/plain',
  json: 'application/json',
  jsonc: 'application/json',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/toml',
  csv: 'text/csv',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  vue: 'text/vue',
  rs: 'text/rust',
  py: 'text/x-python',
  sh: 'text/x-shellscript',
}

/**
 * The media type of a file, from its extension and nothing else — or `null` when neither table
 * knows the extension.
 *
 * **`null` and not a type.** This used to fall back to `text/plain`, and for a `.tiff` that was a
 * *specific* type for a file nothing had established anything about: `.tiff` is an image format the
 * app's own importer copies into a vault, and an image block labelled `text/plain` is this window
 * telling the engine something about the reader's file that is not true. A fallback that names a
 * wrong type is worse than one that admits it does not know, so the absent answer is the answer and
 * each caller says what its own payload makes of it:
 *
 *  - a `resource` block is built from text the window has already read, so {@link resourceAttachment}
 *    supplies `text/plain`, which is a fact about the block rather than a guess about the file;
 *  - an image is a file the app's own intake has already called an image, and a format this build
 *    cannot name is refused with the format named rather than sent under an invented one.
 *
 * The tables are consulted in the only order that is meaningful: the image table first (it answers
 * `application/octet-stream` for "not an image", which is its own sentinel and not this function's),
 * then the text table.
 */
export function mediaTypeOf(path: string): string | null {
  const name = path.split(/[\\/]/).pop() ?? path
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/)
  if (match === null) return null
  const image = mimeFromExtension(match[1])
  if (image !== 'application/octet-stream') return image
  return TEXT_MEDIA_TYPES[match[1]] ?? null
}

/** The file suffix a media type implies, for naming something the clipboard gave no name for. */
function suffixFor(mediaType: string): string {
  const type = mediaType.split(';')[0].trim().toLowerCase()
  const slash = type.indexOf('/')
  const sub = slash === -1 ? '' : type.slice(slash + 1)
  return sub === 'jpeg' ? 'jpg' : sub.length > 0 ? sub : 'png'
}

/**
 * A file of the workspace, as the block that embeds it whole. The window read the text; the host
 * turns the path into the URI.
 *
 * **`text/plain` when the extension says nothing**, and only here: `text` is a string the window
 * read through the host's `read_to_string`, so the block's payload *is* text whatever the file is
 * called — a `Makefile`, a `.conf`, a file with no extension at all. That is a fact about the block
 * this function just built, which is why the fallback sits on the payload's side of the call rather
 * than inside the inference ({@link mediaTypeOf} answers `null` instead).
 */
export function resourceAttachment(path: string, text: string): AgentPromptAttachment {
  return { kind: 'resource', path, text, mediaType: mediaTypeOf(path) ?? 'text/plain' }
}

/** Image bytes, as the block that carries them. `data` is base64 with no `data:` prefix. */
export function imageAttachment(name: string, mediaType: string, data: string): AgentPromptAttachment {
  return { kind: 'image', name, mediaType, data }
}

/**
 * The key an attachment is addressed by, so offering the same thing twice replaces the row it
 * already has instead of adding a second copy of it.
 *
 * Keyed by kind and by the name a reader would recognise (`path` for a file, `name` for an image):
 * a file attached twice at two different contents is one attachment whose text is the newer
 * reading, and an image pasted twice under the same name is one image. This is
 * `agent-context-snapshot.ts`'s `itemId` rule, on the same facts.
 */
export function attachmentKey(attachment: AgentPromptAttachment): string {
  return attachment.kind === 'resource' ? `resource:${attachment.path}` : `image:${attachment.name}`
}

/** The attachments with `incoming` merged in: one row per key, the newcomer replacing the older,
 *  and the reader's order kept for everything the newcomer did not touch. */
export function mergeAttachments(
  held: readonly AgentPromptAttachment[],
  incoming: readonly AgentPromptAttachment[],
): AgentPromptAttachment[] {
  const merged = [...held]
  for (const attachment of incoming) {
    const key = attachmentKey(attachment)
    const at = merged.findIndex((existing) => attachmentKey(existing) === key)
    if (at === -1) merged.push(attachment)
    else merged[at] = attachment
  }
  return merged
}

/** What is already held, as far as a size budget is concerned: the bytes that will cross the IPC
 *  boundary. A resource's text and an image's base64 are both what actually travels. */
function weightOf(attachment: AgentPromptAttachment): number {
  return attachment.kind === 'resource' ? attachment.text.length : attachment.data.length
}

/**
 * Whether one more attachment fits, and why not when it does not.
 *
 * Counted against what is **already held**, not against this call: three separate pastes each
 * inside the per-message cap would otherwise put three times the cap in one turn, which is how the
 * editor's own intake describes the same trap.
 */
export function roomFor(
  held: readonly AgentPromptAttachment[],
  size: number,
  name: string,
): AgentAttachmentRefusal | null {
  if (held.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
    return { reason: 'too-many', limit: MAX_ATTACHMENTS_PER_MESSAGE }
  }
  if (size > MAX_ATTACHMENT_BYTES) {
    return { reason: 'too-large', name, limit: MAX_ATTACHMENT_BYTES }
  }
  const total = held.reduce((sum, attachment) => sum + weightOf(attachment), 0)
  if (total + size > MAX_ATTACHMENTS_PER_MESSAGE_BYTES) {
    return { reason: 'no-room', limit: MAX_ATTACHMENTS_PER_MESSAGE_BYTES }
  }
  return null
}

/**
 * The formats this build attaches, as the refusal sentence spells them.
 *
 * Derived from the allowlist rather than written out, so the sentence a reader is given and the
 * predicate that refused them cannot disagree: widening what this build reads moves the list the
 * reader is told to convert to on the same change.
 */
const ATTACHABLE_IMAGE_FORMATS = ATTACHMENT_EXTENSIONS.map((extension) =>
  extension.toUpperCase(),
).join(', ')

/** The sentence a refusal is shown as. Here rather than in a component because three intakes and
 *  one chip strip all report the same reasons, and a copy each is a chance to disagree. */
export function describeRefusal(refusal: AgentAttachmentRefusal): {
  key: 'tooMany' | 'tooLarge' | 'noRoom' | 'unreadable' | 'unsupportedImage' | 'intake'
  params: Record<string, string | number>
} {
  switch (refusal.reason) {
    case 'too-many':
      return { key: 'tooMany', params: { max: refusal.limit } }
    case 'too-large':
      return {
        key: 'tooLarge',
        params: { name: refusal.name, max: formatAttachmentBytes(refusal.limit) },
      }
    case 'no-room':
      return { key: 'noRoom', params: { max: formatAttachmentBytes(refusal.limit) } }
    case 'unreadable':
      return { key: 'unreadable', params: { name: refusal.name } }
    case 'unsupported-image':
      return {
        key: 'unsupportedImage',
        params: { name: refusal.name, formats: ATTACHABLE_IMAGE_FORMATS },
      }
    case 'intake':
      return { key: 'intake', params: { name: refusal.name } }
  }
}

/**
 * The shared intake's reason, as this module's own refusal.
 *
 * The translation lives here rather than in the intake because the two vocabularies answer
 * different questions — the intake says *which cap* was hit, this module says *what the reader
 * can do about it* — and it is this module that owns the sentence the reader reads.
 *
 * `too-large` maps to itself: it is the same fact at the same number. Every other reason the
 * unfiltered intake can produce (`too-many`, `session-full`, `batch-total`) is a budget on the
 * gesture rather than on the message, and they share the `intake` arm. The two reasons that need a
 * vault context (`vault-total`, `low-disk`) never reach here — `collectClipboardImages` passes no
 * context — and would each want an arm of their own if that ever changed.
 */
function refusalFromIntake(rejection: AttachmentRejection): AgentAttachmentRefusal {
  return rejection.reason === 'too-large'
    ? { reason: 'too-large', name: rejection.file.name, limit: MAX_ATTACHMENT_BYTES }
    : { reason: 'intake', name: rejection.file.name }
}

/**
 * The images a paste or a drop carried, encoded.
 *
 * `collectClipboardImages` is the editor's own filter — the clipboard's `items` first, its `files`
 * as the fallback, deduplicated — so a paste that carried a screenshot, a file from the file
 * manager and a line of text yields the screenshot alone, which is what a message can use.
 *
 * **Its refusals are translated, not ignored.** The intake applies the caps that belong to a
 * gesture (one file's size, how many a paste may bring, the session's running total) and hands
 * back what it dropped as values; this function turns each into the arm of this module's own
 * vocabulary that says the same thing, so an image the *shared* intake refused appears to the
 * reader as a row-less refusal with the file's name on it rather than as a toast this surface
 * never asked for. What {@link roomFor} adds on top is what a batch filter cannot know: how many
 * attachments this message already holds and how many bytes they already weigh.
 */
export async function imagesFromDataTransfer(
  data: DataTransfer | null,
  held: readonly AgentPromptAttachment[],
): Promise<{ accepted: AgentPromptAttachment[]; refused: AgentAttachmentRefusal[] }> {
  const accepted: AgentPromptAttachment[] = []
  const refused: AgentAttachmentRefusal[] = []
  const carried = collectClipboardImages(data)
  for (const rejection of carried.rejected) refused.push(refusalFromIntake(rejection))
  for (const file of carried.accepted) {
    // A pasted screenshot has no name of its own — the clipboard gives one only when a file
    // manager put a file there — so one is made up from its type. The row a reader sees has to
    // call it something, and "image.png" is what the platform itself would have called it.
    const name = file.name.length > 0 ? file.name : `pasted-image.${suffixFor(file.type)}`
    const room = roomFor([...held, ...accepted], file.size, name)
    if (room !== null) {
      refused.push(room)
      continue
    }
    // The browser's own answer first, this app's tables only when it has none. A format neither can
    // name is refused by name rather than sent under an invented one — the intake accepted this file
    // as an image (`isImageFile`), so its bytes are not in doubt; it is the *type* nobody knows, and
    // an image block whose `mimeType` this window made up would be a claim about the reader's file
    // that nothing supports. The budget above is asked first for the same reason the reader is
    // usually owed that answer: a file that did not fit is dropped whether or not its format is
    // known.
    const mediaType = file.type || mediaTypeOf(name)
    if (mediaType === null) {
      refused.push({ reason: 'unsupported-image', name })
      continue
    }
    try {
      accepted.push(imageAttachment(name, mediaType, await fileToBase64(file)))
    } catch {
      // `fileToBase64` refuses an oversize blob itself, and a rejected read means the bytes never
      // arrived. Either way the answer is a refusal naming the file rather than a broken prompt.
      refused.push({ reason: 'unreadable', name: file.name })
    }
  }
  return { accepted, refused }
}
