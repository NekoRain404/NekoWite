/**
 * SVG insertion: what may be previewed, and the note edit that may follow it.
 *
 * §7.3 is the specification, and each clause forbids a different way of pretending an insert
 * succeeded:
 *
 *  1. **Wait for the write** (「等待文件写入完成，不逐 token 渲染不完整 SVG」): the stat'ed size and the
 *     bytes read have to agree, and the document has to be well-formed, so a half-written file is
 *     refused rather than drawn.
 *  2. **A parser, not a pattern** (「使用成熟 sanitizer/解析器…不用正则假装消毒」): every check runs on the
 *     tree the platform's XML parser produced, behind an allowlist, and an element that is not on
 *     it is refused by name rather than deleted — a stripped SVG can differ from the one the agent
 *     drew in ways the user cannot see, which is the "completed differently" failure this codebase
 *     refuses everywhere else.
 *  3. **The preview is a verified artifact, never the raw text** (「安全预览不通过随意放宽 CSP 或直接 `v-html`
 *     执行原始内容实现；预览失败保留原文件并报错」): a branded value only {@link inspectStagedSvg} can
 *     mint, so a panel has one thing it may draw and no raw string to `v-html`.
 *  4. **After confirmation, the existing path** (「用户确认插入后走现有附件保存和 Markdown 链接能力，处理相对路径、
 *     空格与同名冲突」): the name, the location, the reference and the markdown block come from the
 *     attachments feature; what is added here is the same-name step, reported.
 *  5. **Bound to the document and the spot** (「插入绑定原文档 revision 和锚点；用户已经切换笔记或移动编辑位置时
 *     重新确认，不插到新活动文档」): the commit re-checks identity, path, revision and anchor against
 *     the editor's *current* account of that path — never "the active note" — and refuses instead of
 *     inserting somewhere else. {@link retargetSvgInsertion} is the re-confirmation.
 *  6. **Raw and preview stay apart** (「原始 SVG 与安全预览产物分开管理」): the plan names the staged file
 *     the caller copies and the verified preview, and writes neither. What lands in the vault is the
 *     agent's own artifact, which verification proved holds only allowlisted constructs.
 *
 * The shape is this feature's: plain frozen values, a discriminated result per operation instead of
 * exceptions, no clock and no store (the month directory's clock is passed in).
 */

import type { AgentIdentity } from '../../../platform/gateways/agent-contracts'
import {
  attachmentRelativePath,
  markdownImageBlock,
  relativePathFromNoteVault,
  sanitizeAttachmentFileName,
} from '../../attachments'
import type { AgentLiveNote } from './agent-context-snapshot'
import { identityMismatch, type AgentIdentityField } from './agent-session-view'

export const STAGED_SVG_MEDIA_TYPE = 'image/svg+xml'

/**
 * The bounds an artifact is held to. They are enforced rather than hoped for: the declared size is
 * checked before a byte is decoded, the text's own length again before it is encoded (a caller's
 * `sizeBytes` is a claim, not a proof), and the element and depth budgets are counted by the walk
 * that was going to visit every node anyway. 1 MiB is far above a diagram an agent draws — those run
 * 2–50 KiB — and far below the point where parsing an untrusted tree is a service nobody asked for.
 */
export const MAX_SVG_BYTES = 1024 * 1024
export const MAX_SVG_ELEMENTS = 10_000
export const MAX_SVG_DEPTH = 64

/** How much text either side of an anchor is kept as its fingerprint: enough that a caret cannot
 *  resolve elsewhere after an edit, little enough to stay a fingerprint. */
export const ANCHOR_CONTEXT_CHARS = 32

/** How many `-2`, `-3` … suffixes are tried before a name is called unavailable. */
export const MAX_ATTACHMENT_NAME_ATTEMPTS = 100

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink'
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'

/**
 * What a preview may hold, by local name. An allowlist is the point: what is not here is refused by
 * name, so this list is the answer to "what can this render" and a new element is a deliberate
 * addition rather than an inherited permission. Two families are absent on purpose:
 *
 *  - **animation** (`animate`, `set`, …) — the classic shape of an SVG attack is a
 *    `<set attributeName="href" to="javascript:…">` that passes every static check and retargets a
 *    link afterwards. Keeping it means modelling every attribute each element can later write.
 *  - **`<style>` and `style=`** — CSS reaches the network through `url()`, `@import` and escapes: a
 *    grammar to parse rather than a value to compare, and a half-parsed stylesheet is the "regex
 *    pretending to sanitise" §7.3 forbids. Presentation attributes are the supported way to paint.
 */
const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set(
  [
    'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'marker', 'image',
    'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textPath',
    'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask',
    'filter', 'feGaussianBlur', 'feOffset', 'feBlend', 'feColorMatrix', 'feComposite',
    'feFlood', 'feMerge', 'feMergeNode', 'feMorphology',
  ].map((name) => name.toLowerCase()),
)

/**
 * The staged artifact, as the caller read it. `sizeBytes` is the size the host stat'ed *before* the
 * read, and it is what makes the read checkable: the text has to be exactly that many UTF-8 bytes.
 * A still-growing file disagrees with its own stat, and that disagreement is the only honest way to
 * know a write has not finished — the tool call reporting success is a statement about the agent's
 * process, not about the disk.
 */
export interface AgentStagedSvg {
  /** The staged file: what a confirmed insert copies into the vault, byte for byte. */
  readonly path: string
  readonly mediaType: string
  readonly sizeBytes: number
  /** The file's text, read as UTF-8 after the stat above. */
  readonly text: string
}

declare const verifiedSvg: unique symbol

/**
 * An artifact that passed every check, with the preview those checks produced.
 *
 * The brand is load-bearing, like the committed context snapshot's: {@link inspectStagedSvg} is the
 * only producer, so a panel cannot render a string it built itself and call it a preview, and
 * {@link planSvgInsertion} cannot be handed one. `markup` is the platform serialiser's output for the
 * verified tree — never the raw text, never a string this module assembled by search and replace.
 */
export interface AgentSvgPreview {
  readonly [verifiedSvg]: never
  /** The staged file this preview was verified from: what a confirmed insert copies. */
  readonly stagedPath: string
  /** What a preview may render. The raw text is not this, and must never be rendered. */
  readonly markup: string
  readonly byteLength: number
  readonly elements: number
}

/** Why an artifact may not be previewed — a code, not a sentence. Each arm names the thing to fix
 *  rather than echoing the hostile value, which would only put an attacker's string in front of the
 *  user. */
export type AgentSvgRefusal =
  | { readonly reason: 'not-svg'; readonly mediaType: string }
  | { readonly reason: 'too-large'; readonly sizeBytes: number; readonly limit: number }
  | { readonly reason: 'incomplete-read'; readonly sizeBytes: number; readonly readBytes: number }
  | { readonly reason: 'unsafe-declaration'; readonly declaration: 'doctype' | 'entity' | 'processing-instruction' }
  | { readonly reason: 'malformed' }
  | { readonly reason: 'too-complex'; readonly elements: number; readonly limit: number }
  | { readonly reason: 'too-deep'; readonly depth: number; readonly limit: number }
  | { readonly reason: 'foreign-namespace'; readonly element: string; readonly namespace: string }
  | { readonly reason: 'unsafe-element'; readonly element: string }
  | { readonly reason: 'unsafe-attribute'; readonly element: string; readonly attribute: string }
  | { readonly reason: 'external-reference'; readonly element: string; readonly attribute: string }

export type AgentSvgInspection =
  | { readonly status: 'previewed'; readonly preview: AgentSvgPreview }
  | { readonly status: 'refused'; readonly refusal: AgentSvgRefusal }

/**
 * Where in a note the link goes, and what was there when the user pointed at it.
 *
 * Offsets alone are not an anchor: a caret has no text, so an edit before it moves it silently. The
 * three strings are the fingerprint — the replaced text and a little either side — and they are what
 * {@link commitSvgInsertion} compares against the note's current text.
 */
export interface AgentInsertionAnchor {
  readonly from: number
  readonly to: number
  readonly selected: string
  readonly before: string
  readonly after: string
}

/** One note and the spot in it, as the user pointed at them. The session identity travels with the
 *  document facts because §6.2 holds snapshots and indices to one composite boundary, and an insert
 *  planned under one session must not land under another — a restarted runtime looks the same. */
export interface AgentInsertionTarget {
  readonly identity: AgentIdentity
  readonly path: string
  readonly revision: string
  readonly anchor: AgentInsertionAnchor
}

/** Why a capture, a plan or a commit did not happen. */
export type AgentInsertionRefusal =
  | { readonly reason: 'note-not-open'; readonly path: string }
  | { readonly reason: 'vault-mismatch'; readonly path: string; readonly itemVaultId: string; readonly contextVaultId: string }
  | { readonly reason: 'anchor-out-of-range'; readonly path: string; readonly from: number; readonly to: number }
  | { readonly reason: 'identity-changed'; readonly field: AgentIdentityField }
  | { readonly reason: 'target-changed'; readonly path: string; readonly plannedPath: string }
  | { readonly reason: 'revision-changed'; readonly path: string; readonly plannedRevision: string; readonly currentRevision: string }
  | { readonly reason: 'anchor-moved'; readonly path: string }
  | { readonly reason: 'invalid-file-name'; readonly name: string }
  | { readonly reason: 'name-unavailable'; readonly name: string }
  | { readonly reason: 'attachment-not-saved'; readonly path: string }

export type AgentInsertionCapture =
  | { readonly status: 'captured'; readonly target: AgentInsertionTarget }
  | { readonly status: 'refused'; readonly refusal: AgentInsertionRefusal }

/** Where the file goes and what is already there. All three are the caller's to know: this module
 *  reads no clock, lists no directory and resolves no vault. */
export interface AgentInsertionDestination {
  /** The vault root, so an absolute note path (the editor's own spelling) can be rebased. */
  readonly vaultRoot: string
  /** The names already in the destination month directory, for the same-name case. */
  readonly takenNames: readonly string[]
  readonly now: Date
}

export interface AgentInsertionPlanRequest {
  readonly preview: AgentSvgPreview
  readonly target: AgentInsertionTarget
  /** The identity in force now: a target captured under another session is refused, not used. */
  readonly identity: AgentIdentity
  readonly destination: AgentInsertionDestination
  /** The name the user kept or typed for the vault file; sanitised and `.svg`-suffixed. */
  readonly fileName: string
  /** Alt text; the file's stem when absent. */
  readonly alt?: string
}

/**
 * Everything a confirmed insert consists of, decided before anything is written. Both artifacts are
 * named and neither is rewritten: `stagedPath` is the file the caller copies into the vault,
 * `preview` is the verified value the panel draws. `insert` is the exact text the note gains, so the
 * caller applies one edit rather than assembling markdown of its own.
 */
export interface AgentSvgInsertionPlan {
  readonly identity: AgentIdentity
  readonly path: string
  readonly revision: string
  readonly anchor: AgentInsertionAnchor
  readonly stagedPath: string
  readonly preview: AgentSvgPreview
  readonly fileName: string
  readonly vaultPath: string
  readonly markdownSrc: string
  readonly insert: string
  /** The name the artifact arrived with, when the vault's name had to differ from it. */
  readonly renamedFrom: string | null
  /** Kept although the reference is already computed, because placing this insertion again rebuilds
   *  that reference for another note's directory — and must not re-resolve the name. */
  readonly vaultRoot: string
  readonly alt: string
}

export type AgentInsertionPlanResult =
  | { readonly status: 'planned'; readonly plan: AgentSvgInsertionPlan }
  | { readonly status: 'refused'; readonly refusal: AgentInsertionRefusal }

/** What the caller has already written when it asks for the note edit. The order cannot be checked
 *  here — a note that links a file nothing wrote is the outcome this refuses. */
export interface AgentInsertionCommitRequest {
  /** The editor's account of *the planned path*, or null when no tab holds it. */
  readonly live: AgentLiveNote | null
  readonly identity: AgentIdentity
  readonly attachmentSaved: boolean
}

export type AgentInsertionChange = { readonly from: number; readonly to: number; readonly insert: string }

export type AgentInsertionOutcome =
  | { readonly status: 'inserted'; readonly path: string; readonly change: AgentInsertionChange; readonly markdownSrc: string }
  /** `attachmentSaved` is what the caller had already done: what "the note is untouched, the file is
   *  there" has to be told from "nothing happened at all". */
  | { readonly status: 'refused'; readonly refusal: AgentInsertionRefusal; readonly attachmentSaved: boolean }

/** UTF-8 bytes, which is what a file's size is. `text.length` counts code units, so a document with
 *  one non-ASCII character would disagree with its own stat. */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * The constructs no legitimate SVG here needs and no parser should be handed.
 *
 * A refusal, not a sanitisation, and fail-closed on purpose: a comment that merely mentions
 * `<!DOCTYPE` refuses a file that would have been fine, while a doctype that slipped past would let
 * the parser expand entities — a billion-laughs document is a denial of service the size bound cannot
 * see, because the file is small and the expansion is not.
 */
function declarationRefusal(text: string): AgentSvgRefusal | null {
  const upper = text.toUpperCase()
  if (upper.includes('<!DOCTYPE')) return { reason: 'unsafe-declaration', declaration: 'doctype' }
  if (upper.includes('<!ENTITY')) return { reason: 'unsafe-declaration', declaration: 'entity' }
  return null
}

/** A same-document reference, the only `href` a renderer is given here: `#id`, non-empty. */
function isFragmentReference(value: string): boolean {
  return value.startsWith('#') && value.length > 1
}

/** Every `url(…)` in a presentation attribute has to be a fragment: a paint server may point at a
 *  gradient in the same document and may not make the renderer fetch anything. A quoted target
 *  counts (`url('#g')` is valid CSS), so the check is on the target rather than the spelling, and a
 *  malformed value fails closed because what is left of it is not a fragment either. */
function hasExternalUrl(value: string): boolean {
  const lower = value.toLowerCase()
  let at = lower.indexOf('url(')
  while (at !== -1) {
    const close = value.indexOf(')', at)
    const raw = (close === -1 ? value.slice(at + 4) : value.slice(at + 4, close)).trim()
    const target = raw.startsWith("'") || raw.startsWith('"') ? raw.slice(1, -1).trim() : raw
    if (!isFragmentReference(target)) return true
    at = lower.indexOf('url(', close === -1 ? value.length : close)
  }
  return false
}

/** The attribute channels that are not inert data. With animation refused, everything else on an
 *  allowlisted element is geometry or paint: a name this module has never seen cannot execute. */
function judgeAttributes(element: string, node: Element): AgentSvgRefusal | null {
  const unsafe = (attribute: string): AgentSvgRefusal => ({ reason: 'unsafe-attribute', element, attribute })
  for (const attribute of Array.from(node.attributes)) {
    const name = attribute.name.toLowerCase()
    const local = (attribute.localName || attribute.name).toLowerCase()
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue

    const namespace = attribute.namespaceURI
    if (namespace === XLINK_NAMESPACE) {
      if (local !== 'href') return unsafe(attribute.name)
    } else if (namespace === XML_NAMESPACE) {
      if (local !== 'space') return unsafe(attribute.name)
    } else if (namespace !== null) {
      // A namespaced attribute this module does not know is a vocabulary something else can act on,
      // and the document declared the namespace that brings it.
      return unsafe(attribute.name)
    }
    if (name.startsWith('on') || name === 'style') return unsafe(attribute.name)
    if (local === 'href' && !isFragmentReference(attribute.value)) {
      return { reason: 'external-reference', element, attribute: attribute.name }
    }
    if (hasExternalUrl(attribute.value)) {
      return { reason: 'external-reference', element, attribute: attribute.name }
    }
  }
  return null
}

type TreeJudgement = { readonly refusal: AgentSvgRefusal } | { readonly elements: number }

/**
 * The walk: every node of the parsed tree, judged, with the budgets counted as it goes. It answers
 * with the element count when the tree is clean, which is why nothing measures the tree twice.
 *
 * Iterative rather than recursive because the input is the thing it bounds — a deep document must
 * meet the depth limit, not the JavaScript stack — and it stops at the first violation rather than
 * collecting them, because the first one is already a refusal and the caller needs one reason.
 */
function judgeTree(document: Document): TreeJudgement {
  const stack: { readonly node: Node; readonly depth: number }[] = [{ node: document, depth: 0 }]
  let elements = 0

  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { readonly node: Node; readonly depth: number }
    // `<?xml-stylesheet?>` makes a renderer fetch a stylesheet, and the DOM gives no portable way to
    // read a processing instruction's target once parsed, so PIs are refused as a class.
    if (node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
      return { refusal: { reason: 'unsafe-declaration', declaration: 'processing-instruction' } }
    }
    if (node.nodeType === Node.DOCUMENT_TYPE_NODE) {
      return { refusal: { reason: 'unsafe-declaration', declaration: 'doctype' } }
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element
      elements += 1
      if (elements > MAX_SVG_ELEMENTS) {
        return { refusal: { reason: 'too-complex', elements, limit: MAX_SVG_ELEMENTS } }
      }
      if (depth > MAX_SVG_DEPTH) return { refusal: { reason: 'too-deep', depth, limit: MAX_SVG_DEPTH } }

      const name = (element.localName || element.tagName).toLowerCase()
      // A parser that cannot parse returns its error as a node rather than as an exception, and that
      // node is an element like any other: it has to be looked for, or a malformed document reads as
      // a small tree of unknown elements.
      if (name === 'parsererror') return { refusal: { reason: 'malformed' } }
      const namespace = element.namespaceURI
      if (namespace !== SVG_NAMESPACE) {
        return { refusal: { reason: 'foreign-namespace', element: name, namespace: namespace ?? '' } }
      }
      if (!ALLOWED_ELEMENTS.has(name)) return { refusal: { reason: 'unsafe-element', element: name } }
      const attributes = judgeAttributes(name, element)
      if (attributes !== null) return { refusal: attributes }
    }

    // Children are pushed whatever the node was: the document node is not an element and its subtree
    // is the whole document, so a walk descending only through elements would visit the root and stop
    // — and every check below the root would never run.
    for (const child of Array.from(node.childNodes)) stack.push({ node: child, depth: depth + 1 })
  }
  return { elements }
}

/**
 * Look at a staged artifact, and answer either with a preview or with the reason there is none.
 *
 * The order is the order of the questions: is this the kind of file we accept, is it within the
 * bound, is the read complete, is the content something a parser may be handed, does it parse, and
 * does every node pass. Nothing before the parse reads the content, so the checks that are about the
 * *read* cannot be reached by anything the content says.
 */
export function inspectStagedSvg(staged: AgentStagedSvg): AgentSvgInspection {
  const refused = (refusal: AgentSvgRefusal): AgentSvgInspection => ({ status: 'refused', refusal })
  const mediaType = staged.mediaType.split(';')[0].trim().toLowerCase()
  if (mediaType !== STAGED_SVG_MEDIA_TYPE) return refused({ reason: 'not-svg', mediaType })
  if (staged.sizeBytes > MAX_SVG_BYTES) {
    return refused({ reason: 'too-large', sizeBytes: staged.sizeBytes, limit: MAX_SVG_BYTES })
  }
  // Before the encode below, which is the first step whose cost the caller's number controls. Code
  // units are a lower bound on bytes, so this refuses only what is certainly over the bound.
  if (staged.text.length > MAX_SVG_BYTES) {
    return refused({ reason: 'too-large', sizeBytes: staged.text.length, limit: MAX_SVG_BYTES })
  }
  const byteLength = utf8Length(staged.text)
  if (byteLength !== staged.sizeBytes) {
    return refused({ reason: 'incomplete-read', sizeBytes: staged.sizeBytes, readBytes: byteLength })
  }
  const declaration = declarationRefusal(staged.text)
  if (declaration !== null) return refused(declaration)

  let document: Document
  try {
    document = new DOMParser().parseFromString(staged.text, 'image/svg+xml')
  } catch {
    // A parser may throw on input it refuses. A refusal here is the honest answer rather than an
    // exception escaping the service whose whole job is to say what it will not draw.
    return refused({ reason: 'malformed' })
  }

  const root = document.documentElement
  if (root === null || (root.localName || root.tagName).toLowerCase() !== 'svg') {
    return refused({ reason: 'malformed' })
  }
  const judged = judgeTree(document)
  if ('refusal' in judged) return refused(judged.refusal)

  const preview = Object.freeze({
    stagedPath: staged.path,
    markup: new XMLSerializer().serializeToString(document),
    byteLength,
    elements: judged.elements,
  })
  return { status: 'previewed', preview: preview as unknown as AgentSvgPreview }
}

/**
 * The anchor for a range of a note's text, or null when the range is not in that text.
 *
 * Null rather than a refusal because this is arithmetic: a caller whose offsets do not fit the text
 * it handed over has a bug or a race, and there is no insertion to describe.
 */
export function captureInsertionAnchor(text: string, from: number, to: number): AgentInsertionAnchor | null {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null
  if (from < 0 || to < from || to > text.length) return null
  return Object.freeze({
    from,
    to,
    selected: text.slice(from, to),
    before: text.slice(Math.max(0, from - ANCHOR_CONTEXT_CHARS), from),
    after: text.slice(to, to + ANCHOR_CONTEXT_CHARS),
  })
}

/** Whether the anchor still describes the same spot: the range is there and the text under and around
 *  it is what was recorded. Both halves matter — the offsets catch an edit before the anchor, the
 *  fingerprint catches one *at* it, which leaves the offsets identical. */
function anchorHolds(text: string, anchor: AgentInsertionAnchor): boolean {
  if (anchor.from < anchor.before.length || anchor.to < anchor.from) return false
  if (anchor.to + anchor.after.length > text.length) return false
  if (text.slice(anchor.from, anchor.to) !== anchor.selected) return false
  if (text.slice(anchor.from - anchor.before.length, anchor.from) !== anchor.before) return false
  return text.slice(anchor.to, anchor.to + anchor.after.length) === anchor.after
}

/** The five identity fields, copied into a plain frozen object. Nothing else rides along — an
 *  `AgentSession` also carries behaviour, and none of it belongs in a value read back later. */
function copyIdentity(identity: AgentIdentity): AgentIdentity {
  return Object.freeze({
    agentId: identity.agentId,
    profileId: identity.profileId,
    runtimeEpoch: identity.runtimeEpoch,
    vaultId: identity.vaultId,
    sessionId: identity.sessionId,
  })
}

/**
 * Capture the note the user is pointing at, or why not.
 *
 * The caller has already looked the note up, so the only answers are the target and the two facts
 * that make an insertion into it wrong: it belongs to another vault, or the editor's range does not
 * describe a spot in the text it handed over. The vault check is §6.2's composite boundary, refused
 * where the user points the way the context snapshot refuses a foreign item, rather than carried to a
 * commit that would notice it late.
 */
export function captureInsertionTarget(
  live: AgentLiveNote,
  identity: AgentIdentity,
  range: { readonly from: number; readonly to: number },
): AgentInsertionCapture {
  if (live.vaultId !== identity.vaultId) {
    const refusal: AgentInsertionRefusal = {
      reason: 'vault-mismatch',
      path: live.path,
      itemVaultId: live.vaultId,
      contextVaultId: identity.vaultId,
    }
    return { status: 'refused', refusal }
  }
  const anchor = captureInsertionAnchor(live.buffer.text, range.from, range.to)
  if (anchor === null) {
    const refusal: AgentInsertionRefusal = {
      reason: 'anchor-out-of-range',
      path: live.path,
      from: range.from,
      to: range.to,
    }
    return { status: 'refused', refusal }
  }
  const target: AgentInsertionTarget = Object.freeze({
    identity: copyIdentity(identity),
    path: live.path,
    revision: live.revision,
    anchor,
  })
  return { status: 'captured', target }
}

type ResolvedName = { readonly fileName: string; readonly renamedFrom: string | null }

/**
 * The vault name: sanitised by the attachments feature's own rule, given `.svg`, and made unique
 * against what the destination already holds.
 *
 * The comparison is case-insensitive even though the vault is Linux-only: two names differing in
 * case are two files that read as one to the user, and a vault that reaches another machine is a
 * vault that will disagree about them.
 */
function resolveAssetName(offered: string, takenNames: readonly string[]): ResolvedName | AgentInsertionRefusal {
  if (!/[\p{Letter}\p{Number}]/u.test(offered)) return { reason: 'invalid-file-name', name: offered }
  const stem = sanitizeAttachmentFileName(offered.replace(/\.svg$/i, ''))
  const taken = new Set(takenNames.map((name) => name.toLowerCase()))
  for (let attempt = 1; attempt <= MAX_ATTACHMENT_NAME_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? `${stem}.svg` : `${stem}-${attempt}.svg`
    if (!taken.has(candidate.toLowerCase())) {
      return { fileName: candidate, renamedFrom: candidate === offered ? null : offered }
    }
  }
  return { reason: 'name-unavailable', name: offered }
}

/**
 * Decide the whole insertion: the vault name, the reference and the exact text the note gains.
 *
 * Everything here is a decision and nothing here is a write. The caller saves the attachment the plan
 * names and then asks {@link commitSvgInsertion} for the note edit; the plan can be retargeted in
 * between, which is what makes §7.3's re-confirmation a cheap answer instead of a second copy of the
 * picture.
 */
export function planSvgInsertion(request: AgentInsertionPlanRequest): AgentInsertionPlanResult {
  const { target, destination } = request
  const mismatch = identityMismatch(target.identity, request.identity)
  if (mismatch !== null) return { status: 'refused', refusal: { reason: 'identity-changed', field: mismatch } }

  const resolved = resolveAssetName(request.fileName, destination.takenNames)
  if ('reason' in resolved) return { status: 'refused', refusal: resolved }

  const vaultPath = attachmentRelativePath(resolved.fileName, destination.now)
  const markdownSrc = relativePathFromNoteVault(target.path, destination.vaultRoot, vaultPath)
  const alt = request.alt ?? resolved.fileName.replace(/\.svg$/i, '')
  const plan: AgentSvgInsertionPlan = Object.freeze({
    identity: copyIdentity(target.identity),
    path: target.path,
    revision: target.revision,
    anchor: target.anchor,
    stagedPath: request.preview.stagedPath,
    preview: request.preview,
    fileName: resolved.fileName,
    vaultPath,
    markdownSrc,
    insert: markdownImageBlock(alt, markdownSrc),
    renamedFrom: resolved.renamedFrom,
    vaultRoot: destination.vaultRoot,
    alt,
  })
  return { status: 'planned', plan }
}

/**
 * The same insertion, placed again where the user says.
 *
 * The attachment half of the plan is kept exactly: the file may already be on disk under the name the
 * plan chose, so re-resolving it would write a `-2` copy of one picture. Only the target and the
 * reference move — the markdown src is measured from the note's own directory, so re-confirming in
 * another note gets a reference that resolves from there.
 */
export function retargetSvgInsertion(plan: AgentSvgInsertionPlan, target: AgentInsertionTarget): AgentSvgInsertionPlan {
  const markdownSrc = relativePathFromNoteVault(target.path, plan.vaultRoot, plan.vaultPath)
  return Object.freeze({
    ...plan,
    identity: copyIdentity(target.identity),
    path: target.path,
    revision: target.revision,
    anchor: target.anchor,
    markdownSrc,
    insert: markdownImageBlock(plan.alt, markdownSrc),
  })
}

/**
 * The note edit, or why there is not one.
 *
 * Every check that made the plan is taken again here, against the editor's account of *this path* at
 * this instant: the target may be a different note (the user switched), the same note at another
 * revision (it was edited, or an external write landed), or the same text with the spot gone (the
 * text under it changed while the offsets did not). Each refuses rather than inserting somewhere
 * plausible, because "it went in near where you meant" is not an outcome the user can tell from the
 * one they asked for.
 *
 * `attachmentSaved` is the caller's report of what it has already done, and it is required rather
 * than assumed: the note must not link a file nothing wrote. A refusal carries it back, so the caller
 * can say whether anything reached the disk.
 */
export function commitSvgInsertion(
  plan: AgentSvgInsertionPlan,
  request: AgentInsertionCommitRequest,
): AgentInsertionOutcome {
  const refuse = (refusal: AgentInsertionRefusal): AgentInsertionOutcome => ({
    status: 'refused',
    refusal,
    attachmentSaved: request.attachmentSaved,
  })

  const mismatch = identityMismatch(plan.identity, request.identity)
  if (mismatch !== null) return refuse({ reason: 'identity-changed', field: mismatch })
  const live = request.live
  if (live === null) return refuse({ reason: 'note-not-open', path: plan.path })
  if (live.path !== plan.path) return refuse({ reason: 'target-changed', path: live.path, plannedPath: plan.path })
  if (live.vaultId !== plan.identity.vaultId) {
    return refuse({
      reason: 'vault-mismatch',
      path: plan.path,
      itemVaultId: live.vaultId,
      contextVaultId: plan.identity.vaultId,
    })
  }
  if (live.revision !== plan.revision) {
    return refuse({
      reason: 'revision-changed',
      path: plan.path,
      plannedRevision: plan.revision,
      currentRevision: live.revision,
    })
  }
  if (!anchorHolds(live.buffer.text, plan.anchor)) return refuse({ reason: 'anchor-moved', path: plan.path })
  if (!request.attachmentSaved) return refuse({ reason: 'attachment-not-saved', path: plan.vaultPath })

  return {
    status: 'inserted',
    path: plan.path,
    change: { from: plan.anchor.from, to: plan.anchor.to, insert: plan.insert },
    markdownSrc: plan.markdownSrc,
  }
}
